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
  let callToolSpy: any

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
    callToolSpy = vi.spyOn(ServerPool.prototype, 'callTool').mockImplementation(async (server, name, args, signal) => ({
      content: [{ type: 'text', text: `Success: ${server}.${name}` }],
      args,
      signal,
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

  it('routes through ctx.approval.request when allowAppToolCalls is approve', async () => {
    const approveConfig = {
      servers: {
        secure_srv: {
          transport: 'stdio' as const,
          command: 'sec-srv',
          allowAppToolCalls: 'approve' as const,
        },
      },
    }

    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once'),
    }
    const mockAgents = {
      get: vi.fn().mockReturnValue({ id: 'agent-sec', status: 'running' }),
    }

    let secureRpcHandler: any
    const mockCtx = {
      tools: {
        register: vi.fn((def: any) => {
          registeredToolDefs.push(def)
          return vi.fn()
        }),
      },
      connection: {
        register: vi.fn((_ctx: any, _path: string, handler: any) => {
          secureRpcHandler = handler
          return vi.fn()
        }),
      },
      effect: vi.fn((fn: () => any) => fn()),
      approval: mockApproval,
      agents: mockAgents,
    }

    apply(mockCtx as any, approveConfig as any)

    // Execute tool on secure_srv
    const secureTools: Tool[] = [
      {
        name: 'secure_chart',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'ui://secure/chart' } },
      },
      {
        name: 'write_db',
        inputSchema: { type: 'object' },
      },
    ]

    toolManager.syncServerTools('secure_srv', mockClient as any, secureTools, approveConfig.servers.secure_srv)

    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__secure_srv__secure_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-sec' }, callId: 'c-sec-1' })
    const sessionToken = execResult._sessionToken

    // Call write_db which requires approval
    const res = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
      arguments: { sql: 'UPDATE table SET val=1' },
    })

    expect(mockApproval.request).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ id: 'agent-sec' }),
      toolName: 'write_db',
      callId: 'c-sec-1',
    }))
    expect(res).toEqual({
      ok: true,
      value: {
        content: [{ type: 'text', text: 'Success: secure_srv.write_db' }],
        args: { sql: 'UPDATE table SET val=1' },
      },
    })

    // If approval returns 'rejected', tool call should be rejected
    mockApproval.request.mockResolvedValueOnce('rejected')
    const rejectedRes = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
    })
    expect(rejectedRes.ok).toBe(false)
    expect(rejectedRes.error.code).toBe('forbidden')

    // If approval returns 'unavailable', return error with code 'unavailable'
    mockApproval.request.mockResolvedValueOnce('unavailable')
    const unavailRes = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
    })
    expect(unavailRes).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Approval service is unavailable for tool "write_db"',
      },
    })

    // If approval returns 'cancelled', return error with code 'cancelled'
    mockApproval.request.mockResolvedValueOnce('cancelled')
    const cancelledRes = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
    })
    expect(cancelledRes).toEqual({
      ok: false,
      error: {
        code: 'cancelled',
        message: 'Approval request for tool "write_db" was cancelled',
      },
    })

    // If approval request throws, fail closed with 'unavailable'
    mockApproval.request.mockRejectedValueOnce(new Error('Prompt dismissed'))
    const thrownRes = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
    })
    expect(thrownRes).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Approval request failed: Prompt dismissed',
      },
    })

    // If agent is idle (status !== 'running'), fail closed before requesting approval
    mockAgents.get.mockReturnValueOnce({ id: 'agent-sec', status: 'idle' })
    const idleRes = await secureRpcHandler('tools/call', {
      sessionToken,
      name: 'write_db',
    })
    expect(idleRes).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Cannot request approval while agent "agent-sec" is idle',
      },
    })
    expect(mockApproval.request).not.toHaveBeenCalledTimes(6) // not called for the idle attempt
  })

  it('handles approve mode when approval or agents service is missing or agent is disposed', async () => {
    const approveConfig = {
      servers: {
        secure_srv: {
          transport: 'stdio' as const,
          command: 'sec-srv',
          allowAppToolCalls: 'approve' as const,
        },
      },
    }

    let handlerWithoutServices: any
    // Case 1: no approval or agents service
    const bareCtx = {
      tools: { register: vi.fn(def => { registeredToolDefs.push(def); return vi.fn() }) },
      connection: { register: vi.fn((_c, _p, h) => { handlerWithoutServices = h; return vi.fn() }) },
      effect: vi.fn(fn => fn()),
    }
    apply(bareCtx as any, approveConfig as any)

    toolManager.syncServerTools('secure_srv', mockClient as any, [
      { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://sec/chart' } } },
      { name: 'action', inputSchema: { type: 'object' } },
    ], approveConfig.servers.secure_srv)

    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__secure_srv__chart')
    const exec = await chartDef.execute({}, { agent: { id: 'a1' }, callId: 'c1' })
    const resNoService = await handlerWithoutServices('tools/call', {
      sessionToken: exec._sessionToken,
      name: 'action',
    })
    expect(resNoService).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Approval service or agent not available for tool call approval',
      },
    })

    // Case 2: agent disposed / get returns undefined
    let handlerWithDisposedAgent: any
    const ctxDisposed = {
      tools: { register: vi.fn(def => { registeredToolDefs.push(def); return vi.fn() }) },
      connection: { register: vi.fn((_c, _p, h) => { handlerWithDisposedAgent = h; return vi.fn() }) },
      effect: vi.fn(fn => fn()),
      approval: { request: vi.fn() },
      agents: { get: vi.fn().mockReturnValue(undefined) },
    }
    apply(ctxDisposed as any, approveConfig as any)
    toolManager.syncServerTools('secure_srv', mockClient as any, [
      { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://sec/chart' } } },
      { name: 'action', inputSchema: { type: 'object' } },
    ], approveConfig.servers.secure_srv)

    const chartDef2 = registeredToolDefs[registeredToolDefs.length - 2]
    const execDisposed = await chartDef2.execute({}, { agent: { id: 'a2' }, callId: 'c2' })
    const resDisposed = await handlerWithDisposedAgent('tools/call', {
      sessionToken: execDisposed._sessionToken,
      name: 'action',
    })
    expect(resDisposed).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Approval service or agent not available for tool call approval',
      },
    })

    // Case 3: session without agentId (e.g. executed without agent context)
    const execNoAgent = await chartDef2.execute({}, {})
    const resNoAgent = await handlerWithDisposedAgent('tools/call', {
      sessionToken: execNoAgent._sessionToken,
      name: 'action',
    })
    expect(resNoAgent).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Approval service or agent not available for tool call approval',
      },
    })
  })

  it('rejects app tool calls end-to-end when allowAppToolCalls is false', async () => {
    const denyConfig = {
      servers: {
        denied_srv: {
          transport: 'stdio' as const,
          command: 'denied-srv',
          allowAppToolCalls: false,
        },
      },
    }
    let deniedHandler: any
    const mockCtx = {
      tools: { register: vi.fn(def => { registeredToolDefs.push(def); return vi.fn() }) },
      connection: { register: vi.fn((_c, _p, h) => { deniedHandler = h; return vi.fn() }) },
      effect: vi.fn(fn => fn()),
    }
    apply(mockCtx as any, denyConfig as any)

    toolManager.syncServerTools('denied_srv', mockClient as any, [
      { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://denied/chart' } } },
      { name: 'action', inputSchema: { type: 'object' } },
    ], denyConfig.servers.denied_srv)

    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__denied_srv__chart')
    const exec = await chartDef.execute({}, { agent: { id: 'a1' }, callId: 'c1' })
    const res = await deniedHandler('tools/call', {
      sessionToken: exec._sessionToken,
      name: 'action',
    })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Tool "action" is not permitted for this session',
      },
    })
  })

  it('forwards AbortSignal to pool.callTool on reverse tool call', async () => {
    const chartDef = registeredToolDefs.find(d => d.name === 'mcp__analytics__render_chart')
    const execResult = await chartDef.execute({}, { agent: { id: 'agent-1' }, callId: 'c-1' })
    const sessionToken = execResult._sessionToken

    const ac = new AbortController()
    const res = await rpcHandler('tools/call', {
      sessionToken,
      server: 'analytics',
      name: 'export_csv',
      arguments: { format: 'csv' },
    }, ac.signal)

    expect(res.ok).toBe(true)
    expect(callToolSpy).toHaveBeenCalledWith('analytics', 'export_csv', { format: 'csv' }, ac.signal)
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

  it('supports resources/read-raw returning raw ReadResourceResult unchanged', async () => {
    const rawResult = {
      contents: [
        { uri: 'resource://data', text: 'raw data' },
        { uri: 'resource://data2', blob: 'YmxvYg==' },
      ],
    }
    vi.spyOn(ServerPool.prototype, 'readResourceRaw').mockResolvedValue(rawResult as any)

    const response = await rpcHandler('resources/read-raw', { server: 'analytics', uri: 'resource://data' })
    expect(response.ok).toBe(true)
    expect(response.value).toEqual(rawResult)
  })
})
