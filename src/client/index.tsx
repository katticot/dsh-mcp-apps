import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { McpAppToolView, type UiToolInfo } from './McpAppToolView'
import { McpAppsStatusSection } from './McpAppsStatusSection'

export const inject = ['connection', 'slots']

/**
 * npm package name, as `PluginPackageRef.name` reports it on a bundle's
 * `plugins.detail.section` subject (see `package.json#name`). Deliberately
 * NOT the cordis plugin id exported as `name` from `../index` ("mcp-apps") —
 * the plugin manager keys bundles by npm package name, not by the cordis
 * service name a package happens to register.
 */
const PLUGIN_PACKAGE_NAME = 'dsh-mcp-apps'

export type ToolViewSlotProps = ToolCallViewProps

/**
 * Structural mirror of `PluginsSubject` from
 * `@deepseek-ai/dsh-client-ui-plugin-manager`'s `plugins.detail.section` slot
 * contract: what a bundle/row/official-plugin detail page is about. Kept
 * local (rather than importing the package) so this plugin has no hard
 * version dependency on the plugin manager's types — see the plan notes on
 * avoiding version churn against a fast-moving optional peer.
 */
type PluginsDetailSubject =
  | { kind: 'bundle'; pkg: { name: string } }
  | { kind: 'row'; pkg: { name: string }; row: unknown }
  | { kind: 'item'; id: string }

interface PluginDetailSectionProps {
  subject: PluginsDetailSubject
}

interface ClientSlots {
  inject: (name: string, callback: () => () => void) => () => void
  register: (
    descriptor: { name: string; key?: string; id?: string; order?: number; label?: string },
    component: (props: any) => React.ReactElement | null
  ) => () => void
}

type ClientContext = Pick<Context, 'effect'> & {
  connection: ConnectionHandle
  slots: ClientSlots
  /** Host-pushed event bus, used to refresh the status section promptly. */
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void
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
      const result = await connection.rpc.call('/api', 'mcp-apps/tools/list-ui', null)
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

  // Read-only server status section on this plugin's own bundle detail page.
  // `plugins.detail.section` is declared by the optional
  // `@deepseek-ai/dsh-client-ui-plugin-manager` peer (deliberately NOT listed
  // in this package's `dsh.client.inject` — see package.json). `slots.inject`
  // never throws for an undeclared slot: it defers via a declaration
  // subscription and simply never fires the callback if the slot is never
  // declared (plugin manager not installed), so this needs no guard — same
  // as the tool-view registration above.
  ctx.effect(() => {
    return ctx.slots.inject('plugins.detail.section', () => {
      return ctx.slots.register({ name: 'plugins.detail.section', id: 'mcp-apps-status', order: 0 }, (props: PluginDetailSectionProps) => {
        if (props.subject.kind !== 'bundle' || props.subject.pkg.name !== PLUGIN_PACKAGE_NAME) {
          return null
        }
        return <McpAppsStatusSection connection={connection} on={ctx.on} />
      })
    })
  }, 'mcp-apps: plugins.detail.section')

  // Host-pushed ui-tools/changed event and connection reset listeners, on
  // top of the generation-subscribe + interval poll above, for a faster
  // refresh when the host can tell us something changed.
  let unlistenReset: (() => void) | undefined
  let unlistenChanged: (() => void) | undefined

  if (typeof ctx.on === 'function') {
    unlistenReset = ctx.on('connection/reset', () => {
      void syncTools(true)
    })
    unlistenChanged = ctx.on('ui-tools/changed', () => {
      void syncTools(true)
    })
  }

  const dispose = () => {
    if (!active) return
    active = false
    discoveryRequested = false
    clearInterval(interval)
    unlistenGeneration()
    unlistenReset?.()
    unlistenChanged?.()
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
