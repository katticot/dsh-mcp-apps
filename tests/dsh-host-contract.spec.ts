import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, name, inject } from '../src/index'
import type { Config } from '../src/config'
import { ServerPool } from '../src/transports/server-pool'
import { AppSessionStore } from '../src/session-store'
import { ServerToolManager } from '../src/tool-manager'

const config: Config = { servers: {} }

describe('DSH host contracts', () => {
  afterEach(() => vi.restoreAllMocks())

  it('registers the RPC handler through the public two-argument connection API', async () => {
    let registeredChannel: string | undefined
    let registeredHandler: ConnectionRpcHandler | undefined
    const unregister = vi.fn(async () => {})
    const handle = vi.fn((channel: string, handler: ConnectionRpcHandler) => {
      registeredChannel = channel
      registeredHandler = handler
      return unregister
    })
    const effectDisposers: Array<() => unknown> = []
    const ctx = {
      tools: { register: vi.fn(() => vi.fn()) },
      connection: { rpc: { handle } },
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

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('/mcp-apps', expect.any(Function))
    expect(registeredChannel).toBe('/mcp-apps')
    expect(await registeredHandler?.('tools/list-ui', {}, new AbortController().signal)).toEqual({ ok: true, value: [] })
    expect(startAll).toHaveBeenCalledOnce()

    for (const dispose of effectDisposers) await dispose()
    expect(stopAll).toHaveBeenCalledOnce()
  })

  it('loads, unloads, and reloads under Cordis using the real HostConnectionService', async () => {
    const cordis = new Context()
    const routes = new Map<string, { handler: unknown; kind: string }>()
    const definitions: unknown[] = []
    const webServer = {
      register: vi.fn((route: { path: string; kind: string; handler: unknown }) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
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

    const providers = {
      name: 'host-contract-providers',
      apply(ctx: Context) {
        ctx.provide('tools', tools)
        ctx.provide('webServer', webServer)
        new HostConnectionService(ctx, [], browserAuth as any)
      },
    }
    const feature = { name, inject, apply: (ctx: Context) => apply(ctx, config) }

    const startAll = vi.spyOn(ServerPool.prototype, 'startAll').mockResolvedValue(undefined)
    const stopAll = vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)
    const providerFiber = cordis.plugin(providers)
    await providerFiber

    const firstFiber = cordis.plugin(feature)
    await firstFiber
    expect(firstFiber.state).not.toBe(0)
    expect(routes.has('/mcp-apps')).toBe(true)
    expect(webServer.register).toHaveBeenCalledWith(expect.objectContaining({ path: '/mcp-apps', kind: 'prefix' }))

    await firstFiber.dispose()
    expect(routes.has('/mcp-apps')).toBe(false)
    expect(stopAll).toHaveBeenCalledOnce()

    const secondFiber = cordis.plugin(feature)
    await secondFiber
    expect(secondFiber.state).not.toBe(0)
    expect(routes.has('/mcp-apps')).toBe(true)
    expect(startAll).toHaveBeenCalledTimes(2)

    await secondFiber.dispose()
    await providerFiber.dispose()
    await cordis.registry.delete(feature)
    await cordis.registry.delete(providers)
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
    const connection = {
      rpc: {
        handle: vi.fn((_channel: string, handler: typeof rpcHandler) => {
          rpcHandler = handler as typeof rpcHandler
          return () => {}
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
    expect(approval.request).toHaveBeenCalledTimes(3)
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
      connection: { rpc: { handle: vi.fn(() => vi.fn().mockRejectedValue(new Error('route cleanup failed'))) } },
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
