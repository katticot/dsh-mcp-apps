import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expandEnvVars, type RemoteServerConfig } from '../config'

export function createRemoteTransport(config: RemoteServerConfig): Transport {
  const expandedHeaders = expandEnvVars(config.headers)
  const url = new URL(config.url)

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
