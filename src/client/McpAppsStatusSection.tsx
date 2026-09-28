import React, { useEffect, useMemo, useState } from 'react'
import type { ClientConnectionRpc } from './McpAppToolView'

export type ToolVisibility = 'model' | 'app' | 'both'

export interface ToolSummary {
  rawName: string
  publicName: string
  visibility: ToolVisibility
  hasUi: boolean
}

export interface ServerStatus {
  name: string
  transport: string
  connected: boolean
  toolCount: number
  uiToolCount: number
  lastError?: string
  tools?: ToolSummary[]
}

export interface McpAppsStatusSectionProps {
  connection: ClientConnectionRpc
  /** Fires on `ui-tools/changed` and `connection/reset` so the section can refresh; optional so this can be unit-tested without a full client context. */
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void
}

const VALID_VISIBILITIES = new Set<ToolVisibility>(['model', 'app', 'both'])

function parseToolSummary(value: unknown): ToolSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.rawName !== 'string' ||
    typeof item.publicName !== 'string' ||
    typeof item.visibility !== 'string' ||
    !VALID_VISIBILITIES.has(item.visibility as ToolVisibility) ||
    typeof item.hasUi !== 'boolean'
  ) {
    return null
  }
  return {
    rawName: item.rawName,
    publicName: item.publicName,
    visibility: item.visibility as ToolVisibility,
    hasUi: item.hasUi,
  }
}

function parseServerStatus(value: unknown): ServerStatus | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.name !== 'string' ||
    typeof item.transport !== 'string' ||
    typeof item.connected !== 'boolean' ||
    typeof item.toolCount !== 'number' ||
    typeof item.uiToolCount !== 'number'
  ) {
    return null
  }
  // Malformed entries are dropped individually rather than rejecting the
  // whole `tools` array (and thus the whole server), since this is a
  // best-effort read-only display, not a validated protocol boundary.
  const tools = Array.isArray(item.tools)
    ? item.tools.map(parseToolSummary).filter((t): t is ToolSummary => t !== null)
    : undefined
  return {
    name: item.name,
    transport: item.transport,
    connected: item.connected,
    toolCount: item.toolCount,
    uiToolCount: item.uiToolCount,
    lastError: typeof item.lastError === 'string' ? item.lastError : undefined,
    tools,
  }
}

const VISIBILITY_GROUPS: { key: ToolVisibility; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'app', label: 'App-only' },
  { key: 'both', label: 'Both' },
]

/**
 * Scoped, self-contained styles for the bits inline styles can't express
 * (pseudo-classes, keyframes, media queries). Rendered once alongside the
 * section; harmless if it ends up in the DOM more than once since the rules
 * are static and idempotent.
 */
const STYLE_CSS = `
@keyframes dshMcpAppsStatusSkeletonPulse {
  0% { opacity: 1; }
  40% { opacity: 0.6; }
  80%, 100% { opacity: 1; }
}
.mcpAppsStatusSkeletonBlock {
  animation: dshMcpAppsStatusSkeletonPulse 2s cubic-bezier(0.36, 0, 0.64, 1) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .mcpAppsStatusSkeletonBlock {
    animation: none;
  }
}
.mcpAppsStatusRowButton {
  all: unset;
  box-sizing: border-box;
}
.mcpAppsStatusRowButton:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #2563eb);
  outline-offset: 1px;
}
.mcpAppsStatusChevron {
  transition: transform 150ms ease;
  transform: rotate(0deg);
}
.mcpAppsStatusChevron[data-expanded='true'] {
  transform: rotate(180deg);
}
@media (prefers-reduced-motion: reduce) {
  .mcpAppsStatusChevron {
    transition: none;
  }
}
.mcpAppsStatusFilterInput:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #2563eb);
  outline-offset: 1px;
}
`

/**
 * Read-only list of the MCP servers this plugin hosts: name, transport,
 * connection state, and tool counts. Never renders `command`, `args`,
 * `env`, `headers`, or `url` — the host RPC (`servers/status`) doesn't send
 * them in the first place. Each row can be expanded to reveal the
 * individual tool names it exposes, grouped by visibility; `tools` never
 * carries a tool's `description` or `inputSchema` either.
 */
export function McpAppsStatusSection({ connection, on }: McpAppsStatusSectionProps) {
  const [servers, setServers] = useState<ServerStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let active = true

    const refresh = async () => {
      try {
        const res = await connection.rpc.call('/api', 'mcp-apps/servers/status', null)
        if (!active) return
        if (!res.ok) {
          setError(res.error.message)
          return
        }
        if (!Array.isArray(res.value)) return
        const parsed = res.value.map(parseServerStatus).filter((s): s is ServerStatus => s !== null)
        setServers(parsed)
        setError(null)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    }

    void refresh()

    let unlistenReset: (() => void) | undefined
    let unlistenChanged: (() => void) | undefined
    if (typeof on === 'function') {
      unlistenReset = on('connection/reset', () => { void refresh() })
      unlistenChanged = on('ui-tools/changed', () => { void refresh() })
    }

    return () => {
      active = false
      unlistenReset?.()
      unlistenChanged?.()
    }
  }, [connection, on])

  const toggleExpanded = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  if (error) {
    return (
      <div style={{ ...SECTION_STYLE, padding: 12, color: 'var(--dsw-alias-state-error-primary, #b42318)' }} role="alert">
        {error}
      </div>
    )
  }

  if (!servers) {
    return (
      <div style={SECTION_STYLE} aria-busy="true" aria-live="polite">
        <style>{STYLE_CSS}</style>
        <span style={VISUALLY_HIDDEN_STYLE}>Loading MCP server status…</span>
        <SkeletonRow />
        <SkeletonRow />
      </div>
    )
  }

  if (servers.length === 0) {
    return <div style={SECTION_STYLE}>No MCP servers configured.</div>
  }

  return (
    <div style={SECTION_STYLE} data-mcp-apps-status>
      <style>{STYLE_CSS}</style>
      {servers.map(server => (
        <ServerRow
          key={server.name}
          server={server}
          isExpanded={expanded.has(server.name)}
          onToggle={() => toggleExpanded(server.name)}
        />
      ))}
    </div>
  )
}

function SkeletonRow() {
  return (
    <div style={SKELETON_ROW_STYLE} aria-hidden="true">
      <span className="mcpAppsStatusSkeletonBlock" style={{ ...SKELETON_BLOCK_STYLE, width: 8, height: 8, borderRadius: '50%' }} />
      <span className="mcpAppsStatusSkeletonBlock" style={{ ...SKELETON_BLOCK_STYLE, width: 96, height: 12 }} />
      <span className="mcpAppsStatusSkeletonBlock" style={{ ...SKELETON_BLOCK_STYLE, width: 48, height: 10 }} />
      <span className="mcpAppsStatusSkeletonBlock" style={{ ...SKELETON_BLOCK_STYLE, width: 64, height: 10 }} />
    </div>
  )
}

/** Splits `text` around the first case-insensitive occurrence of `needle`, highlighting the match. Plain substring search (indexOf/slice) — never a user-supplied RegExp — so pathological filter input can't cause catastrophic backtracking. */
function highlightMatch(text: string, needle: string): React.ReactNode {
  const trimmed = needle.trim()
  if (trimmed === '') return text
  const idx = text.toLowerCase().indexOf(trimmed.toLowerCase())
  if (idx === -1) return text
  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + trimmed.length)
  const after = text.slice(idx + trimmed.length)
  return (
    <>
      {before}
      <mark style={MARK_STYLE}>{match}</mark>
      {after}
    </>
  )
}

function ServerRow({ server, isExpanded, onToggle }: { server: ServerStatus; isExpanded: boolean; onToggle: () => void }) {
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => {
    const tools = server.tools ?? []
    const normalizedFilter = filter.trim().toLowerCase()
    const matches = (tool: ToolSummary) => normalizedFilter === '' || tool.rawName.toLowerCase().includes(normalizedFilter)
    return VISIBILITY_GROUPS.map(group => ({
      ...group,
      tools: tools.filter(t => t.visibility === group.key && matches(t)),
    })).filter(group => group.tools.length > 0)
  }, [server.tools, filter])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Handle activation explicitly (rather than relying on the browser's
    // native Enter/Space-activates-button behavior) so this is reliably
    // testable and so Space never scrolls the page. preventDefault also
    // suppresses the native synthetic click the browser would otherwise
    // fire for these keys, avoiding a double toggle.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <div data-mcp-apps-status-row={server.name}>
      <button
        type="button"
        className="mcpAppsStatusRowButton"
        style={ROW_STYLE}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        aria-expanded={isExpanded}
        title="Click to expand or collapse tool list"
      >
        <ConnectionPill connected={server.connected} />
        <span style={{ fontWeight: 600 }}>{server.name}</span>
        <span style={TRANSPORT_CHIP_STYLE}>{server.transport}</span>
        <span style={MUTED_TEXT_STYLE}>
          {server.toolCount} tools ({server.uiToolCount} UI)
        </span>
        {server.lastError ? (
          <span style={ERROR_TEXT_STYLE} title={server.lastError}>
            {server.lastError}
          </span>
        ) : null}
        <ChevronIcon expanded={isExpanded} />
      </button>
      {isExpanded ? (
        <div style={DETAIL_STYLE} data-mcp-apps-status-detail={server.name}>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter tools…"
            style={FILTER_INPUT_STYLE}
            className="mcpAppsStatusFilterInput"
            aria-label={`Filter tools for ${server.name}`}
          />
          {groups.length === 0 ? (
            <div style={{ fontSize: 11, ...MUTED_TEXT_STYLE, padding: '4px 0' }}>No matching tools.</div>
          ) : (
            groups.map(group => (
              <div key={group.key} style={{ marginTop: 6 }}>
                <div style={GROUP_HEADER_STYLE}>
                  {group.label} ({group.tools.length})
                </div>
                <div style={CHIP_ROW_STYLE}>
                  {group.tools.map(tool => (
                    <span key={tool.publicName} style={TOOL_CHIP_STYLE}>
                      {highlightMatch(tool.rawName, filter)}
                      {tool.hasUi ? <span style={UI_BADGE_STYLE}> (UI)</span> : null}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function ConnectionPill({ connected }: { connected: boolean }) {
  const color = connected
    ? 'var(--dsw-alias-state-success-primary, #059669)'
    : 'var(--dsw-alias-state-error-primary, #b42318)'
  return (
    <span style={{ ...PILL_STYLE, color }}>
      <span aria-hidden style={{ ...DOT_STYLE, background: color }} />
      {connected ? 'Connected' : 'Disconnected'}
    </span>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="mcpAppsStatusChevron"
      data-expanded={expanded}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ marginLeft: 'auto', flex: '0 0 auto', color: 'inherit' }}
    >
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const SECTION_STYLE: React.CSSProperties = {
  overflow: 'hidden',
  width: '100%',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  borderRadius: 'var(--dsw-radius-md, 12px)',
  background: 'color-mix(in srgb, currentColor 3%, transparent)',
  padding: 8,
  fontSize: 12,
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  width: '100%',
  boxSizing: 'border-box',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08))',
  cursor: 'pointer',
  userSelect: 'none',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
}

const PILL_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 'var(--dsw-radius-sm, 999px)',
  fontSize: 11,
  fontWeight: 600,
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
  flex: '0 0 auto',
}

const DOT_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  flex: '0 0 auto',
}

const TRANSPORT_CHIP_STYLE: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.6))',
  flex: '0 0 auto',
}

const MUTED_TEXT_STYLE: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.6))',
  fontSize: 11,
}

const ERROR_TEXT_STYLE: React.CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #b42318)',
  fontSize: 11,
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const DETAIL_STYLE: React.CSSProperties = {
  padding: '6px 8px 8px 24px',
  borderBottom: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08))',
}

const FILTER_INPUT_STYLE: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 6px',
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2))',
  background: 'transparent',
  color: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
}

const GROUP_HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.7))',
}

const CHIP_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  margin: '2px 0 0',
  padding: 0,
}

const TOOL_CHIP_STYLE: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 'var(--dsw-radius-sm, 999px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  background: 'color-mix(in srgb, currentColor 4%, transparent)',
}

const UI_BADGE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.6))',
}

const MARK_STYLE: React.CSSProperties = {
  background: 'color-mix(in srgb, currentColor 25%, transparent)',
  color: 'inherit',
  fontWeight: 700,
  borderRadius: 2,
}

const SKELETON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
}

const SKELETON_BLOCK_STYLE: React.CSSProperties = {
  display: 'inline-block',
  background: 'var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.08))',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
}

const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
