import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { expandEnvVars, type RemoteServerConfig } from '../config'

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024 // 16 MB

const LF = 0x0a
const CR = 0x0d

/**
 * Wraps a `fetch` implementation so that response bodies are read through a
 * byte-counting stream that errors once a single "message" exceeds
 * `maxMessageBytes`. Counts actual bytes (not string length).
 *
 * For a plain (non-streaming) response, the whole body is one message, so
 * the running count is never reset. For `text/event-stream` responses the
 * stream never ends for the lifetime of the connection, so instead of
 * capping the total stream we cap the size of each individual SSE event:
 * the byte count resets every time a blank-line event boundary (`\n\n` /
 * `\r\n\r\n`) is seen.
 */
export function createByteCappedFetch(baseFetch: FetchLike, maxMessageBytes: number): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init)
    if (!response.body) return response

    const contentType = response.headers.get('content-type') ?? ''
    const isEventStream = contentType.includes('text/event-stream')
    const reader = response.body.getReader()

    let messageBytes = 0
    let consecutiveNewlines = 0

    const capped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await reader.read()
        } catch (err) {
          controller.error(err)
          return
        }
        if (result.done) {
          controller.close()
          return
        }
        const value = result.value

        if (!isEventStream) {
          messageBytes += value.byteLength
          if (messageBytes > maxMessageBytes) {
            const err = new Error(`Response body exceeded maximum message size of ${maxMessageBytes} bytes`)
            controller.error(err)
            await reader.cancel(err).catch(() => void 0)
            return
          }
          controller.enqueue(value)
          return
        }

        for (let i = 0; i < value.length; i++) {
          const byte = value[i]
          messageBytes++
          if (byte === LF) {
            consecutiveNewlines++
            if (consecutiveNewlines >= 2) {
              messageBytes = 0
            }
          } else if (byte !== CR) {
            consecutiveNewlines = 0
          }
          if (messageBytes > maxMessageBytes) {
            const err = new Error(`SSE event exceeded maximum message size of ${maxMessageBytes} bytes`)
            controller.error(err)
            await reader.cancel(err).catch(() => void 0)
            return
          }
        }
        controller.enqueue(value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })

    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * Wraps `WebSocketClientTransport` (which uses the global `WebSocket` API
 * and has no `maxPayload`-style option) so that a message whose serialized
 * size exceeds `maxMessageBytes` closes the socket with a clear error
 * instead of being forwarded on. The underlying transport already parses
 * the full frame into a `JSONRPCMessage` before invoking `onmessage`, so
 * the size is measured on the re-serialized JSON (UTF-8 byte length, not
 * string length).
 */
export class CappedWebSocketClientTransport implements Transport {
  private inner: WebSocketClientTransport
  private maxMessageBytes: number
  private _onmessage?: (message: JSONRPCMessage) => void

  onclose?: () => void
  onerror?: (error: Error) => void

  constructor(url: URL, maxMessageBytes: number) {
    this.maxMessageBytes = maxMessageBytes
    this.inner = new WebSocketClientTransport(url)
    this.inner.onclose = () => this.onclose?.()
    this.inner.onerror = (error) => this.onerror?.(error)
    this.inner.onmessage = (message) => {
      const size = Buffer.byteLength(JSON.stringify(message), 'utf8')
      if (size > this.maxMessageBytes) {
        const err = new Error(`WebSocket message exceeded maximum size of ${this.maxMessageBytes} bytes`)
        this.inner.close().finally(() => this.onerror?.(err))
        return
      }
      this._onmessage?.(message)
    }
  }

  get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
    return this._onmessage
  }

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this._onmessage = handler
  }

  start(): Promise<void> {
    return this.inner.start()
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message)
  }
}

export function createRemoteTransport(config: RemoteServerConfig): Transport {
  const url = new URL(config.url)
  // URL.hostname keeps the brackets around an IPv6 literal (e.g. "[::1]");
  // strip them so bare-host comparisons work.
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'

  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error(`Insecure transport: http:// is forbidden except on loopback (${url.hostname})`)
  }

  if (config.transport === 'websocket' && config.headers && Object.keys(config.headers).length > 0) {
    throw new Error('WebSocketClientTransport: headers are not supported on websocket transport')
  }

  const expandedHeaders = expandEnvVars(config.headers, process.env, new Set(config.allowedVars))
  const maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const cappedFetch = createByteCappedFetch(fetch, maxMessageBytes)

  switch (config.transport) {
    case 'streamable-http':
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: expandedHeaders,
        },
        fetch: cappedFetch,
      })

    case 'sse':
      return new SSEClientTransport(url, {
        requestInit: {
          headers: expandedHeaders,
        },
        eventSourceInit: {
          fetch: cappedFetch,
        },
        fetch: cappedFetch,
      })

    case 'websocket':
      return new CappedWebSocketClientTransport(url, maxMessageBytes)

    default:
      throw new Error(`Unsupported remote transport: ${(config as { transport: string }).transport}`)
  }
}
