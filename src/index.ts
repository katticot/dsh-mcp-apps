import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ApprovalService, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { Config } from './config'
import { AppSessionStore } from './session-store'
import { ServerToolManager, type ToolsService } from './tool-manager'
import { ServerPool } from './transports/server-pool'

export const name = 'mcp-apps'
export const inject = ['tools', 'connection', 'webServer']
export { Config }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui-tools/changed': () => void
  }
  interface Context {
    tools: ToolsService
    connection: {
      register?: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      /** Not part of the upstream connection service's published type; some hosts expose it as a runtime convenience for pushing an event to all connected clients. */
      broadcast?: (event: string, payload?: unknown) => void
      rpc: {
        handle: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      }
    }
  }
}

export function apply(ctx: Context, config: Config) {
  const sessionStore = new AppSessionStore()
  const notifyUiToolsChanged = () => {
    try {
      ctx.emit('ui-tools/changed')
    } catch {
      // Ignored
    }
    try {
      ctx.connection.broadcast?.('ui-tools/changed')
    } catch {
      // Ignored
    }
  }
  const toolManager = new ServerToolManager(ctx.tools, sessionStore, notifyUiToolsChanged, config.defaultTimeoutMs)
  const pool = new ServerPool(ctx, config, toolManager)

  // Single coordinated effect: manages RPC routing, server lifecycle, and in-flight draining
  ctx.effect(() => {
    let isDraining = false
    const inFlight = new Set<Promise<unknown>>()

    type SessionResult =
      | { session: import('./session-store').AppSession }
      | { error: { ok: false; error: { code: string; message: string } } }

    const requireSession = (params: Record<string, unknown>): SessionResult => {
      const sessionToken = typeof params.sessionToken === 'string' ? params.sessionToken : undefined
      if (!sessionToken) {
        return { error: { ok: false, error: { code: 'unauthorized', message: 'Missing session token' } } }
      }
      const session = sessionStore.get(sessionToken)
      if (!session) {
        return { error: { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired session token' } } }
      }
      if (params.server && typeof params.server === 'string' && params.server !== session.serverName) {
        return { error: { ok: false, error: { code: 'forbidden', message: 'Resource belongs to a different server' } } }
      }
      return { session }
    }

    const connectionProto = Object.getPrototypeOf(ctx.connection)
    const registerFn = typeof ctx.connection?.register === 'function'
      ? ctx.connection.register.bind(ctx.connection)
      : typeof connectionProto?.register === 'function'
      ? connectionProto.register.bind(ctx.connection)
      : ctx.connection.rpc.handle.bind(ctx.connection.rpc)

    const unregisterRpc = registerFn(ctx, '/mcp-apps', async (endpoint: string, payload: unknown, signal?: AbortSignal) => {
      if (isDraining) {
        return { ok: false, error: { code: 'unavailable', message: 'Host plugin is unloading' } }
      }

      const params = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>

      const task = (async () => {
        try {
          switch (endpoint) {
            case 'tools/list-ui': {
              await pool.waitForInitialSync()
              return { ok: true, value: pool.getUiToolsSnapshot() }
            }

            case 'resources/list': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const resources = await pool.listResources(session.session.serverName)
              return { ok: true, value: resources }
            }

            case 'resources/read': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              const resource = await pool.readResource(session.session.serverName, uri, signal)
              return { ok: true, value: resource }
            }

            case 'resources/read-raw': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              if (!uri) {
                return { ok: false, error: { code: 'bad-request', message: 'Missing uri parameter' } }
              }
              const raw = await pool.readResourceRaw(session.session.serverName, uri, signal)
              return { ok: true, value: raw }
            }

            case 'tools/call': {
              const sessionToken = typeof params.sessionToken === 'string' ? params.sessionToken : undefined
              if (!sessionToken) {
                return { ok: false, error: { code: 'unauthorized', message: 'Missing session token' } }
              }

              const session = sessionStore.get(sessionToken)
              if (!session) {
                return { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired session token' } }
              }

              if (params.server && typeof params.server === 'string' && params.server !== session.serverName) {
                return { ok: false, error: { code: 'forbidden', message: 'Tool belongs to a different server' } }
              }

              const toolName = typeof params.name === 'string' ? params.name : ''
              if (!session.allowedReverseTools.has(toolName)) {
                return { ok: false, error: { code: 'forbidden', message: `Tool "${toolName}" is not permitted for this session` } }
              }

              const serverConfig = config.servers[session.serverName]
              if (serverConfig?.allowAppToolCalls === 'approve') {
                // `approval`/`agents` aren't in this plugin's `inject` list (they're
                // optional services), so direct property access on `ctx` may not see
                // them if their providing fiber isn't active in this scope. `ctx.get`
                // (typed by cordis's own `ReflectService` augmentation — see
                // node_modules/@deepseek-ai/cordis lib/types/reflect.d.ts) performs the
                // same non-strict service lookup without requiring an `inject` entry.
                // The `typeof` guard (not a cast — `ctx.get` is fully typed) keeps this
                // working against minimal host/test `Context` stand-ins that don't
                // implement the full cordis reflection surface.
                const approvalService = ctx.approval ?? (typeof ctx.get === 'function' ? ctx.get('approval') : undefined)
                const agentsService = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
                const agent = session.agentId && agentsService ? agentsService.get(session.agentId) : undefined

                if (!approvalService || !agent) {
                  return { ok: false, error: { code: 'unavailable', message: 'Approval service or agent not available for tool call approval' } }
                }

                if (agent.status !== 'running') {
                  return { ok: false, error: { code: 'unavailable', message: `Cannot request approval while agent "${agent.id}" is idle` } }
                }

                try {
                  const outcome: ApprovalOutcome = await approvalService.request({
                    agent,
                    toolName,
                    callId: session.callId,
                    reason: `MCP App requested execution of tool "${toolName}"`,
                    signal,
                  })
                  if (outcome !== 'allowed-once') {
                    if (outcome === 'unavailable') {
                      return { ok: false, error: { code: 'unavailable', message: `Approval service is unavailable for tool "${toolName}"` } }
                    }
                    if (outcome === 'cancelled') {
                      return { ok: false, error: { code: 'cancelled', message: `Approval request for tool "${toolName}" was cancelled` } }
                    }
                    return { ok: false, error: { code: 'forbidden', message: `Tool call "${toolName}" was rejected by approval policy (${outcome})` } }
                  }
                } catch (err) {
                  return { ok: false, error: { code: 'unavailable', message: `Approval request failed: ${err instanceof Error ? err.message : String(err)}` } }
                }
              }

              const args = typeof params.arguments === 'object' && params.arguments !== null
                ? params.arguments as Record<string, unknown>
                : {}

              const result = await pool.callTool(session.serverName, toolName, args, signal)
              return { ok: true, value: result }
            }

            default:
              return { ok: false, error: { code: 'bad-request', message: `Unknown endpoint "${endpoint}"` } }
          }
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'internal-error',
              message: err instanceof Error ? err.message : String(err),
            },
          }
        }
      })()

      inFlight.add(task)
      try {
        return await task
      } finally {
        inFlight.delete(task)
      }
    }, { authority: 'trusted-host' })

    void pool.startAll()

    return async () => {
      isDraining = true
      unregisterRpc()

      const drainTimer = new Promise(resolve => setTimeout(resolve, 2000))
      await Promise.race([Promise.allSettled(Array.from(inFlight)), drainTimer])

      await pool.stopAll()
      toolManager.disposeAll()
      sessionStore.dispose()
    }
  }, 'mcp-apps: lifecycle coordinator')
}
