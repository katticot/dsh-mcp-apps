import React from 'react'
import { McpAppToolView, type ClientConnectionRpc, type McpAppToolViewProps, type UiToolInfo } from './McpAppToolView'

export const inject = ['connection', 'slots']

export type ToolViewSlotProps = Omit<McpAppToolViewProps, 'tool' | 'connection'>

interface ClientContext {
  connection: ClientConnectionRpc
  slots: {
    inject: (name: string, callback: () => () => void) => () => void
    register: (descriptor: { name: string; key: string }, component: (props: ToolViewSlotProps) => React.ReactElement) => () => void
  }
  effect: (callback: () => void | (() => void), name?: string) => void
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void
}

export function apply(ctx: ClientContext) {
  const connection = ctx.connection
  const viewDisposers = new Map<string, () => void>()

  const syncTools = async () => {
    try {
      const result = await connection.rpc.call('/mcp-apps', 'tools/list-ui', null)
      if (!result.ok) {
        console.warn('mcp-apps: failed to fetch UI tools from host:', result.error.message)
        return
      }

      if (!Array.isArray(result.value)) return

      const currentTools = new Map<string, UiToolInfo>()
      for (const candidate of result.value) {
        const tool = parseUiTool(candidate)
        if (tool) currentTools.set(tool.publicName, tool)
      }

      // Unregister views for tools that are no longer present
      for (const [name, disposer] of viewDisposers.entries()) {
        if (!currentTools.has(name)) {
          try {
            disposer()
          } catch {
            // Ignored
          }
          viewDisposers.delete(name)
        }
      }

      // Register views for newly discovered tools
      for (const [name, tool] of currentTools.entries()) {
        if (viewDisposers.has(name)) continue

        let unregisterSlot: (() => void) | undefined
        ctx.effect(() => {
          unregisterSlot = ctx.slots.inject('tool.call.toolview', () => {
            return ctx.slots.register({
              name: 'tool.call.toolview',
              key: tool.publicName,
            }, (props: ToolViewSlotProps) => (
              <McpAppToolView
                {...props}
                tool={tool}
                connection={connection}
              />
            ))
          })
          return unregisterSlot
        }, `mcp-apps: ${tool.publicName} view`)

        if (unregisterSlot) {
          viewDisposers.set(name, unregisterSlot)
        } else {
          viewDisposers.set(name, () => {})
        }
      }
    } catch (err) {
      console.error('mcp-apps: client initialization error:', err)
    }
  }

  void syncTools()

  // Host-pushed ui-tools/changed event and connection reset listeners
  let unlistenReset: (() => void) | undefined
  let unlistenChanged: (() => void) | undefined

  if (typeof ctx.on === 'function') {
    unlistenReset = ctx.on('connection/reset', () => {
      void syncTools()
    })
    unlistenChanged = ctx.on('ui-tools/changed', () => {
      void syncTools()
    })
  }

  // Safety retries for delayed server connections
  const t1 = setTimeout(() => { void syncTools() }, 3000)
  const t2 = setTimeout(() => { void syncTools() }, 8000)

  // Disposer on client plugin unload
  return () => {
    clearTimeout(t1)
    clearTimeout(t2)
    unlistenReset?.()
    unlistenChanged?.()
    for (const disposer of viewDisposers.values()) {
      try {
        disposer()
      } catch {
        // Ignored
      }
    }
    viewDisposers.clear()
  }
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
