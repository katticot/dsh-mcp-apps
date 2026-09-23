import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { IpcServerConfig } from '../config'

export class IpcClientTransport implements Transport {
  private socket: net.Socket | null = null
  private buffer = ''
  private socketPath: string

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(config: IpcServerConfig) {
    this.socketPath = config.socketPath
  }

  async start(): Promise<void> {
    const isPosix = process.platform !== 'win32'
    if (isPosix) {
      if (!fs.existsSync(this.socketPath)) {
        throw new Error(`IPC socket not found: ${this.socketPath}`)
      }
      const stat = fs.statSync(this.socketPath)
      if (!stat.isSocket()) {
        throw new Error(`IPC path is not a socket: ${this.socketPath}`)
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`Security violation: IPC socket ${this.socketPath} is owned by UID ${stat.uid}, expected ${process.getuid()}`)
      }
    }

    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath)
      this.socket = socket

      socket.once('connect', () => {
        socket.removeListener('error', onErrorBeforeConnect)
        resolve()
      })

      const onErrorBeforeConnect = (err: Error) => {
        reject(err)
      }
      socket.once('error', onErrorBeforeConnect)

      socket.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8')
        let newlineIndex: number
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim()
          this.buffer = this.buffer.slice(newlineIndex + 1)
          if (line) {
            try {
              const parsed = JSON.parse(line) as JSONRPCMessage
              this.onmessage?.(parsed)
            } catch (err) {
              this.onerror?.(err instanceof Error ? err : new Error(String(err)))
            }
          }
        }
      })

      socket.on('error', (err) => {
        this.onerror?.(err)
      })

      socket.on('close', () => {
        this.onclose?.()
      })
    })
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Cannot send message: IPC socket is not connected')
    }
    const payload = JSON.stringify(message) + '\n'
    return new Promise((resolve, reject) => {
      this.socket?.write(payload, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
