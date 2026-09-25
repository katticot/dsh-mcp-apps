import { describe, it, expect, vi } from 'vitest'
import { IpcClientTransport } from '../src/transports/ipc'

describe('IpcClientTransport Hardening', () => {
  it('correctly decodes multi-byte UTF-8 split across chunks', () => {
    const transport = new IpcClientTransport({ transport: 'ipc', socketPath: '/dummy.sock' })
    const messages: any[] = []
    transport.onmessage = (msg) => messages.push(msg)

    // Emoji 🚀 is 4 bytes: [0xF0, 0x9F, 0x9A, 0x80]
    const jsonStr = JSON.stringify({ jsonrpc: '2.0', method: 'notify', params: { text: '🚀' } }) + '\n'
    const fullBuffer = Buffer.from(jsonStr, 'utf8')

    // Split mid-emoji
    const chunk1 = fullBuffer.subarray(0, fullBuffer.indexOf(0x9F) + 1)
    const chunk2 = fullBuffer.subarray(fullBuffer.indexOf(0x9F) + 1)

    ;(transport as any).handleChunk(chunk1)
    ;(transport as any).handleChunk(chunk2)

    expect(messages).toHaveLength(1)
    expect(messages[0].params.text).toBe('🚀')
  })

  it('destroys socket when line length exceeds 16MB', () => {
    const transport = new IpcClientTransport({ transport: 'ipc', socketPath: '/dummy.sock' })
    const destroySpy = vi.fn()
    ;(transport as any).socket = { destroy: destroySpy }

    const oversizedChunk = Buffer.alloc(17 * 1024 * 1024, 65) // 17MB of 'A' without newline
    expect(() => (transport as any).handleChunk(oversizedChunk)).toThrow(/exceeded/i)
    expect(destroySpy).toHaveBeenCalled()
  })

  it('logs a clear warning that no ACL verification happens on win32', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const transport = new IpcClientTransport({ transport: 'ipc', socketPath: '/dummy-nonexistent.sock' })
      // The actual socket connect will fail (path doesn't exist); we only care
      // that the warning fires before/alongside that, not that connect succeeds.
      await transport.start().catch(() => void 0)

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [message] = warnSpy.mock.calls[0]
      expect(message).toMatch(/windows/i)
      expect(message).toMatch(/ACL|ownership|permission/i)
    } finally {
      warnSpy.mockRestore()
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
