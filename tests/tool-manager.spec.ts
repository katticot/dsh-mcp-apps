import { describe, it, expect, vi } from 'vitest'
import { ServerToolManager, publicToolName } from '../src/tool-manager'
import { ServerPool } from '../src/transports/server-pool'
import { AppSessionStore } from '../src/session-store'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

describe('ServerToolManager', () => {
  it('registers tools with canonical names and tracks disposers', () => {
    const registered: unknown[] = []
    const mockToolsService = {
      register: vi.fn((def: unknown) => {
        registered.push(def)
        return vi.fn()
      }),
    }

    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)

    const mockClient = {
      callTool: vi.fn(),
    } as unknown as Parameters<ServerToolManager['syncServerTools']>[1]

    const tools: Tool[] = [
      {
        name: 'render_chart',
        description: 'Render interactive chart',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        _meta: {
          ui: {
            resourceUri: 'ui://charts/app',
          },
        },
      },
      {
        name: 'raw_data',
        description: 'Get raw data without UI',
        inputSchema: { type: 'object' },
      },
    ]

    manager.syncServerTools('analytics', mockClient, tools)

    expect(mockToolsService.register).toHaveBeenCalledTimes(2)
    const uiSnapshot = manager.getUiToolsSnapshot()
    expect(uiSnapshot).toHaveLength(1)
    expect(uiSnapshot[0]).toEqual({
      serverName: 'analytics',
      rawName: 'render_chart',
      publicName: 'mcp__analytics__render_chart',
      resourceUri: 'ui://charts/app',
    })
  })

  it('evicts server tools on disconnect', () => {
    const disposeFn = vi.fn()
    const mockToolsService = {
      register: vi.fn(() => disposeFn),
    }

    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const mockClient = {} as Parameters<ServerToolManager['syncServerTools']>[1]

    manager.syncServerTools('postgres', mockClient, [
      { name: 'query', inputSchema: { type: 'object' } },
    ])

    manager.evictServer('postgres')
    expect(disposeFn).toHaveBeenCalled()
    expect(manager.getUiToolsSnapshot()).toHaveLength(0)
  })

  it('normalizes tool names with dots to strictly match ^[a-zA-Z0-9_-]+$', () => {
    const dotted = publicToolName('powerhive', 'db.query')
    expect(dotted).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(dotted).toContain('mcp__powerhive__db_query')

    const sparkTool = publicToolName('powerhive', 'spark.get_battery_health')
    expect(sparkTool).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('filters allowedReverseTools based on allowAppToolCalls and model-only visibility', async () => {
    const registered: any[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def)
        return vi.fn()
      }),
    }

    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    } as unknown as Parameters<ServerToolManager['syncServerTools']>[1]

    const tools: Tool[] = [
      {
        name: 'render_chart',
        description: 'Render interactive chart',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'ui://charts/app' } },
      },
      {
        name: 'query_db',
        description: 'Query database',
        inputSchema: { type: 'object' },
      },
      {
        name: 'model_secret_eval',
        description: 'Secret model reasoning',
        inputSchema: { type: 'object' },
        _meta: { ui: { visibility: ['model'] } },
      },
    ]

    manager.syncServerTools('analytics', mockClient, tools, {
      transport: 'stdio',
      command: 'analytics-srv',
      allowAppToolCalls: true,
    })

    const chartDef = registered.find(d => d.name === 'mcp__analytics__render_chart')
    expect(chartDef).toBeDefined()

    const execResult = await chartDef.execute({}, { agent: { id: 'agent-a' }, rootCallId: 'call-root-1' })
    expect(execResult._sessionToken).toBeDefined()

    const session = sessionStore.get(execResult._sessionToken)
    expect(session).toBeDefined()
    expect(session?.allowedReverseTools.has('render_chart')).toBe(true)
    expect(session?.allowedReverseTools.has('query_db')).toBe(true)
    expect(session?.allowedReverseTools.has('model_secret_eval')).toBe(false)

    manager.evictServer('analytics')
    registered.length = 0
    manager.syncServerTools('analytics', mockClient, tools, {
      transport: 'stdio',
      command: 'analytics-srv',
      allowAppToolCalls: false,
    })

    const chartDefDisabled = registered.find(d => d.name === 'mcp__analytics__render_chart')
    const disabledExecResult = await chartDefDisabled.execute({})
    expect(disabledExecResult._sessionToken).toBeDefined()

    const disabledSession = sessionStore.get(disabledExecResult._sessionToken)
    expect(disabledSession).toBeDefined()
    expect(disabledSession?.allowedReverseTools.size).toBe(0)
  })

  it('creates session in execute with agentId/callId and strips _sessionToken in presentationMeta', async () => {
    const registered: any[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def)
        return vi.fn()
      }),
    }

    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello chart' }],
        structuredContent: { data: [1, 2, 3] },
      }),
    } as unknown as Parameters<ServerToolManager['syncServerTools']>[1]

    const tools: Tool[] = [
      {
        name: 'render_chart',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'ui://charts/app' } },
      },
    ]

    manager.syncServerTools('analytics', mockClient, tools, {
      transport: 'stdio',
      command: 'analytics-srv',
      allowAppToolCalls: true,
    })

    const chartDef = registered[0]
    const execResult = await chartDef.execute({ title: 'My Chart' }, {
      agent: { id: 'agent-42' },
      callId: 'call-99',
    })

    expect(execResult).toEqual({
      content: [{ type: 'text', text: 'Hello chart' }],
      structuredContent: { data: [1, 2, 3] },
      _sessionToken: expect.any(String),
    })

    const session = sessionStore.get(execResult._sessionToken)
    expect(session?.agentId).toBe('agent-42')
    expect(session?.callId).toBe('call-99')

    const meta = chartDef.output.presentationMeta({ title: 'My Chart' }, execResult)
    expect(meta.mcpApp).toBeDefined()
    expect(meta.mcpApp.sessionToken).toBe(execResult._sessionToken)
    expect(meta.mcpApp.serverName).toBe('analytics')
    expect(meta.mcpApp.rawToolName).toBe('render_chart')
    expect(meta.mcpApp.resourceUri).toBe('ui://charts/app')
    expect(meta.mcpApp.result).toEqual({
      content: [{ type: 'text', text: 'Hello chart' }],
      structuredContent: { data: [1, 2, 3] },
    })
    expect((meta.mcpApp.result as any)._sessionToken).toBeUndefined()
  })

  it('does not register app-only tools with ctx.tools for the LLM', () => {
    const registered: any[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def)
        return vi.fn()
      }),
    }

    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const mockClient = {} as unknown as Parameters<ServerToolManager['syncServerTools']>[1]

    const tools: Tool[] = [
      {
        name: 'app_secret_button',
        description: 'Only UI can call',
        inputSchema: { type: 'object' },
        _meta: { ui: { visibility: ['app'] } },
      },
      {
        name: 'model_and_app_tool',
        description: 'Both can use',
        inputSchema: { type: 'object' },
        _meta: { ui: { visibility: ['model', 'app'] } },
      },
      {
        name: 'regular_tool',
        description: 'Default visibility',
        inputSchema: { type: 'object' },
      },
    ]

    manager.syncServerTools('test-srv', mockClient, tools, {
      transport: 'stdio',
      command: 'srv',
      allowAppToolCalls: true,
    })

    const registeredNames = registered.map(r => r.name)
    expect(registeredNames).toContain('mcp__test-srv__model_and_app_tool')
    expect(registeredNames).toContain('mcp__test-srv__regular_tool')
    expect(registeredNames).not.toContain('mcp__test-srv__app_secret_button')
  })

  it('cleans up app-only tool from uiTools when removed on re-sync and on evictServer', () => {
    const mockToolsService = { register: vi.fn(() => vi.fn()) }
    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)

    const appOnlyTool: Tool = {
      name: 'app_secret_button',
      inputSchema: { type: 'object' },
      _meta: {
        ui: {
          resourceUri: 'ui://test/secret',
          visibility: ['app'],
        },
      },
    }
    const regularUiTool: Tool = {
      name: 'chart',
      inputSchema: { type: 'object' },
      _meta: {
        ui: {
          resourceUri: 'ui://test/chart',
        },
      },
    }

    manager.syncServerTools('test-srv', {} as any, [appOnlyTool, regularUiTool], {
      transport: 'stdio',
      command: 'srv',
      allowAppToolCalls: true,
    })

    let snapshot = manager.getUiToolsSnapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map(t => t.rawName)).toEqual(expect.arrayContaining(['app_secret_button', 'chart']))

    // 1. Re-sync without app_secret_button
    manager.syncServerTools('test-srv', {} as any, [regularUiTool], {
      transport: 'stdio',
      command: 'srv',
      allowAppToolCalls: true,
    })
    snapshot = manager.getUiToolsSnapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].rawName).toBe('chart')

    // 2. Re-add app_secret_button and evictServer
    manager.syncServerTools('test-srv', {} as any, [appOnlyTool], {
      transport: 'stdio',
      command: 'srv',
      allowAppToolCalls: true,
    })
    expect(manager.getUiToolsSnapshot()).toHaveLength(1)
    expect(manager.getUiToolsSnapshot()[0].rawName).toBe('app_secret_button')

    manager.evictServer('test-srv')
    expect(manager.getUiToolsSnapshot()).toHaveLength(0)
  })

  it('skips a bad tool mid-list without failing remaining tools', () => {
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return vi.fn()
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    const tools: Tool[] = [
      { name: 'tool_one', inputSchema: { type: 'object' } },
      {
        name: 'bad_tool',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'https://invalid-non-ui-scheme.com' } },
      },
      { name: 'tool_three', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, tools)
    expect(registered).toContain('mcp__test-srv__tool_one')
    expect(registered).not.toContain('mcp__test-srv__bad_tool')
    expect(registered).toContain('mcp__test-srv__tool_three')
  })

  it('re-registers tools whose definition changed and retains unchanged ones', () => {
    const disposed: string[] = []
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return () => disposed.push(def.name)
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    const initialTools: Tool[] = [
      { name: 'stable_tool', description: 'v1', inputSchema: { type: 'object' } },
      { name: 'changing_tool', description: 'v1', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, initialTools)
    expect(registered).toHaveLength(2)

    const updatedTools: Tool[] = [
      { name: 'stable_tool', description: 'v1', inputSchema: { type: 'object' } },
      { name: 'changing_tool', description: 'v2 modified', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, updatedTools)
    expect(disposed).toContain('mcp__test-srv__changing_tool')
    expect(disposed).not.toContain('mcp__test-srv__stable_tool')
  })

  it('detects duplicate public names and generates unique names with hash suffix', () => {
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return vi.fn()
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    const tools: Tool[] = [
      { name: 'duplicate_tool', inputSchema: { type: 'object' } },
      { name: 'duplicate_tool', inputSchema: { type: 'object' } },
    ]
    manager.syncServerTools('srv', {} as any, tools)

    expect(registered).toHaveLength(2)
    expect(registered[0]).not.toEqual(registered[1])
  })

  it('drops out-of-order tool refresh responses so the newest list wins', async () => {
    const syncSpy = vi.fn()
    const mockToolManager = {
      syncServerTools: syncSpy,
      getUiToolsSnapshot: () => [],
      evictServer: vi.fn(),
    } as any

    const pool = new ServerPool({} as any, { servers: {} }, mockToolManager)

    let resolveFirst!: (value: any) => void
    const firstCallPromise = new Promise(resolve => { resolveFirst = resolve })

    const mockClient = {
      listTools: vi.fn()
        .mockImplementationOnce(() => firstCallPromise)
        .mockImplementationOnce(async () => ({ tools: [{ name: 'v2_tool', inputSchema: {} }] })),
      setNotificationHandler: vi.fn(),
    } as any
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const p1 = (pool as any).refreshTools('srv', mockClient)
    const p2 = (pool as any).refreshTools('srv', mockClient)

    await p2
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenLastCalledWith('srv', mockClient, [{ name: 'v2_tool', inputSchema: {} }], undefined)

    resolveFirst({ tools: [{ name: 'v1_tool', inputSchema: {} }] })
    await p1

    expect(syncSpy).toHaveBeenCalledTimes(1)
  })
})
