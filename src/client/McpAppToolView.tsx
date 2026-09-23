import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport, buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge'
import { withContentSecurityPolicy } from './csp'

export interface ClientConnectionRpc {
  rpc: {
    call: (
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal
    ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
  }
}

export interface UiToolInfo {
  publicName: string
  rawName: string
  resourceUri: string
  serverName?: string
}

export interface McpAppToolViewProps {
  tool: UiToolInfo
  connection: ClientConnectionRpc
  block: {
    kind?: string
    call?: { argsRaw?: string } | null
    argsRaw?: string
    meta?: unknown
  }
  useDisclosure?: () => [boolean, (open: boolean) => void]
}

interface SettledAppCall {
  serverName: string
  rawToolName: string
  resourceUri: string
  sessionToken?: string
  arguments: Record<string, unknown>
  result: unknown
}

interface ResourceData {
  uri: string
  html: string
  csp?: Record<string, string[]>
  permissions?: Record<string, string[]>
}

/**
 * Custom transport for AppBridge that attaches window.addEventListener('message')
 * immediately and buffers incoming messages from the target iframe until
 * bridge.connect() completes and onmessage is ready.
 */
class ResilientPostMessageTransport {
  private targetWindow: Window | null = null
  private messageListener: (event: MessageEvent) => void
  private earlyQueue: unknown[] = []
  private isStarted = false

  public onmessage?: (message: unknown) => void
  public onerror?: (error: Error) => void
  public onclose?: () => void
  public sessionId?: string

  constructor(targetWindow: Window | null) {
    this.targetWindow = targetWindow

    this.messageListener = (event: MessageEvent) => {
      // If targetWindow is set, verify event.source matches the iframe
      if (this.targetWindow && event.source !== this.targetWindow) {
        return
      }

      const data = event.data
      if (typeof data !== 'object' || data === null || (data as { jsonrpc?: string }).jsonrpc !== '2.0') {
        return
      }

      if (this.isStarted && this.onmessage) {
        this.onmessage(data)
      } else {
        this.earlyQueue.push(data)
      }
    }

    window.addEventListener('message', this.messageListener)
  }

  setTarget(target: Window) {
    this.targetWindow = target
  }

  async start(): Promise<void> {
    this.isStarted = true
    while (this.earlyQueue.length > 0) {
      const msg = this.earlyQueue.shift()
      if (this.onmessage) {
        this.onmessage(msg)
      }
    }
  }

  async send(message: unknown): Promise<void> {
    if (!this.targetWindow) {
      console.warn('mcp-apps: Cannot postMessage - target window is not available')
      return
    }
    this.targetWindow.postMessage(message, '*')
  }

  async close(): Promise<void> {
    this.isStarted = false
    this.earlyQueue = []
    window.removeEventListener('message', this.messageListener)
    this.onclose?.()
  }
}

export function McpAppToolView({ tool, connection, block, useDisclosure }: McpAppToolViewProps) {
  const disclosureState = useDisclosure ? useDisclosure() : null
  const [localExpanded, setLocalExpanded] = useState(true)
  const isExpanded = disclosureState ? disclosureState[0] : localExpanded

  const toggleExpanded = () => {
    if (disclosureState) {
      disclosureState[1](!disclosureState[0])
    } else {
      setLocalExpanded(!localExpanded)
    }
  }

  const call = useMemo(() => resolveSettledAppCall(block, tool), [block, tool])
  const [resource, setResource] = useState<ResourceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState<number>(360)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 1. Fetch UI HTML resource once settled call is available
  useEffect(() => {
    if (!call) return
    const controller = new AbortController()

    connection.rpc.call(
      '/mcp-apps',
      'resources/read',
      { uri: call.resourceUri, server: call.serverName },
      controller.signal
    ).then((res) => {
      if (!res.ok) throw new Error(res.error.message)
      setResource(res.value as ResourceData)
    }).catch((err) => {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

    return () => controller.abort()
  }, [call, connection])

  // 2. Connect AppBridge via ResilientPostMessageTransport on iframe mount
  useEffect(() => {
    if (!call || !resource) return
    const iframe = iframeRef.current
    if (!iframe) return

    let bridge: AppBridge | null = null
    let transport: ResilientPostMessageTransport | null = null
    let disposed = false

    let lastHeight = 360
    let resizeCounter = 0
    let circuitBreakerTripped = false
    let resetTimer: NodeJS.Timeout | null = null

    const initBridge = async () => {
      const contentWindow = iframe.contentWindow
      if (!contentWindow || disposed) return

      transport = new ResilientPostMessageTransport(contentWindow)
      bridge = new AppBridge(null, {
        name: 'DeepSeek Harness',
        version: '0.1.0',
      }, {
        serverTools: {},
        serverResources: {},
      })

      // Reverse tool calling: UI calls a host tool
      bridge.oncalltool = async (params, extra) => {
        const res = await connection.rpc.call('/mcp-apps', 'tools/call', {
          sessionToken: call.sessionToken,
          server: call.serverName,
          name: params.name,
          arguments: params.arguments ?? {},
        }, extra?.signal)
        if (!res.ok) throw new Error(res.error.message)
        return res.value as never
      }

      bridge.onlistresources = async (_params, extra) => {
        const res = await connection.rpc.call('/mcp-apps', 'resources/list', {
          server: call.serverName,
        }, extra?.signal)
        if (!res.ok) throw new Error(res.error.message)
        return res.value as never
      }

      bridge.onreadresource = async (params, extra) => {
        const res = await connection.rpc.call('/mcp-apps', 'resources/read', {
          server: call.serverName,
          uri: params.uri,
        }, extra?.signal)
        if (!res.ok) throw new Error(res.error.message)
        return res.value as never
      }

      // Resize defense: hysteresis deadband, bounding clamp, 10Hz throttle, circuit breaker
      bridge.onsizechange = (params) => {
        if (circuitBreakerTripped || typeof params.height !== 'number') return
        resizeCounter++
        if (resizeCounter > 30) {
          circuitBreakerTripped = true
          console.warn('mcp-apps: Resize circuit breaker tripped! Muting resize.')
          resetTimer = setTimeout(() => {
            circuitBreakerTripped = false
            resizeCounter = 0
          }, 10000)
          return
        }

        const clamped = Math.max(160, Math.min(Math.round(params.height), 1200))
        if (Math.abs(clamped - lastHeight) >= 6) {
          lastHeight = clamped
          requestAnimationFrame(() => {
            if (!disposed) setHeight(clamped)
          })
        }
      }

      bridge.oninitialized = () => {
        if (!disposed && bridge) {
          bridge.sendToolInput({ arguments: call.arguments })
            .then(() => {
              if (call.result) {
                const resPayload = (typeof call.result === 'object' && call.result !== null)
                  ? (call.result as Record<string, unknown>)
                  : { content: [{ type: 'text', text: String(call.result ?? '') }] }
                void bridge?.sendToolResult(resPayload as never)
              }
            })
            .catch((err) => console.warn('mcp-apps: error sending tool input/result', err))
        }
      }

      try {
        await bridge.connect(transport)
      } catch (err) {
        console.error('mcp-apps: bridge.connect failed', err)
      }
    }

    // Connect immediately without waiting for load event or touching cross-origin contentDocument
    void initBridge()

    return () => {
      disposed = true
      if (resetTimer) clearTimeout(resetTimer)
      if (bridge) {
        bridge.teardownResource({}).catch(() => void 0)
      }
      if (transport) {
        void transport.close()
      }
    }
  }, [call, resource, connection])

  // 3. Keep enclosing TurnProcess open for MCP Apps so interactive dashboard doesn't fold away
  useEffect(() => {
    if (!resource) return
    const iframe = iframeRef.current
    if (!iframe) return

    let active = true

    const revealTurnProcess = () => {
      if (!active) return

      // Find any ancestor with hidden attribute (applied by DSH useSearchableHidden)
      let el: HTMLElement | null = iframe
      while (el && el !== document.body) {
        if (el.hasAttribute('hidden')) {
          el.dispatchEvent(new Event('beforematch'))
          el.removeAttribute('hidden')
        }
        el = el.parentElement
      }

      // Check for closed TurnProcess accordion buttons in the document
      const closedButtons = document.querySelectorAll<HTMLButtonElement>('button[data-turn-process]:not([data-open])')
      for (const btn of closedButtons) {
        btn.click()
      }
    }

    // Run reveal initially and at key turn-settlement intervals
    revealTurnProcess()
    const t1 = setTimeout(revealTurnProcess, 300)
    const t2 = setTimeout(revealTurnProcess, 800)
    const t3 = setTimeout(revealTurnProcess, 1500)
    const t4 = setTimeout(revealTurnProcess, 2500)

    // Stop auto-expansion after 3.5s so we don't fight intentional user collapse later
    const tStop = setTimeout(() => {
      active = false
      observer.disconnect()
    }, 3500)

    const observer = new MutationObserver(() => {
      revealTurnProcess()
    })

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['hidden', 'data-open', 'aria-expanded'],
      subtree: true,
    })

    return () => {
      active = false
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      clearTimeout(t4)
      clearTimeout(tStop)
      observer.disconnect()
    }
  }, [resource])

  if (!call) {
    return (
      <div style={CARD_STYLE} data-mcp-app-tool={tool.rawName}>
        Waiting for MCP App result…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ ...CARD_STYLE, padding: 12, color: '#b42318' }} role="alert">
        {error}
      </div>
    )
  }

  if (!resource) {
    return (
      <div style={CARD_STYLE} data-mcp-app-tool={tool.rawName}>
        Loading MCP App…
      </div>
    )
  }

  const htmlWithCsp = withContentSecurityPolicy(resource.html, resource.csp, resource.permissions)
  const allowAttr = typeof buildAllowAttribute === 'function' ? buildAllowAttribute(resource.permissions) : undefined

  return (
    <div style={CARD_STYLE} data-mcp-app-tool={tool.rawName}>
      <div
        style={{
          ...TITLE_STYLE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={toggleExpanded}
        title="Click to expand or collapse MCP App"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{tool.rawName}</span>
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 8,
              background: 'rgba(16, 185, 129, 0.15)',
              color: '#059669',
              fontWeight: 500,
            }}
          >
            Interactive App
          </span>
        </div>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {isExpanded ? 'Collapse ▲' : 'Expand ▼'}
        </span>
      </div>
      <div
        style={{
          height: isExpanded ? `${height}px` : '0px',
          visibility: isExpanded ? 'visible' : 'hidden',
          contain: 'strict',
          overflow: 'hidden',
          transition: 'height 0.15s ease',
        }}
      >
        <iframe
          ref={iframeRef}
          title={`${tool.rawName} MCP App`}
          sandbox="allow-scripts allow-forms allow-downloads"
          allow={allowAttr || undefined}
          srcDoc={htmlWithCsp}
          style={{
            display: 'block',
            width: '100%',
            minHeight: '160px',
            height: `${height}px`,
            border: 0,
            background: 'transparent',
          }}
        />
      </div>
    </div>
  )
}

function resolveSettledAppCall(block: McpAppToolViewProps['block'], tool: UiToolInfo): SettledAppCall | null {
  const meta = block.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const app = (meta as { mcpApp?: unknown }).mcpApp
  if (typeof app !== 'object' || app === null || Array.isArray(app)) return null

  const info = app as {
    serverName?: string
    rawToolName?: string
    resourceUri?: string
    sessionToken?: string
    result?: unknown
  }

  if (info.rawToolName !== tool.rawName || info.resourceUri !== tool.resourceUri) return null

  let args: Record<string, unknown> = {}
  try {
    const raw = block.call?.argsRaw ?? block.argsRaw
    if (raw) {
      args = JSON.parse(raw) as Record<string, unknown>
    }
  } catch {
    // Malformed JSON args
  }

  return {
    serverName: info.serverName ?? tool.serverName ?? '',
    rawToolName: info.rawToolName,
    resourceUri: info.resourceUri,
    sessionToken: info.sessionToken,
    arguments: args,
    result: info.result,
  }
}

const CARD_STYLE: React.CSSProperties = {
  overflow: 'hidden',
  width: '100%',
  border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
  borderRadius: 12,
  background: 'color-mix(in srgb, currentColor 3%, transparent)',
}

const TITLE_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  font: '600 12px/1.4 system-ui, sans-serif',
  opacity: 0.72,
}
