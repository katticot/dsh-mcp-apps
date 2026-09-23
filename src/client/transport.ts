import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export class MessagePortTransport implements Transport {
  private port: MessagePort

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(port: MessagePort) {
    this.port = port
  }

  async start(): Promise<void> {
    this.port.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'object' && event.data !== null) {
        this.onmessage?.(event.data as JSONRPCMessage)
      }
    }
    this.port.onmessageerror = (event) => {
      this.onerror?.(new Error(`MessagePort serialization error: ${String(event)}`))
    }
    this.port.start()
  }

  async close(): Promise<void> {
    this.port.close()
    this.onclose?.()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.port.postMessage(message)
  }
}
