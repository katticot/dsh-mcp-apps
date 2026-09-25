import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ApprovalService, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { Config } from './config'
import { AppSessionStore } from './session-store'
import { ServerToolManager, type ToolsService } from './tool-manager'
import { ServerPool } from './transports/server-pool'

export const name = 'mcp-apps'
export const inject = ['tools', 'connection']
export { Config }

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
    connection: {
      register?: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      rpc: {
        handle: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      }
    }
  }
}

export function apply(ctx: Context, config: Config) {
  const sessionStore = new AppSessionStore()
  const toolManager = new ServerToolManager(ctx.tools, sessionStore)
  const pool = new ServerPool(ctx, config, toolManager)

  // Single coordinated effect: manages RPC routing, server lifecycle, and in-flight draining
  ctx.effect(() => {
    let isDraining = false
    const inFlight = new Set<Promise<unknown>>()

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
              const server = typeof params.server === 'string' ? params.server : undefined
              const resources = await pool.listResources(server)
              return { ok: true, value: resources }
            }

            case 'resources/read': {
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              const server = typeof params.server === 'string' ? params.server : undefined
              const resource = await pool.readResource(server, uri, signal)
              return { ok: true, value: resource }
            }

            case 'resources/read-raw': {
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              const server = typeof params.server === 'string' ? params.server : undefined
              if (!uri) {
                return { ok: false, error: { code: 'bad-request', message: 'Missing uri parameter' } }
              }
              const raw = await pool.readResourceRaw(server, uri, signal)
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
                const approvalService = ctx.approval ?? (typeof (ctx as any).get === 'function' ? (ctx as any).get('approval') : undefined)
                const agentsService = ctx.agents ?? (typeof (ctx as any).get === 'function' ? (ctx as any).get('agents') : undefined)
                const agent = session.agentId && agentsService ? agentsService.get(session.agentId as any) : undefined

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
                    callId: session.callId as any,
                    reason: `MCP App requested execution of tool "${toolName}"`,
                    signal,
                  })
                  if (outcome === 'allowed-once') {
                    // Approved, proceed
                  } else if (outcome === 'unavailable') {
                    return { ok: false, error: { code: 'unavailable', message: `Approval service is unavailable for tool "${toolName}"` } }
                  } else if (outcome === 'cancelled') {
                    return { ok: false, error: { code: 'cancelled', message: `Approval request for tool "${toolName}" was cancelled` } }
                  } else {
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

    // Start all servers in background
    void pool.startAll()

    // Disposer runs on plugin unload / HMR
    return async () => {
      isDraining = true
      unregisterRpc()

      // Grace period: allow active in-flight calls to drain (up to 2000ms)
      const drainTimer = new Promise(resolve => setTimeout(resolve, 2000))
      await Promise.race([Promise.allSettled(Array.from(inFlight)), drainTimer])

      // Clean up server pool and all tool registrations
      await pool.stopAll()
      toolManager.disposeAll()
      sessionStore.dispose()
    }
  }, 'mcp-apps: lifecycle coordinator')
}
