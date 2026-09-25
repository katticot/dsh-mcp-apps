import { describe, it, expect, vi } from 'vitest'
import { ServerToolManager, publicToolName } from '../src/tool-manager'
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

    // Sync with allowAppToolCalls = true
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
    expect(session?.allowedReverseTools.has('model_secret_eval')).toBe(false) // model-only tool filtered out!

    // Clear and test with allowAppToolCalls = false / omitted
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
    expect(disabledSession?.allowedReverseTools.size).toBe(0) // completely empty
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
})
