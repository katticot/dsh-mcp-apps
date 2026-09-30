import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ApprovalService, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { Config } from './config'
import { AppSessionStore } from './session-store'
import { ServerToolManager, type ToolsService } from './tool-manager'
import { ServerPool } from './transports/server-pool'

export const name = 'mcp-apps'
export const inject = ['tools', 'connection']
export { Config }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui-tools/changed': () => void
  }
  interface Context {
    tools: ToolsService
  }
}

export function apply(ctx: Context, config: Config) {
  const sessionStore = new AppSessionStore()
  let approvalService: ApprovalService | undefined
  let agentsService: AgentRegistry | undefined
  if (Object.values(config.servers).some(server => server.allowAppToolCalls === 'approve')) {
    ctx.inject(['approval'], serviceCtx => {
      const service = serviceCtx.approval
      approvalService = service
      return () => {
        if (approvalService === service) approvalService = undefined
      }
    })
    ctx.inject(['agents'], serviceCtx => {
      const service = serviceCtx.agents
      agentsService = service
      return () => {
        if (agentsService === service) agentsService = undefined
      }
    })
  }
  const notifyUiToolsChanged = () => {
    try {
      ctx.emit('ui-tools/changed')
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
      | { error: ReturnType<typeof failure> }

    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
    const OAUTH_CALLBACK_HTML = (body: string) => `<!doctype html><html><body>${escapeHtml(body)}<script>window.close()</script></body></html>`

    const requireSession = (params: Record<string, unknown>): SessionResult => {
      const sessionToken = typeof params.sessionToken === 'string' ? params.sessionToken : undefined
      if (!sessionToken) {
        return { error: failure('unauthorized', 'Missing session token') }
      }
      const session = sessionStore.get(sessionToken)
      if (!session) {
        return { error: failure('unauthorized', 'Invalid or expired session token') }
      }
      if (params.server && typeof params.server === 'string' && params.server !== session.serverName) {
        return { error: failure('forbidden', 'Resource belongs to a different server') }
      }
      return { session }
    }

    const connectionFetch: HostConnectionFetch = ctx.connection.fetch
    const handleEndpoint = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> => {
      if (isDraining) {
        return failure('unavailable', 'Host plugin is unloading')
      }

      const params = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>

      const task = (async () => {
        try {
          switch (endpoint) {
            case 'tools/list-ui': {
              await pool.waitForInitialSync()
              return { ok: true as const, value: pool.getUiToolsSnapshot() }
            }

            case 'servers/status': {
              // Read-only, no session token: connection status is not
              // session-scoped and carries no secrets (see ServerStatus).
              await pool.waitForInitialSync()
              return { ok: true as const, value: pool.getStatusSnapshot() }
            }

            case 'resources/list': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const resources = await pool.listResources(session.session.serverName)
              return { ok: true as const, value: resources }
            }

            case 'resources/read': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              const resource = await pool.readResource(session.session.serverName, uri, signal)
              return { ok: true as const, value: resource }
            }

            case 'resources/read-raw': {
              const session = requireSession(params)
              if ('error' in session) return session.error
              const uri = typeof params.uri === 'string' ? params.uri : undefined
              if (!uri) {
                return failure('bad-request', 'Missing uri parameter')
              }
              const raw = await pool.readResourceRaw(session.session.serverName, uri, signal)
              return { ok: true as const, value: raw }
            }

            case 'tools/call': {
              const sessionToken = typeof params.sessionToken === 'string' ? params.sessionToken : undefined
              if (!sessionToken) {
                return failure('unauthorized', 'Missing session token')
              }

              const session = sessionStore.get(sessionToken)
              if (!session) {
                return failure('unauthorized', 'Invalid or expired session token')
              }

              if (params.server && typeof params.server === 'string' && params.server !== session.serverName) {
                return failure('forbidden', 'Tool belongs to a different server')
              }

              const toolName = typeof params.name === 'string' ? params.name : ''
              if (!session.allowedReverseTools.has(toolName)) {
                return failure('forbidden', `Tool "${toolName}" is not permitted for this session`)
              }

              const serverConfig = config.servers[session.serverName]
              if (serverConfig?.allowAppToolCalls === 'approve') {
                const currentApproval = approvalService
                const currentAgents = agentsService
                const agent = session.agentId && currentAgents ? currentAgents.get(session.agentId) : undefined

                if (!currentApproval || !currentAgents || !agent) {
                  return failure('unavailable', 'Approval service or agent not available for tool call approval')
                }

                if (agent.status !== 'running') {
                  return failure('unavailable', `Cannot request approval while agent "${agent.id}" is idle`)
                }

                try {
                  const outcome: ApprovalOutcome = await currentApproval.request({
                    agent,
                    toolName,
                    callId: session.callId,
                    reason: `MCP App requested execution of tool "${toolName}"`,
                    signal,
                  })
                  if (approvalService !== currentApproval || agentsService !== currentAgents) {
                    return failure('unavailable', 'Approval service or agent not available for tool call approval')
                  }
                  if (outcome !== 'allowed-once') {
                    if (outcome === 'unavailable') {
                      return failure('unavailable', `Approval service is unavailable for tool "${toolName}"`)
                    }
                    if (outcome === 'cancelled') {
                      return failure('cancelled', `Approval request for tool "${toolName}" was cancelled`)
                    }
                    return failure('forbidden', `Tool call "${toolName}" was rejected by approval policy (${outcome})`)
                  }
                } catch (err) {
                  return failure('unavailable', `Approval request failed: ${err instanceof Error ? err.message : String(err)}`)
                }
              }

              const args = typeof params.arguments === 'object' && params.arguments !== null
                ? params.arguments as Record<string, unknown>
                : {}

              const result = await pool.callTool(session.serverName, toolName, args, signal)
              return { ok: true as const, value: result }
            }

            case 'oauth/authorize': {
              // No session token: starting an auth flow for a server the
              // caller can already see in `servers/status` carries nothing
              // sensitive on its own.
              const server = typeof params.server === 'string' ? params.server : undefined
              if (!server) return failure('bad-request', 'Missing server parameter')
              try {
                const authorizeUrl = await pool.getAuthorizeUrl(server)
                return { ok: true as const, value: { authorizeUrl } }
              } catch (err) {
                return failure('internal-error', pool.sanitizeError(server, err))
              }
            }

            case 'oauth/disconnect': {
              const server = typeof params.server === 'string' ? params.server : undefined
              if (!server) return failure('bad-request', 'Missing server parameter')
              try {
                await pool.disconnectOAuth(server)
                notifyUiToolsChanged()
                return { ok: true as const, value: { disconnected: true } }
              } catch (err) {
                return failure('internal-error', pool.sanitizeError(server, err))
              }
            }

            case 'servers/retry': {
              const server = typeof params.server === 'string' ? params.server : undefined
              if (!server) return failure('bad-request', 'Missing server parameter')
              try {
                await pool.retryServer(server)
                notifyUiToolsChanged()
                return { ok: true as const, value: { retried: true } }
              } catch (err) {
                return failure('internal-error', pool.sanitizeError(server, err))
              }
            }

            default:
              return failure('bad-request', `Unknown endpoint "${endpoint}"`)
          }
        } catch (err) {
          return failure('internal-error', err instanceof Error ? err.message : String(err))
        }
      })()

      inFlight.add(task)
      try {
        return await task
      } finally {
        inFlight.delete(task)
      }
    }

    const endpoints = ['tools/list-ui', 'servers/status', 'resources/list', 'resources/read', 'resources/read-raw', 'tools/call', 'oauth/authorize', 'oauth/disconnect', 'servers/retry'] as const
    const unregisterPostRoutes = endpoints.map(endpoint => connectionFetch.register({
      path: `/api/mcp-apps/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let message: unknown
        try {
          message = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const parsed = clientRequestSchema.safeParse(message)
        if (!parsed.success) return new Response('invalid Connection RPC envelope', { status: 400 })
        const envelope = parsed.data
        const expectedMethod = `mcp-apps/${endpoint}`
        if (envelope.method !== expectedMethod) {
          return new Response('invalid Connection RPC envelope', { status: 400 })
        }
        const result = await handleEndpoint(endpoint, envelope.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      },
    }))

    const handleOAuthCallback = async (rawUrl: string): Promise<{ status: number; html: string }> => {
      const url = new URL(rawUrl, 'http://127.0.0.1')
      const server = url.searchParams.get('server')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const idpError = url.searchParams.get('error')

      if (idpError) {
        const message = pool.sanitizeError(server ?? '', new Error(idpError))
        return { status: 400, html: OAUTH_CALLBACK_HTML(`Authorization failed: ${message}`) }
      }
      if (!server || !code || !state) {
        return { status: 400, html: OAUTH_CALLBACK_HTML('Authorization callback is missing required parameters.') }
      }

      try {
        await pool.completeOAuthCallback(server, code, state)
      } catch (err) {
        const message = pool.sanitizeError(server, err)
        return { status: 400, html: OAUTH_CALLBACK_HTML(`Authorization failed: ${message}`) }
      }

      notifyUiToolsChanged()
      return { status: 200, html: OAUTH_CALLBACK_HTML('Authorization complete. You can close this window.') }
    }

    // Hit by a real browser navigation from the authorization server, not
    // by the app's own RPC client — a plain GET returning HTML, not a JSON
    // RPC envelope.
    const unregisterCallbackRoute = connectionFetch.register({
      path: '/api/mcp-apps/oauth/callback',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const { status, html } = await handleOAuthCallback(request.url)
        return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
      },
    })

    // Real browser redirects from external OAuth IdPs arrive with
    // `Sec-Fetch-Site: cross-site`. DSH's Connection service protects its
    // `/api` prefix route with `isTrustedApiRequest`, which rejects all
    // `Sec-Fetch-Site: cross-site` requests with 403 Forbidden.
    // Registering an exact route directly on WebServer (when available)
    // takes priority over Connection's prefix match, allowing the OAuth
    // callback to be received without hitting the cross-site rejection.
    let unregisterWebServerRoute: (() => void) | undefined
    const registerOnWebServer = (webServer: any) => {
      try {
        const disposer = webServer.register({
          kind: 'exact',
          path: '/api/mcp-apps/oauth/callback',
          handler: async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
            if (req.method !== 'GET') {
              res.writeHead(405).end()
              return
            }
            const { status, html } = await handleOAuthCallback(req.url ?? '/')
            res.writeHead(status, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            }).end(html)
          },
        })
        console.info('mcp-apps: registered OAuth callback route directly on webServer')
        return disposer
      } catch (err) {
        console.warn('mcp-apps: failed to register OAuth callback on webServer:', err)
        return undefined
      }
    }

    if (config.externalUrl && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx: any) => {
        unregisterWebServerRoute = registerOnWebServer(webCtx.webServer)
      })
    }

    void pool.startAll()

    return async () => {
      isDraining = true
      const cleanupErrors: unknown[] = []
      const cleanup = async (operation: () => unknown) => {
        try {
          await operation()
        } catch (err) {
          cleanupErrors.push(err)
        }
      }

      for (const unregister of [...unregisterPostRoutes, unregisterCallbackRoute, unregisterWebServerRoute].filter(Boolean)) {
        await cleanup(() => (unregister as () => unknown)())
      }

      let drainTimer: ReturnType<typeof setTimeout> | undefined
      await cleanup(() => Promise.race([
        Promise.allSettled(Array.from(inFlight)),
        new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 2000) }),
      ]))
      if (drainTimer) clearTimeout(drainTimer)

      await cleanup(() => pool.stopAll())
      await cleanup(() => toolManager.disposeAll())
      await cleanup(() => sessionStore.dispose())
      if (cleanupErrors.length > 0) throw cleanupErrors[0]
    }
  }, 'mcp-apps: lifecycle coordinator')
}

function failure(code: string, message: string) {
  return { ok: false as const, error: { code, message, details: {} } }
}
