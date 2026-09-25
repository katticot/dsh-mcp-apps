import { describe, it, expect } from 'vitest'
import { createRemoteTransport } from '../src/transports/remote'

describe('Remote Transport Security', () => {
  it('rejects http:// transport unless host is loopback', () => {
    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://insecure-remote.com/mcp',
    })).toThrow(/http:\/\/ is forbidden except on loopback/i)

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://localhost:8080/mcp',
    })).not.toThrow()

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://127.0.0.1:8080/mcp',
    })).not.toThrow()

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://[::1]:8080/mcp',
    })).not.toThrow()

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://[::2]:8080/mcp',
    })).toThrow(/http:\/\/ is forbidden except on loopback/i)
  })

  it('rejects hosts that merely contain a loopback name as a substring', () => {
    for (const url of [
      'http://127.0.0.1.evil.com/mcp',
      'http://localhost.evil.com/mcp',
      'http://evil.com/?localhost',
      'http://localhost@evil.com/mcp',
    ]) {
      expect(() => createRemoteTransport({
        transport: 'streamable-http',
        url,
      })).toThrow(/http:\/\/ is forbidden except on loopback/i)
    }
  })

  it('throws when headers are provided for websocket transport', () => {
    expect(() => createRemoteTransport({
      transport: 'websocket',
      url: 'wss://mcp.example.com/ws',
      headers: { Authorization: 'Bearer token' },
    })).toThrow(/headers are not supported on websocket/i)
  })
})
