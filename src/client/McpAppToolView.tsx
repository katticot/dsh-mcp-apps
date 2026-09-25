import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  const disclosureState = useDisclosure?.() ?? null
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
  const sessionToken = call?.sessionToken
  const resourceUri = call?.resourceUri
  const argsRaw = block.call?.argsRaw ?? block.argsRaw
  const serverName = call?.serverName

  const [resource, setResource] = useState<ResourceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState<number>(360)
  const [activeSrcDoc, setActiveSrcDoc] = useState<string | null>(null)
  const [navCount, setNavCount] = useState<number>(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const connectionRef = useRef(connection)
  connectionRef.current = connection

  const bridgeRef = useRef<AppBridge | null>(null)
  const transportRef = useRef<ResilientPostMessageTransport | null>(null)
  const isInitializedRef = useRef(false)

  // Sliding window resize tracking
  const resizeTimestampsRef = useRef<number[]>([])
  const pendingHeightRef = useRef<number | null>(null)
  const resetTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Clear error and reset navigation counter when call targets change
  useEffect(() => {
    setError(null)
    setNavCount(0)
  }, [sessionToken, resourceUri, argsRaw])

  // 1. Fetch UI HTML resource once settled call parameters are available
  useEffect(() => {
    if (!sessionToken || !resourceUri) return
    const controller = new AbortController()

    connectionRef.current.rpc.call(
      '/mcp-apps',
      'resources/read',
      { uri: resourceUri, server: serverName },
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
  }, [sessionToken, resourceUri, serverName])

  const htmlWithCsp = useMemo(() => {
    if (!resource) return null
    return withContentSecurityPolicy(resource.html, resource.csp, resource.permissions)
  }, [resource])

  // 2. Establish bridge and transport via useLayoutEffect, delaying srcDoc assignment until ready
  useLayoutEffect(() => {
    if (!sessionToken || !htmlWithCsp) return
    const iframe = iframeRef.current
    if (!iframe) return

    const contentWindow = iframe.contentWindow
    if (!contentWindow) return

    if (transportRef.current) {
      void transportRef.current.close()
    }

    const transport = new ResilientPostMessageTransport(contentWindow)
    transportRef.current = transport

    const bridge = new AppBridge(null, {
      name: 'DeepSeek Harness',
      version: __PKG_VERSION__,
    }, {
      serverTools: {},
      serverResources: {},
    })
    bridgeRef.current = bridge
    isInitializedRef.current = false

    let lastHeight = 360
    let disposed = false

    bridge.oncalltool = async (params, extra) => {
      const res = await connectionRef.current.rpc.call('/mcp-apps', 'tools/call', {
        sessionToken,
        server: serverName,
        name: params.name,
        arguments: params.arguments ?? {},
      }, extra?.signal)
      if (!res.ok) throw new Error(res.error.message)
      return res.value as never
    }

    bridge.onlistresources = async (_params, extra) => {
      const res = await connectionRef.current.rpc.call('/mcp-apps', 'resources/list', {
        server: serverName,
      }, extra?.signal)
      if (!res.ok) throw new Error(res.error.message)
      return res.value as never
    }

    bridge.onreadresource = async (params, extra) => {
      const res = await connectionRef.current.rpc.call('/mcp-apps', 'resources/read-raw', {
        server: serverName,
        uri: params.uri,
      }, extra?.signal)
      if (!res.ok) throw new Error(res.error.message)
      return res.value as never
    }

    // Sliding-window resize defense: 1000ms window, max 10 events, flushes final height on unlock
    bridge.onsizechange = (params) => {
      if (typeof params.height !== 'number') return
      const now = Date.now()
      const windowMs = 1000
      const maxEvents = 10

      resizeTimestampsRef.current = resizeTimestampsRef.current.filter(t => now - t < windowMs)
      const clamped = Math.max(160, Math.min(Math.round(params.height), 1200))
      pendingHeightRef.current = clamped

      if (resizeTimestampsRef.current.length >= maxEvents) {
        if (!resetTimerRef.current) {
          const oldest = resizeTimestampsRef.current[0] ?? now
          const waitTime = Math.max(50, windowMs - (now - oldest))
          resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = null
            if (pendingHeightRef.current !== null && !disposed) {
              lastHeight = pendingHeightRef.current
              setHeight(pendingHeightRef.current)
            }
          }, waitTime)
        }
        return
      }

      resizeTimestampsRef.current.push(now)
      if (Math.abs(clamped - lastHeight) >= 6) {
        lastHeight = clamped
        requestAnimationFrame(() => {
          if (!disposed) setHeight(clamped)
        })
      }
    }

    bridge.oninitialized = () => {
      if (disposed) return
      isInitializedRef.current = true
      bridge.sendToolInput({ arguments: call?.arguments ?? {} })
        .then(() => {
          if (call?.result) {
            const resPayload = (typeof call.result === 'object' && call.result !== null)
              ? (call.result as Record<string, unknown>)
              : { content: [{ type: 'text', text: String(call.result ?? '') }] }
            void bridge.sendToolResult(resPayload as never)
          }
        })
        .catch((err) => console.warn('mcp-apps: error sending tool input/result', err))
    }

    void bridge.connect(transport).catch(err => {
      console.error('mcp-apps: bridge.connect failed', err)
    })

    // Assign srcDoc only once listener and bridge are ready
    setActiveSrcDoc(htmlWithCsp)

    return () => {
      disposed = true
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }
    }
  }, [sessionToken, resourceUri, htmlWithCsp])

  // Teardown resource only when the component unmounts
  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      if (bridgeRef.current) {
        bridgeRef.current.teardownResource({}).catch(() => void 0)
        bridgeRef.current = null
      }
      if (transportRef.current) {
        void transportRef.current.close()
        transportRef.current = null
      }
    }
  }, [])

  // Send tool result if result arrives after initialization
  useEffect(() => {
    if (isInitializedRef.current && bridgeRef.current && call?.result) {
      const resPayload = (typeof call.result === 'object' && call.result !== null)
        ? (call.result as Record<string, unknown>)
        : { content: [{ type: 'text', text: String(call.result ?? '') }] }
      void bridgeRef.current.sendToolResult(resPayload as never)
    }
  }, [call?.result])

  // Navigation tripwire: disallow navigation away from synthetic srcDoc
  const handleIframeLoad = () => {
    setNavCount(c => {
      const next = c + 1
      if (next > 1) {
        setError('Navigation within MCP App iframe is disabled')
        bridgeRef.current?.teardownResource({}).catch(() => void 0)
      }
      return next
    })
  }

  // 3. Keep enclosing TurnProcess open for MCP Apps without touching outside elements
  useEffect(() => {
    if (!resource) return
    const iframe = iframeRef.current
    if (!iframe) return

    let active = true

    const revealOwnAncestors = () => {
      if (!active || !iframe) return

      let el: HTMLElement | null = iframe.parentElement
      while (el && el !== document.body) {
        if (el.hasAttribute('hidden')) {
          el.dispatchEvent(new Event('beforematch'))
          el.removeAttribute('hidden')
        }
        if (el.hasAttribute('data-turn-process')) {
          const toggle = el.querySelector<HTMLButtonElement>('button[data-turn-process]:not([data-open])')
          toggle?.click()
        }
        el = el.parentElement
      }
    }

    revealOwnAncestors()
    const t1 = setTimeout(revealOwnAncestors, 300)
    const t2 = setTimeout(revealOwnAncestors, 800)
    const t3 = setTimeout(revealOwnAncestors, 1500)
    const t4 = setTimeout(revealOwnAncestors, 2500)

    const tStop = setTimeout(() => {
      active = false
      observer.disconnect()
    }, 3500)

    const observer = new MutationObserver(() => {
      revealOwnAncestors()
    })

    const targetToObserve = iframe.closest?.('[data-turn-process]') ?? iframe.parentElement ?? document.body
    observer.observe(targetToObserve, {
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
          srcDoc={activeSrcDoc ?? undefined}
          onLoad={handleIframeLoad}
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
