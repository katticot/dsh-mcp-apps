// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/ext-apps/app-bridge'
import { createBridgeLifecycle } from '../src/client/McpAppToolView'

/** A same-origin iframe attached to the jsdom document, so `contentWindow` is a real `Window`. */
function attachIframe(): { iframe: HTMLIFrameElement; contentWindow: Window } {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const contentWindow = iframe.contentWindow
  if (!contentWindow) throw new Error('test setup: iframe.contentWindow unavailable')
  return { iframe, contentWindow }
}

function postInitializeRequest(source: Window, id: number) {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      id,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'test-app', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1],
      },
    },
    source,
  }))
}

describe('createBridgeLifecycle (McpAppToolView bridge disposal)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('disposeQuietly() closes the transport and never sends ui/resource-teardown to the view', () => {
    const { contentWindow } = attachIframe()
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage')
    const rpcCall = vi.fn()
    const handle = createBridgeLifecycle({
      contentWindow,
      sessionToken: 'tok-1',
      rpcCall,
      hostInfo: { name: 'test-host', version: '0.0.0' },
    })
    const teardownSpy = vi.spyOn(handle.bridge, 'teardownResource')

    handle.dispose(false)

    expect(teardownSpy).not.toHaveBeenCalled()
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'ui/resource-teardown' }),
      expect.anything()
    )
  })

  it('a StrictMode-style mount -> cleanup -> mount leaves exactly one live bridge, closes the first, and never tears down the reused iframe', async () => {
    vi.useFakeTimers()
    const { contentWindow } = attachIframe()
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage')
    const rpcCall = vi.fn()

    // --- Simulated first mount ---
    const handle1 = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    let bridgeRef: typeof handle1.bridge | null = handle1.bridge
    let transportRef: typeof handle1.transport | null = handle1.transport
    const teardownSpy1 = vi.spyOn(handle1.bridge, 'teardownResource')
    const closeSpy1 = vi.spyOn(handle1.transport, 'close')

    // --- Simulated cleanup of the first mount (this is what the fixed
    // useLayoutEffect cleanup in McpAppToolView does) ---
    if (bridgeRef === handle1.bridge) bridgeRef = null
    if (transportRef === handle1.transport) transportRef = null
    setTimeout(() => {
      const wasReused = Boolean(bridgeRef || transportRef)
      handle1.dispose(!wasReused)
    }, 0)

    // --- Simulated second mount (StrictMode remount), attaching before the
    // deferred check above fires ---
    const handle2 = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    bridgeRef = handle2.bridge
    transportRef = handle2.transport
    cleanups.push(() => handle2.dispose(false))

    // Let the deferred timer from mount 1's cleanup fire.
    await vi.runAllTimersAsync()

    // Bridge 1: transport closed, never sent a real teardown notification.
    expect(closeSpy1).toHaveBeenCalledTimes(1)
    expect(teardownSpy1).not.toHaveBeenCalled()
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'ui/resource-teardown' }),
      expect.anything()
    )

    // Exactly one live bridge remains, and it's the second one.
    expect(bridgeRef).toBe(handle2.bridge)
    expect(transportRef).toBe(handle2.transport)

    // The surviving bridge still completes the handshake when the view
    // posts `ui/initialize`.
    vi.useRealTimers()
    postInitializeRequest(contentWindow, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: '2.0', id: 1, result: expect.anything() }),
      '*'
    )
  })

  it('a genuine final unmount (no remount) does send the teardown notification once the deferred check runs', async () => {
    vi.useFakeTimers()
    const { contentWindow } = attachIframe()
    const rpcCall = vi.fn()

    const handle = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    let bridgeRef: typeof handle.bridge | null = handle.bridge
    let transportRef: typeof handle.transport | null = handle.transport
    const teardownSpy = vi.spyOn(handle.bridge, 'teardownResource')

    if (bridgeRef === handle.bridge) bridgeRef = null
    if (transportRef === handle.transport) transportRef = null
    setTimeout(() => {
      const wasReused = Boolean(bridgeRef || transportRef)
      handle.dispose(!wasReused)
    }, 0)

    // Nothing remounts.
    await vi.runAllTimersAsync()

    expect(teardownSpy).toHaveBeenCalledTimes(1)
  })

  it('declares the message capability in the initialize response', async () => {
    const { contentWindow } = attachIframe()
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage')
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { delivered: true } }))
    const handle = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    cleanups.push(() => handle.dispose(false))

    postInitializeRequest(contentWindow, 1)
    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          result: expect.objectContaining({ hostCapabilities: expect.objectContaining({ message: { text: {} } }) }),
        }),
        expect.anything(),
      )
    })
  })

  it('forwards ui/message to the mcp-apps/messages endpoint and returns its value', async () => {
    const { contentWindow } = attachIframe()
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage')
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { delivered: true } }))
    const handle = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    cleanups.push(() => handle.dispose(false))

    postInitializeRequest(contentWindow, 1)
    await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalled())

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'ui/message',
        params: { role: 'user', content: [{ type: 'text', text: 'the answer is 42' }] },
      },
      source: contentWindow,
    }))
    await vi.waitFor(() => {
      expect(rpcCall).toHaveBeenCalledWith('/api', 'mcp-apps/messages',
        expect.objectContaining({ sessionToken: 'tok-1', role: 'user', content: [{ type: 'text', text: 'the answer is 42' }] }),
        expect.any(AbortSignal))
    })
    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, result: { delivered: true } }),
        expect.anything(),
      )
    })
  })

  it('surfaces endpoint failures to the app as ui/message errors', async () => {
    const { contentWindow } = attachIframe()
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage')
    const rpcCall = vi.fn(async () => ({ ok: false as const, error: { code: 'forbidden', message: 'App messages are disabled for this server', details: {} } }))
    const handle = createBridgeLifecycle({ contentWindow, sessionToken: 'tok-1', rpcCall, hostInfo: { name: 'h', version: '0' } })
    cleanups.push(() => handle.dispose(false))

    postInitializeRequest(contentWindow, 1)
    await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalled())

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'ui/message',
        params: { role: 'user', content: [{ type: 'text', text: 'nope' }] },
      },
      source: contentWindow,
    }))
    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 3, error: expect.objectContaining({ message: 'App messages are disabled for this server' }) }),
        expect.anything(),
      )
    })
  })
})
