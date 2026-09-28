import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, name, inject } from '../src/index'
import type { Config } from '../src/config'
import { ServerPool } from '../src/transports/server-pool'
import { AppSessionStore } from '../src/session-store'
import { ServerToolManager } from '../src/tool-manager'

const config: Config = { servers: {} }

describe('DSH host contracts', () => {
  afterEach(() => vi.restoreAllMocks())

  it('registers validated app endpoints through public Connection Fetch routes', async () => {
    const routes = new Map<string, ConnectionFetchRoute>()
    const register = vi.fn((route: ConnectionFetchRoute) => {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    })
    const effectDisposers: Array<() => unknown> = []
    const ctx = {
      tools: { register: vi.fn(() => vi.fn()) },
      connection: { fetch: { register } },
      webServer: { register: vi.fn(() => vi.fn()) },
      effect: vi.fn((effect: () => unknown) => {
        const disposer = effect()
        if (typeof disposer === 'function') effectDisposers.push(disposer as () => unknown)
        return vi.fn()
      }),
    }

    const startAll = vi.spyOn(ServerPool.prototype, 'startAll').mockResolvedValue(undefined)
    const stopAll = vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)
    apply(ctx as any, config)

    expect(register).toHaveBeenCalledTimes(6)
    expect(routes.has('/api/mcp-apps/tools/list-ui')).toBe(true)
    const route = routes.get('/api/mcp-apps/tools/list-ui')!
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    const good = await route.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-id', method: 'mcp-apps/tools/list-ui', payload: null }),
    }))
    expect(await good.json()).toEqual({ type: 'server-response', rpcId: 'smoke-id', result: { ok: true, value: [] } })
    const malformed = await route.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-id', method: 'mcp-apps/tools/list-ui' }),
    }))
    expect(malformed.status).toBe(400)
    const mismatched = await route.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-id', method: 'mcp-apps/resources/list', payload: null }),
    }))
    expect(mismatched.status).toBe(400)
    const invalid = await route.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', { method: 'POST', body: '{' }))
    expect(invalid.status).toBe(400)
    expect(startAll).toHaveBeenCalledOnce()

    for (const dispose of effectDisposers) await dispose()
    expect(stopAll).toHaveBeenCalledOnce()
  })

  it('registers and removes exact routes when Connection and webServer are separate Cordis providers', async () => {
    const cordis = new Context()
    const webRoutes = new Map<string, { handler: unknown; kind: string }>()
    const definitions: unknown[] = []
    let connection!: HostConnectionService
    const webServer = {
      register: vi.fn((route: { path: string; kind: string; handler: unknown }) => {
        webRoutes.set(route.path, route)
        return () => webRoutes.delete(route.path)
      }),
    }
    const tools = {
      register: vi.fn((definition: unknown) => {
        definitions.push(definition)
        return () => {}
      }),
    }
    const browserAuth = {
      isAuthenticated: () => true,
      authorizeIndex: () => true,
      authenticatedUrl: (url: string) => url,
    }

    const baseProviders = {
      name: 'base-contract-providers',
      apply(ctx: Context) {
        ctx.provide('tools', tools)
        ctx.provide('webServer', webServer)
        ctx.provide('credentials', {} as any)
      },
    }
    const connectionProvider = {
      name: 'connection-contract-provider',
      inject: ['credentials'],
      apply(ctx: Context) {
        connection = new HostConnectionService(ctx, [], browserAuth as any)
      },
    }
    const feature = { name, inject, apply: (ctx: Context) => apply(ctx, config) }

    const startAll = vi.spyOn(ServerPool.prototype, 'startAll').mockResolvedValue(undefined)
    const stopAll = vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)
    const baseFiber = cordis.plugin(baseProviders)
    await baseFiber
    const connectionFiber = cordis.plugin(connectionProvider)
    await connectionFiber

    const firstFiber = cordis.plugin(feature)
    await firstFiber
    expect(firstFiber.state).not.toBe(0)
    expect(webRoutes.size).toBe(0)
    const handler = connection!.createSharedFetchHandler('/api')
    const response = await handler.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'contract-id', method: 'mcp-apps/tools/list-ui', payload: null }),
    }))
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'contract-id', result: { ok: true, value: [] } })

    await firstFiber.dispose()
    const removed = await handler.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'contract-id', method: 'mcp-apps/tools/list-ui', payload: null }),
    }))
    expect(removed.status).toBe(404)
    expect(stopAll).toHaveBeenCalledOnce()

    const secondFiber = cordis.plugin(feature)
    await secondFiber
    expect(secondFiber.state).not.toBe(0)
    expect(webRoutes.size).toBe(0)
    expect(startAll).toHaveBeenCalledTimes(2)

    await secondFiber.dispose()
    await connectionFiber.dispose()
    await baseFiber.dispose()
    await cordis.registry.delete(feature)
    await cordis.registry.delete(connectionProvider)
    await cordis.registry.delete(baseProviders)
  })

  it('registers tools on a headless host that never provides webServer', async () => {
    const cordis = new Context()
    const definitions: unknown[] = []
    let connection!: HostConnectionService
    const tools = {
      register: vi.fn((definition: unknown) => {
        definitions.push(definition)
        return () => {}
      }),
    }
    const browserAuth = {
      isAuthenticated: () => true,
      authorizeIndex: () => true,
      authenticatedUrl: (url: string) => url,
    }

    // Deliberately no `webServer` provider anywhere in this tree: a headless
    // DSH host (no browser, no HTTP server) still needs host-side MCP tools
    // to register, and the plugin's own `inject` list must not require a
    // service it never touches.
    const baseProviders = {
      name: 'headless-base-providers',
      apply(ctx: Context) {
        ctx.provide('tools', tools)
        ctx.provide('credentials', {} as any)
      },
    }
    const connectionProvider = {
      name: 'headless-connection-provider',
      inject: ['credentials'],
      apply(ctx: Context) {
        connection = new HostConnectionService(ctx, [], browserAuth as any)
      },
    }
    const feature = { name, inject, apply: (ctx: Context) => apply(ctx, config) }

    const startAll = vi.spyOn(ServerPool.prototype, 'startAll').mockResolvedValue(undefined)
    vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)

    const baseFiber = cordis.plugin(baseProviders)
    await baseFiber
    const connectionFiber = cordis.plugin(connectionProvider)
    await connectionFiber

    const featureFiber = cordis.plugin(feature)
    await featureFiber

    expect(featureFiber.state).not.toBe(0)
    expect(startAll).toHaveBeenCalledOnce()
    const handler = connection!.createSharedFetchHandler('/api')
    const response = await handler.fetch(new Request('http://dsh.internal/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'headless-id', method: 'mcp-apps/tools/list-ui', payload: null }),
    }))
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'headless-id', result: { ok: true, value: [] } })

    await featureFiber.dispose()
    await connectionFiber.dispose()
    await baseFiber.dispose()
    await cordis.registry.delete(feature)
    await cordis.registry.delete(connectionProvider)
    await cordis.registry.delete(baseProviders)
  })

  it('keeps approve mode unavailable without scoped optional services and rejects stale approval after provider removal', async () => {
    const cordis = new Context()
    const definitions: any[] = []
    let rpcHandler: ((endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<any>) | undefined
    const callTool = vi.spyOn(ServerPool.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'executed' }] } as any)
    const tools = {
      register: vi.fn((definition: any) => {
        definitions.push(definition)
        return () => {}
      }),
    }
    const connectionRoutes: ConnectionFetchRoute[] = []
    const connection = {
      fetch: {
        register: vi.fn((route: ConnectionFetchRoute) => {
          connectionRoutes.push(route)
          return async () => {}
        }),
      },
    }
    const hostProviders = {
      name: 'optional-services-host',
      apply(ctx: Context) {
        ctx.provide('tools', tools as any)
        ctx.provide('connection', connection as any)
        ctx.provide('webServer', { register: vi.fn(() => () => {}) } as any)
      },
    }
    const approveConfig: Config = {
      servers: {
        secure_srv: { transport: 'stdio', command: 'secure-srv', allowAppToolCalls: 'approve' },
      },
    }
    const feature = { name: 'optional-services-feature', inject, apply: (ctx: Context) => apply(ctx, approveConfig) }
    vi.spyOn(ServerPool.prototype, 'startAll').mockImplementation(function (this: any) {
      this.toolManager.syncServerTools('secure_srv', { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'chart' }] }) }, [
        { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://secure/chart' } } },
        { name: 'write_db', inputSchema: { type: 'object' } },
      ], approveConfig.servers.secure_srv)
      return Promise.resolve()
    })
    vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)

    const hostFiber = cordis.plugin(hostProviders)
    await hostFiber
    const featureFiber = cordis.plugin(feature)
    await featureFiber
    expect(featureFiber.state).not.toBe(0)
    rpcHandler = async (endpoint, payload, signal) => {
      const route = connectionRoutes.find(candidate => candidate.path === `/api/mcp-apps/${endpoint}`)
      if (!route) throw new Error(`No route for ${endpoint}`)
      const response = await route.fetch(new Request(`http://dsh.internal/api/mcp-apps/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: `test-${endpoint}`, method: `mcp-apps/${endpoint}`, payload }),
        signal,
      }))
      return (await response.json() as any).result
    }

    const chart = definitions.find(definition => definition.name === 'mcp__secure_srv__chart')
    const session = await chart.execute({}, { agent: { id: 'agent-sec' }, callId: 'call-sec' })
    const request = (signal?: AbortSignal) => rpcHandler!('tools/call', {
      sessionToken: session._sessionToken,
      name: 'write_db',
    }, signal)

    expect(await request()).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Approval service or agent not available for tool call approval', details: {} },
    })
    expect(callTool).not.toHaveBeenCalled()

    let resolveApproval!: (outcome: string) => void
    const approval = {
      request: vi.fn().mockResolvedValue('allowed-once'),
    }
    const agent = { id: 'agent-sec', status: 'running' }
    const agents = { get: vi.fn(() => agent) }
    const optionalProviders = {
      name: 'late-approval-providers',
      apply(ctx: Context) {
        ctx.provide('approval', approval as any)
        ctx.provide('agents', agents as any)
      },
    }
    const optionalFiber = cordis.plugin(optionalProviders)
    await optionalFiber

    expect(await request()).toEqual({ ok: true, value: { content: [{ type: 'text', text: 'executed' }] } })
    expect(callTool).toHaveBeenCalledOnce()

    agent.status = 'idle'
    expect(await request()).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Cannot request approval while agent "agent-sec" is idle', details: {} },
    })
    agent.status = 'running'

    approval.request.mockResolvedValueOnce('cancelled')
    expect(await request()).toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'Approval request for tool "write_db" was cancelled', details: {} },
    })
    expect(callTool).toHaveBeenCalledOnce()

    approval.request.mockImplementationOnce(() => new Promise<string>(resolve => { resolveApproval = resolve }))
    const pending = request()
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledTimes(3))
    const removingProviders = optionalFiber.dispose()
    resolveApproval('allowed-once')
    await removingProviders
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Approval service or agent not available for tool call approval', details: {} },
    })
    expect(callTool).toHaveBeenCalledOnce()

    await featureFiber.dispose()
    await hostFiber.dispose()
    await cordis.registry.delete(feature)
    await cordis.registry.delete(hostProviders)
    await cordis.registry.delete(optionalProviders)
  })

  it('continues cleanup when asynchronous RPC route disposal rejects', async () => {
    let unload: (() => Promise<void>) | undefined
    const stopAll = vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)
    const disposeTools = vi.spyOn(ServerToolManager.prototype, 'disposeAll')
    const disposeSessions = vi.spyOn(AppSessionStore.prototype, 'dispose')
    const tools = { register: vi.fn(() => vi.fn()) }
    const ctx = {
      tools,
      connection: { fetch: { register: vi.fn(() => vi.fn().mockRejectedValue(new Error('route cleanup failed'))) } },
      webServer: { register: vi.fn(() => vi.fn()) },
      effect: vi.fn((effect: () => unknown) => {
        const disposer = effect()
        if (typeof disposer === 'function') unload = disposer as () => Promise<void>
        return vi.fn()
      }),
    }

    vi.spyOn(ServerPool.prototype, 'startAll').mockResolvedValue(undefined)
    apply(ctx as any, config)
    expect(unload).toBeDefined()
    await expect(unload!()).rejects.toThrow('route cleanup failed')
    expect(stopAll).toHaveBeenCalledOnce()
    expect(disposeTools).toHaveBeenCalledOnce()
    expect(disposeSessions).toHaveBeenCalledOnce()
    expect(tools.register).not.toHaveBeenCalled()
  })
})
