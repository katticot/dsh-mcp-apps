import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apply } from '../src/index'
import type { Config } from '../src/config'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { ServerPool } from '../src/transports/server-pool'
import type { ServerToolManager } from '../src/tool-manager'

describe('RPC tools/call Authorization and Lifecycle', () => {
  let rpcHandler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<any>
  let unloadPlugin: () => Promise<void>
  let toolManager: ServerToolManager
  let registeredToolDefs: any[]
  let callToolSpy: ReturnType<typeof vi.spyOn>

  const config: Config = {
    servers: {
      analytics: {
        transport: 'stdio',
        command: 'analytics-srv',
        allowAppToolCalls: true,
      },
      other_server: {
        transport: 'stdio',
        command: 'other-srv',
        allowAppToolCalls: true,
      },
    },
  }

  const mockClient = {
    callTool: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      return { content: [{ type: 'text', text: `Result of ${name}` }] }
    }),
  }

  const tools: Tool[] = [
    {
      name: 'render_chart',
      description: 'Render interactive chart',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://analytics/chart' } },
    },
    {
      name: 'export_csv',
      description: 'Export data to CSV',
      inputSchema: { type: 'object' },
    },
    {
      name: 'internal_eval',
      description: 'Model internal evaluation',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } },
    },
  ]

  beforeEach(() => {
    registeredToolDefs = []

    vi.spyOn(ServerPool.prototype, 'startAll').mockImplementation(function (this: any) {
      toolManager = this.toolManager
      return Promise.resolve()
    })
    vi.spyOn(ServerPool.prototype, 'stopAll').mockResolvedValue(undefined)
    callToolSpy = vi.spyOn(ServerPool.prototype, 'callTool').mockImplementation(async (server, name, args) => ({
      content: [{ type: 'text', text: `Success: ${server}.${name}` }],
      args,
    }))

    const mockCtx = {
      tools: {
        register: vi.fn((def: any) => {
          registeredToolDefs.push(def)
          return vi.fn()
        }),
      },
      connection: {
        register: vi.fn((_ctx: any, _path: string, handler: any) => {
          rpcHandler = handler
          return vi.fn()
        }),
      },
      effect: vi.fn((fn: () => any) => {
        unloadPlugin = fn()
        return vi.fn()
      }),
    }

    apply(mockCtx as any, config)

    // Sync tools for 'analytics' server
    toolManager.syncServerTools('analytics', mockClient as any, tools, config.servers.analytics)
  })

  it('rejects a call with no token', async () => {
    const res = await rpcHandler('tools/call', {
      name: 'export_csv',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Missing session token',
      },
    })
    expect(callToolSpy).not.toHaveBeenCalled()
  })

  it('rejects a call with an invalid token', async () => {
    const res = await rpcHandler('tools/call', {
      sessionToken: 'invalid-non-existent-token-12345',
      name: 'export_csv',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Invalid or expired session token',
      },
    })
    expect(callToolSpy).not.toHaveBeenCalled()
  })

  it('rejects a call with an expired token', async () => {
    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__analytics__render_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-1' }, callId: 'c-1' })
    const sessionToken = execResult._sessionToken
    expect(sessionToken).toBeDefined()

    // Manually expire the session in the store
    const store = (toolManager as any).sessionStore
    const session = store.get(sessionToken)
    session.expiresAt = Date.now() - 1000

    const res = await rpcHandler('tools/call', {
      sessionToken,
      name: 'export_csv',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Invalid or expired session token',
      },
    })
    expect(callToolSpy).not.toHaveBeenCalled()
  })

  it('rejects a call to a model-only tool', async () => {
    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__analytics__render_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-1' }, callId: 'c-1' })
    const sessionToken = execResult._sessionToken

    // Try calling internal_eval which is model-only
    const res = await rpcHandler('tools/call', {
      sessionToken,
      name: 'internal_eval',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Tool "internal_eval" is not permitted for this session',
      },
    })
    expect(callToolSpy).not.toHaveBeenCalled()
  })

  it('rejects a call to a tool on a different server', async () => {
    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__analytics__render_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-1' }, callId: 'c-1' })
    const sessionToken = execResult._sessionToken

    // Pass server parameter pointing to a different server
    const res = await rpcHandler('tools/call', {
      sessionToken,
      server: 'other_server',
      name: 'export_csv',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Tool belongs to a different server',
      },
    })
    expect(callToolSpy).not.toHaveBeenCalled()
  })

  it('allows authorized call to permitted tool on the same server', async () => {
    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__analytics__render_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-1' }, callId: 'c-1' })
    const sessionToken = execResult._sessionToken

    const res = await rpcHandler('tools/call', {
      sessionToken,
      server: 'analytics',
      name: 'export_csv',
      arguments: { format: 'csv' },
    })

    expect(res).toEqual({
      ok: true,
      value: {
        content: [{ type: 'text', text: 'Success: analytics.export_csv' }],
        args: { format: 'csv' },
      },
    })
    expect(callToolSpy).toHaveBeenCalledWith('analytics', 'export_csv', { format: 'csv' }, undefined)
  })

  it('disposes sessionStore when host plugin unloads', async () => {
    const store = (toolManager as any).sessionStore
    const disposeSpy = vi.spyOn(store, 'dispose')

    await unloadPlugin()
    expect(disposeSpy).toHaveBeenCalled()

    // Subsequent calls while draining should return unavailable
    const res = await rpcHandler('tools/call', { sessionToken: 'any' })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Host plugin is unloading',
      },
    })
  })
})
