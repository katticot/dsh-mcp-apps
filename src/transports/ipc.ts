import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { IpcServerConfig } from '../config'

export const MAX_IPC_BUFFER_SIZE = 16 * 1024 * 1024 // 16 MB

export class IpcClientTransport implements Transport {
  private socket: net.Socket | null = null
  private buffer = ''
  private decoder = new StringDecoder('utf8')
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
      const dir = path.dirname(this.socketPath)
      if (fs.existsSync(dir)) {
        const dirStat = fs.statSync(dir)
        if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) {
          throw new Error(`Security violation: IPC directory ${dir} is owned by UID ${dirStat.uid}, expected ${process.getuid()}`)
        }
        const mode = dirStat.mode & 0o777
        if (mode !== 0o700) {
          throw new Error(`Security violation: IPC directory ${dir} mode is 0${mode.toString(8)}, expected 0700`)
        }
      }

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
    } else {
      // Windows has no equivalent of the POSIX UID/mode checks above, and
      // implementing real Windows ACL verification is out of scope here.
      // Fail open (connect anyway) rather than silently skip the check:
      // make the gap loud so operators can compensate (e.g. named pipe ACLs
      // set up out-of-band). See README "Windows IPC" for details.
      console.warn(
        `mcp-apps: running on Windows — IPC socket ownership/permission (ACL) verification is not implemented. ` +
        `Connecting to "${this.socketPath}" without verifying who owns or can access it. ` +
        `Ensure the socket/pipe is protected by an appropriate ACL yourself.`
      )
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

      socket.on('data', (chunk: Buffer) => {
        try {
          this.handleChunk(chunk)
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
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

  private handleChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    if (this.buffer.length > MAX_IPC_BUFFER_SIZE) {
      this.close()
      throw new Error(`IPC message size exceeded maximum limit of ${MAX_IPC_BUFFER_SIZE} bytes`)
    }
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
  }
}
