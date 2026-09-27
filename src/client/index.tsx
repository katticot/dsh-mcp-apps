import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { McpAppToolView, type UiToolInfo } from './McpAppToolView'

export const inject = ['connection', 'slots']

export type ToolViewSlotProps = ToolCallViewProps

interface ClientSlots {
  inject: (name: string, callback: () => () => void) => () => void
  register: (
    descriptor: { name: string; key: string },
    component: (props: ToolCallViewProps) => React.ReactElement
  ) => () => void
}

type ClientContext = Pick<Context, 'effect'> & {
  connection: ConnectionHandle
  slots: ClientSlots
}

interface RegisteredView {
  fingerprint: string
  dispose: () => void
}

const DISCOVERY_INTERVAL_MS = 5_000

export function apply(ctx: ClientContext) {
  const connection = ctx.connection
  const registeredViews = new Map<string, RegisteredView>()
  let active = true
  let inFlight = false
  let discoveryRequested = false

  const unregisterView = (name: string) => {
    const view = registeredViews.get(name)
    if (!view) return
    try {
      view.dispose()
    } catch {
      // A view may already have been retired by its slot owner.
    }
    registeredViews.delete(name)
  }

  const syncTools = async (retryAfterInFlight = false) => {
    if (!active) return
    if (inFlight) {
      if (retryAfterInFlight) discoveryRequested = true
      return
    }

    inFlight = true
    try {
      const result = await connection.rpc.call('/mcp-apps', 'tools/list-ui', null)
      if (!active || !result.ok || !Array.isArray(result.value)) return

      const currentTools = new Map<string, UiToolInfo>()
      for (const candidate of result.value) {
        const tool = parseUiTool(candidate)
        if (tool) currentTools.set(tool.publicName, tool)
      }

      for (const name of registeredViews.keys()) {
        if (!currentTools.has(name)) unregisterView(name)
      }

      for (const [name, tool] of currentTools) {
        const fingerprint = JSON.stringify([tool.rawName, tool.resourceUri, tool.serverName])
        const registered = registeredViews.get(name)
        if (registered?.fingerprint === fingerprint) continue
        if (registered) unregisterView(name)

        const dispose = ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => {
          return ctx.slots.register({
            name: 'tool.call.toolview',
            key: tool.publicName,
          }, (props: ToolCallViewProps) => (
            <McpAppToolView
              {...props}
              tool={tool}
              connection={connection}
            />
          ))
        }), `mcp-apps: ${tool.publicName} view`)

        registeredViews.set(name, { fingerprint, dispose })
      }
    } catch (err) {
      if (active) console.error('mcp-apps: client initialization error:', err)
    } finally {
      inFlight = false
      if (active && discoveryRequested) {
        discoveryRequested = false
        void syncTools()
      }
    }
  }

  // The public generation observer covers first readiness and reconnects. A
  // bounded poll discovers server additions/removals because the host event
  // bus is not transported into the browser runtime.
  void syncTools()
  const unlistenGeneration = connection.generation.subscribe(() => {
    void syncTools(true)
  })
  const interval = setInterval(() => {
    void syncTools()
  }, DISCOVERY_INTERVAL_MS)

  const dispose = () => {
    if (!active) return
    active = false
    discoveryRequested = false
    clearInterval(interval)
    unlistenGeneration()
    for (const name of registeredViews.keys()) unregisterView(name)
    registeredViews.clear()
  }

  return ctx.effect(() => dispose, 'mcp-apps: UI tool discovery')
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
