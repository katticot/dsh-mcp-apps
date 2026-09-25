import React from 'react'
import { McpAppToolView, type ClientConnectionRpc, type UiToolInfo } from './McpAppToolView'

export const inject = ['connection', 'slots']

interface ClientContext {
  connection: ClientConnectionRpc
  slots: {
    inject: (name: string, callback: () => () => void) => () => void
    register: (descriptor: { name: string; key: string }, component: (props: unknown) => React.ReactElement) => () => void
  }
  effect: (callback: () => void | (() => void), name?: string) => void
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void
}

export function apply(ctx: ClientContext) {
  const connection = ctx.connection
  const registered = new Set<string>()

  const syncTools = async () => {
    try {
      const result = await connection.rpc.call('/mcp-apps', 'tools/list-ui', null)
      if (!result.ok) {
        console.warn('mcp-apps: failed to fetch UI tools from host:', result.error.message)
        return
      }

      if (!Array.isArray(result.value)) return

      for (const candidate of result.value) {
        const tool = parseUiTool(candidate)
        if (!tool || registered.has(tool.publicName)) continue
        registered.add(tool.publicName)

        ctx.effect(() => {
          return ctx.slots.inject('tool.call.toolview', () => {
            return ctx.slots.register({
              name: 'tool.call.toolview',
              key: tool.publicName,
            }, (props: unknown) => (
              <McpAppToolView
                {...(props as any)}
                tool={tool}
                connection={connection}
              />
            ))
          })
        }, `mcp-apps: ${tool.publicName} view`)
      }
    } catch (err) {
      console.error('mcp-apps: client initialization error:', err)
    }
  }

  // Initial sync (waits for host initial tool discovery)
  void syncTools()

  // Re-sync if connection resets
  if (typeof ctx.on === 'function') {
    ctx.on('connection/reset', () => {
      void syncTools()
    })
  }

  // Safety retries for delayed server connections
  setTimeout(() => { void syncTools() }, 3000)
  setTimeout(() => { void syncTools() }, 8000)
}

function parseUiTool(value: unknown): UiToolInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.publicName !== 'string' ||
    typeof item.rawName !== 'string' ||
    typeof item.resourceUri !== 'string' ||
    !item.resourceUri.startsWith('ui://')
  ) {
    return null
  }
  return {
    publicName: item.publicName,
    rawName: item.rawName,
    resourceUri: item.resourceUri,
    serverName: typeof item.serverName === 'string' ? item.serverName : undefined,
  }
}
