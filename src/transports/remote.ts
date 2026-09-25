import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expandEnvVars, type RemoteServerConfig } from '../config'

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

  const expandedHeaders = expandEnvVars(config.headers)

  switch (config.transport) {
    case 'streamable-http':
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: expandedHeaders,
        },
      })

    case 'sse':
      return new SSEClientTransport(url, {
        requestInit: {
          headers: expandedHeaders,
        },
      })

    case 'websocket':
      return new WebSocketClientTransport(url)

    default:
      throw new Error(`Unsupported remote transport: ${(config as { transport: string }).transport}`)
  }
}
