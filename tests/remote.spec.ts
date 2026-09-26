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

  it('expands a normally-blocked ${VAR} in headers when listed in allowedVars', () => {
    process.env.API_TOKEN = 'tok-abc123'
    try {
      const blockedTransport = createRemoteTransport({
        transport: 'streamable-http',
        url: 'https://mcp.example.com/stream',
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
      }) as any
      expect(blockedTransport._requestInit.headers.Authorization).toBe('Bearer ')

      const allowedTransport = createRemoteTransport({
        transport: 'streamable-http',
        url: 'https://mcp.example.com/stream',
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        allowedVars: ['API_TOKEN'],
      }) as any
      expect(allowedTransport._requestInit.headers.Authorization).toBe('Bearer tok-abc123')
    } finally {
      delete process.env.API_TOKEN
    }
  })
})
