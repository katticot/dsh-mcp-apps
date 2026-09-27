// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/ext-apps/app-bridge'
import { apply } from '../src/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type ToolInfo = {
  publicName: string
  rawName: string
  resourceUri: string
  serverName: string
}

function makeTool(overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    publicName: 'analytics_render_chart',
    rawName: 'render_chart',
    resourceUri: 'ui://charts/app',
    serverName: 'analytics',
    ...overrides,
  }
}

function makeContext(call: ReturnType<typeof vi.fn>) {
  let onGeneration: (() => void) | undefined
  const components = new Map<string, (props: any) => React.ReactElement>()
  const register = vi.fn((descriptor: { key: string }, component: (props: any) => React.ReactElement) => {
    components.set(descriptor.key, component)
    return () => components.delete(descriptor.key)
  })
  const context = {
    connection: {
      rpc: { call },
      generation: { subscribe: (listener: () => void) => { onGeneration = listener; return () => { onGeneration = undefined } } },
    },
    slots: {
      inject: (_name: string, effect: () => () => void) => effect(),
      register,
    },
    effect: (effect: () => () => void) => effect(),
  }
  return {
    context,
    components,
    register,
    reconnect: () => onGeneration?.(),
  }
}

describe('client plugin discovery and tool view registration', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps discovering UI tools that become available after the old eight-second retry window', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async () => ({ ok: true as const, value: call.mock.calls.length >= 4 ? [makeTool()] : [] }))
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)

    await vi.advanceTimersByTimeAsync(15_000)

    expect(call).toHaveBeenCalledTimes(4)
    expect(fixture.register).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('re-discovers immediately on a public connection generation and replaces changed tool metadata', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: [makeTool()] })
      .mockResolvedValueOnce({ ok: true, value: [makeTool({ resourceUri: 'ui://charts/v2' })] })
      .mockResolvedValueOnce({ ok: true, value: [] })
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledTimes(1))

    fixture.reconnect()
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledTimes(2))

    expect(fixture.components.get('analytics_render_chart')).toBeDefined()

    fixture.reconnect()
    await vi.waitFor(() => expect(fixture.components.has('analytics_render_chart')).toBe(false))
    expect(fixture.register).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('does not overlap list requests and follows a reconnect requested during an in-flight response', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (value: { ok: true; value: ToolInfo[] }) => void
    const first = new Promise<{ ok: true; value: ToolInfo[] }>(resolve => { resolveFirst = resolve })
    const call = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ ok: true, value: [makeTool()] })
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)

    fixture.reconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(call).toHaveBeenCalledTimes(1)

    resolveFirst({ ok: true, value: [] })
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('never registers views from a discovery response that settles after unload', async () => {
    vi.useFakeTimers()
    let resolve!: (value: { ok: true; value: ToolInfo[] }) => void
    const pending = new Promise<{ ok: true; value: ToolInfo[] }>(done => { resolve = done })
    const call = vi.fn().mockReturnValue(pending)
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)

    dispose()
    resolve({ ok: true, value: [makeTool()] })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(call).toHaveBeenCalledTimes(1)
    expect(fixture.register).not.toHaveBeenCalled()
  })

  it('passes a frozen settled result to the registered view and preserves app disclosure and result delivery', async () => {
    const tool = makeTool()
    const html = '<!doctype html><html><body>app</body></html>'
    const call = vi.fn(async (_channel: string, endpoint: string) => endpoint === 'resources/read'
      ? { ok: true as const, value: { uri: tool.resourceUri, html } }
      : { ok: true as const, value: [tool] })
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)
    await vi.waitFor(() => expect(fixture.components.get(tool.publicName)).toBeDefined())

    const hostProps = {
      callId: 'call-1',
      toolName: tool.publicName,
      block: {
        kind: 'result',
        callId: 'call-1',
        call: { name: tool.publicName, argsRaw: '{"symbol":"NVDA"}' },
        isError: false,
        content: [{ type: 'text', text: 'chart ready' }],
        meta: {
          mcpApp: {
            serverName: tool.serverName,
            rawToolName: tool.rawName,
            resourceUri: tool.resourceUri,
            sessionToken: 'session-1',
            result: { content: [{ type: 'text', text: 'chart ready' }], structuredContent: { points: [1, 2] } },
          },
        },
      },
      openFile: vi.fn(),
      loadImage: vi.fn(),
    }
    const view = fixture.components.get(tool.publicName)!
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    vi.stubGlobal('__PKG_VERSION__', 'test')
    await act(async () => {
      root.render(React.createElement(view, hostProps))
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/api', 'mcp-apps/resources/read', expect.anything(), expect.any(AbortSignal)))
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('iframe')).not.toBeNull()

    expect(call).toHaveBeenCalledWith('/api', 'mcp-apps/resources/read', {
      uri: tool.resourceUri,
      server: tool.serverName,
      sessionToken: 'session-1',
    }, expect.any(AbortSignal))
    expect(container.textContent).toContain('Interactive App')
    expect(container.textContent).toContain('Collapse')
    await act(async () => {
      container.querySelector('[title="Click to expand or collapse MCP App"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Expand')
    expect(container.querySelector('iframe')?.parentElement?.style.visibility).toBe('hidden')
    await act(async () => {
      container.querySelector('[title="Click to expand or collapse MCP App"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('iframe')?.parentElement?.style.visibility).toBe('visible')

    const iframe = container.querySelector('iframe')!
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage')
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/initialize',
          params: {
            appInfo: { name: 'test', version: '1' },
            appCapabilities: {},
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1],
          },
        },
      }))
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      method: 'ui/notifications/tool-input',
      params: { arguments: { symbol: 'NVDA' } },
    }), '*')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: 'chart ready' }], structuredContent: { points: [1, 2] } },
    }), '*')

    await act(async () => root.unmount())
    dispose()
  })
})
