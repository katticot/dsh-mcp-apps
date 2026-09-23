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
})
