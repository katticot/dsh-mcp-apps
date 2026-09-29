import { describe, it, expect, vi } from 'vitest'
import { ServerPool, sanitizeErrorMessage, formatErrorMessage } from '../src/transports/server-pool'
import { ServerToolManager } from '../src/tool-manager'
import { AppSessionStore } from '../src/session-store'

describe('ServerPool Lifecycle', () => {
  it('startAll runs servers in parallel and slow server does not block others', async () => {
    let fastConnected = false
    const pool = new ServerPool({} as any, {
      servers: {
        slow: { transport: 'stdio', command: 'slow-srv' },
        fast: { transport: 'stdio', command: 'fast-srv' },
      },
    }, { syncServerTools: vi.fn(), evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    vi.spyOn(pool, 'startServer').mockImplementation(async (name: string) => {
      if (name === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 500))
      } else {
        fastConnected = true
      }
    })

    const startPromise = pool.startAll()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fastConnected).toBe(true)
    await startPromise
  })

  it('stopAll aborts pending startups and leaves no registered servers behind', async () => {
    const pool = new ServerPool({} as any, {
      servers: {
        server1: { transport: 'stdio', command: 'srv' },
      },
    }, { syncServerTools: vi.fn(), evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    vi.spyOn(pool, 'startServer').mockImplementation(async (_name, _config, signal) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (signal?.aborted) throw new Error('Aborted')
    })

    const startPromise = pool.startAll()
    await pool.stopAll()
    await expect(startPromise).resolves.not.toThrow()
    expect((pool as any).servers.size).toBe(0)
  })

  it('forwards timeout and signal into client.callTool', async () => {
    const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [] }) }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd', toolCallTimeoutMs: 5000 } },
    }, { getUiToolsSnapshot: () => [] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const controller = new AbortController()
    await pool.callTool('srv', 'test_tool', { a: 1 }, controller.signal)

    expect(mockClient.callTool).toHaveBeenCalledWith(
      { name: 'test_tool', arguments: { a: 1 } },
      undefined,
      { timeout: 5000, signal: controller.signal }
    )
  })

  it('evicts server tools on close and schedules reconnection with backoff', async () => {
    vi.useFakeTimers()
    const evictSpy = vi.fn()
    const pool = new ServerPool({} as any, {
      servers: {
        reconnectingSrv: {
          transport: 'stdio',
          command: 'cmd',
          reconnectOptions: { maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2 },
        } as any,
      },
    }, { evictServer: evictSpy, getUiToolsSnapshot: () => [] } as any)

    const startSpy = vi.spyOn(pool, 'startServer').mockResolvedValue()
    ;(pool as any).handleServerClose('reconnectingSrv')

    expect(evictSpy).toHaveBeenCalledWith('reconnectingSrv')
    vi.advanceTimersByTime(1000)
    expect(startSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('readResource extracts HTML from multi-content response', async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [
          { uri: 'ui://srv/metadata', text: '{"version": 1}' },
          { uri: 'ui://srv/app', text: '<div>App Content</div>', mimeType: 'text/html' },
        ],
      }),
    }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [{ resourceUri: 'ui://srv/app', serverName: 'srv' }] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const res = await pool.readResource('srv', 'ui://srv/app')
    expect(res.html).toBe('<div>App Content</div>')
  })

  it('clears a pending reconnect timer before scheduling a new one, avoiding double reconnects', async () => {
    vi.useFakeTimers()
    const startSpy = vi.spyOn(ServerPool.prototype, 'startServer').mockResolvedValue()
    const pool = new ServerPool({} as any, {
      servers: {
        srv: {
          transport: 'stdio',
          command: 'cmd',
          reconnectOptions: { maxRetries: 5, initialDelayMs: 1000, backoffFactor: 2 },
        } as any,
      },
    }, { evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    // Two onclose events fire back-to-back before the first reconnect delay elapses
    ;(pool as any).handleServerClose('srv')
    ;(pool as any).handleServerClose('srv')

    await vi.advanceTimersByTimeAsync(10000)
    expect(startSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not start a duplicate reconnect while one is already in flight', async () => {
    vi.useFakeTimers()
    let resolveStart!: () => void
    const startSpy = vi.spyOn(ServerPool.prototype, 'startServer').mockImplementation(
      () => new Promise<void>(resolve => { resolveStart = resolve })
    )
    const pool = new ServerPool({} as any, {
      servers: {
        srv: {
          transport: 'stdio',
          command: 'cmd',
          reconnectOptions: { maxRetries: 5, initialDelayMs: 1000, backoffFactor: 2 },
        } as any,
      },
    }, { evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    ;(pool as any).handleServerClose('srv')
    await vi.advanceTimersByTimeAsync(1000)
    expect(startSpy).toHaveBeenCalledTimes(1)

    // Another close arrives while the in-flight startServer() has not resolved yet
    ;(pool as any).handleServerClose('srv')
    await vi.advanceTimersByTimeAsync(10000)
    expect(startSpy).toHaveBeenCalledTimes(1)

    resolveStart()
    vi.useRealTimers()
  })

  it('readResourceRaw returns raw ReadResourceResult unchanged', async () => {
    const rawResult = {
      contents: [
        { uri: 'resource://1', text: 'one' },
        { uri: 'resource://2', blob: 'dHdv' },
      ],
    }
    const mockClient = { readResource: vi.fn().mockResolvedValue(rawResult) }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const res = await pool.readResourceRaw('srv', 'resource://1')
    expect(res).toBe(rawResult)
  })

  it('readResourceRaw rejects when total content size exceeds MAX_RESOURCE_SIZE_BYTES', async () => {
    // Just over the 10MB cap; split across two content items to prove the
    // check sums bytes across *all* contents, not just the first one.
    const half = 'a'.repeat(5 * 1024 * 1024 + 1)
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [
          { uri: 'resource://1', text: half },
          { uri: 'resource://2', text: half },
        ],
      }),
    }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    await expect(pool.readResourceRaw('srv', 'resource://1')).rejects.toThrow(/exceeded maximum/i)
  })

  it('readResourceRaw allows total content size within MAX_RESOURCE_SIZE_BYTES, counting a blob by decoded bytes', async () => {
    // A base64 blob decodes to 3/4 of its encoded length; use a blob well
    // under the cap alongside modest text so the sum stays under 10MB.
    const blob = Buffer.alloc(1024, 'x').toString('base64')
    const rawResult = {
      contents: [
        { uri: 'resource://1', text: 'small text' },
        { uri: 'resource://2', blob },
      ],
    }
    const mockClient = { readResource: vi.fn().mockResolvedValue(rawResult) }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const res = await pool.readResourceRaw('srv', 'resource://1')
    expect(res).toBe(rawResult)
  })

  it('readResource rejects an oversized blob without fully decoding it just to measure it', async () => {
    // ~13.4MB of base64 decodes to just over 10MB. If the implementation
    // measured size by fully decoding to a UTF-8 string first (the old
    // behavior), this would still be caught, but a non-UTF-8-safe blob would
    // not be; measuring from the base64 length avoids decoding at all.
    const oversizedBlob = Buffer.alloc(10 * 1024 * 1024 + 1024, 1).toString('base64')
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: 'ui://srv/app', blob: oversizedBlob, mimeType: 'text/html' }],
      }),
    }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [{ resourceUri: 'ui://srv/app', serverName: 'srv' }] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    await expect(pool.readResource('srv', 'ui://srv/app')).rejects.toThrow(/exceeded maximum/i)
  })

  it('readResource accepts a blob within the cap', async () => {
    const blob = Buffer.from('<div>hi</div>', 'utf8').toString('base64')
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: 'ui://srv/app', blob, mimeType: 'text/html' }],
      }),
    }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [{ resourceUri: 'ui://srv/app', serverName: 'srv' }] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const res = await pool.readResource('srv', 'ui://srv/app')
    expect(res.html).toBe('<div>hi</div>')
  })

  it('discards a zombie refreshTools resolution after stopAll', async () => {
    const syncSpy = vi.fn()
    const mockToolManager = { syncServerTools: syncSpy, evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any
    const pool = new ServerPool({} as any, { servers: {} }, mockToolManager)

    let resolveListTools!: (value: any) => void
    const hungListTools = new Promise(resolve => { resolveListTools = resolve })
    const mockClient = {
      listTools: vi.fn().mockReturnValue(hungListTools),
      close: vi.fn().mockResolvedValue(undefined),
    } as any
    const disposeTransport = vi.fn().mockResolvedValue(undefined)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport })

    const refreshPromise = (pool as any).refreshTools('srv', mockClient)

    await pool.stopAll()
    resolveListTools({ tools: [{ name: 'late_tool', inputSchema: {} }] })
    await refreshPromise

    expect(syncSpy).not.toHaveBeenCalled()
    expect(pool.getUiToolsSnapshot()).toEqual([])
  })

  it('getStatusSnapshot reports connected/tool counts per server without leaking config secrets', async () => {
    const connectedSummaries = [
      { rawName: 'render_chart', publicName: 'mcp__connected__render_chart', visibility: 'both' as const, hasUi: true },
    ]
    const mockToolManager = {
      getUiToolsSnapshot: () => [],
      getToolCounts: (serverName: string) => (serverName === 'connected' ? { toolCount: 3, uiToolCount: 1 } : { toolCount: 0, uiToolCount: 0 }),
      getToolSummaries: (serverName: string) => (serverName === 'connected' ? connectedSummaries : []),
    } as any
    const pool = new ServerPool({} as any, {
      servers: {
        connected: { transport: 'stdio', command: 'secret-cmd', args: ['--token', 'shh'], env: { TOKEN: 'shh' } },
        disconnected: { transport: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer shh' } },
      },
    }, mockToolManager)
    ;(pool as any).servers.set('connected', { client: {}, disposeTransport: vi.fn() })
    ;(pool as any).lastErrors.set('disconnected', 'ECONNREFUSED')

    const snapshot = pool.getStatusSnapshot()
    expect(snapshot).toEqual([
      { name: 'connected', transport: 'stdio', connected: true, toolCount: 3, uiToolCount: 1, lastError: undefined, tools: connectedSummaries },
      { name: 'disconnected', transport: 'sse', connected: false, toolCount: 0, uiToolCount: 0, lastError: 'ECONNREFUSED', tools: [] },
    ])

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('secret-cmd')
    expect(serialized).not.toContain('shh')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('command')
    expect(serialized).not.toContain('env')
    expect(serialized).not.toContain('headers')
    expect(serialized).not.toContain('url')
  })

  it('getStatusSnapshot never leaks a synced tool\'s description/inputSchema, even though the underlying Tool object carries them', async () => {
    const realToolManager = new ServerToolManager({ register: () => () => void 0 }, new AppSessionStore())
    const craftedTool = {
      name: 'sneaky_tool',
      description: 'should never appear',
      inputSchema: { type: 'object', properties: { secret: { type: 'string', description: 'also should never appear' } } },
    } as any

    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, realToolManager)
    realToolManager.syncServerTools('srv', {} as any, [craftedTool])

    const snapshot = pool.getStatusSnapshot()
    const srvStatus = snapshot.find(s => s.name === 'srv')
    expect(srvStatus?.tools).toHaveLength(1)
    expect(srvStatus?.tools?.[0]).toEqual({
      rawName: 'sneaky_tool',
      publicName: 'mcp__srv__sneaky_tool',
      visibility: 'both',
      hasUi: false,
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('should never appear')
    expect(serialized).not.toContain('secret')

    for (const server of snapshot) {
      for (const tool of server.tools ?? []) {
        expect(Object.keys(tool)).not.toContain('description')
        expect(Object.keys(tool)).not.toContain('inputSchema')
      }
    }
  })

  it('discards a zombie refreshTools resolution after the server is evicted/closed and reconnects', async () => {
    const syncSpy = vi.fn()
    const mockToolManager = { syncServerTools: syncSpy, evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any
    const pool = new ServerPool({} as any, { servers: { srv: { transport: 'stdio', command: 'cmd' } } }, mockToolManager)

    let resolveListTools!: (value: any) => void
    const hungListTools = new Promise(resolve => { resolveListTools = resolve })
    const staleClient = { listTools: vi.fn().mockReturnValue(hungListTools) } as any
    ;(pool as any).servers.set('srv', { client: staleClient, disposeTransport: vi.fn() })

    const refreshPromise = (pool as any).refreshTools('srv', staleClient)

    // Server closes and a new instance takes its place (e.g. after reconnect)
    ;(pool as any).handleServerClose('srv')
    const freshClient = { listTools: vi.fn() } as any
    ;(pool as any).servers.set('srv', { client: freshClient, disposeTransport: vi.fn() })

    resolveListTools({ tools: [{ name: 'late_tool', inputSchema: {} }] })
    await refreshPromise

    expect(syncSpy).not.toHaveBeenCalled()
  })
})

describe('sanitizeErrorMessage', () => {
  it('strips a query string (e.g. a leaked token) from a URL, keeping scheme://host/path', () => {
    const message = 'fetch failed: https://mcp.example.com/sse?token=super-secret-value'
    const sanitized = sanitizeErrorMessage(message)
    expect(sanitized).toBe('fetch failed: https://mcp.example.com/sse')
    expect(sanitized).not.toContain('super-secret-value')
    expect(sanitized).not.toContain('?')
  })

  it('strips a fragment from a URL', () => {
    const sanitized = sanitizeErrorMessage('connect ECONNREFUSED https://host.example/path#fragment-secret')
    expect(sanitized).toBe('connect ECONNREFUSED https://host.example/path')
    expect(sanitized).not.toContain('fragment-secret')
  })

  it('strips userinfo (user:pass@) from a URL', () => {
    const sanitized = sanitizeErrorMessage('request failed for https://user:hunter2@host.example/api')
    expect(sanitized).toBe('request failed for https://host.example/api')
    expect(sanitized).not.toContain('hunter2')
    expect(sanitized).not.toContain('user:')
  })

  it('strips userinfo, query and fragment together', () => {
    const sanitized = sanitizeErrorMessage('https://user:pw@host.example/a/b?x=1&y=2#frag')
    expect(sanitized).toBe('https://host.example/a/b')
  })

  it('collapses whitespace and newlines', () => {
    const sanitized = sanitizeErrorMessage('line one\n\n  line   two\t\tline three')
    expect(sanitized).toBe('line one line two line three')
  })

  it('truncates a long message to ~300 chars with an ellipsis', () => {
    const longMessage = 'x'.repeat(1000)
    const sanitized = sanitizeErrorMessage(longMessage)
    expect(sanitized.length).toBe(301) // 300 chars + ellipsis
    expect(sanitized.endsWith('…')).toBe(true)
    expect(sanitized.startsWith('x'.repeat(300))).toBe(true)
  })

  it('does not truncate a message at or under the limit', () => {
    const message = 'x'.repeat(300)
    expect(sanitizeErrorMessage(message)).toBe(message)
  })

  it('redacts a configured secret value (env/header) if it appears verbatim in the message', () => {
    const sanitized = sanitizeErrorMessage(
      'spawn failed: could not authenticate with token ABC123SECRET against upstream',
      ['ABC123SECRET']
    )
    expect(sanitized).not.toContain('ABC123SECRET')
    expect(sanitized).toContain('[redacted]')
  })

  it('redacts every occurrence and every configured secret value', () => {
    const sanitized = sanitizeErrorMessage(
      'first SECRET_ONE then SECRET_TWO then SECRET_ONE again',
      ['SECRET_ONE', 'SECRET_TWO']
    )
    expect(sanitized).toBe('first [redacted] then [redacted] then [redacted] again')
  })

  it('ignores secret values shorter than 3 characters to avoid collateral redaction', () => {
    const sanitized = sanitizeErrorMessage('a b c error', ['a'])
    expect(sanitized).toBe('a b c error')
  })

  it('leaves a message with no URL or secrets unchanged (aside from whitespace collapsing)', () => {
    expect(sanitizeErrorMessage('spawn ENOENT')).toBe('spawn ENOENT')
  })

  it('redacts just the credential part of a "Bearer <token>" configured value, even though only the token (not the whole header value) appears in the message', () => {
    const sanitized = sanitizeErrorMessage('invalid token abc123xyz', ['Bearer abc123xyz'])
    expect(sanitized).toBe('invalid token [redacted]')
    expect(sanitized).not.toContain('abc123xyz')
  })

  it('redacts a percent-encoded occurrence of a configured value', () => {
    // Not URL-shaped (no scheme://), so URL_TOKEN_PATTERN doesn't strip it
    // first - this exercises the percent-encoded secret candidate itself.
    const sanitized = sanitizeErrorMessage(
      'raw request body: authorization=Bearer%20abc123xyz sent upstream',
      ['Bearer abc123xyz']
    )
    expect(sanitized).not.toContain('abc123xyz')
    expect(sanitized).toContain('[redacted]')
  })

  it('redacts the full configured value as a single [redacted], not once per derived part', () => {
    const sanitized = sanitizeErrorMessage('Authorization: Bearer abc123xyz', ['Bearer abc123xyz'])
    expect(sanitized).toBe('Authorization: [redacted]')
  })
})

describe('formatErrorMessage', () => {
  it('includes cause message when available', () => {
    const cause = new Error('Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)')
    const err = new TypeError('fetch failed', { cause })
    expect(formatErrorMessage(err)).toBe('fetch failed (Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms))')
  })

  it('includes cause code when cause has a code', () => {
    const cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }
    const err = new TypeError('fetch failed', { cause })
    expect(formatErrorMessage(err)).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)')
  })

  it('returns plain message when no cause exists', () => {
    const err = new Error('Connection refused')
    expect(formatErrorMessage(err)).toBe('Connection refused')
  })

  it('converts non-Error to string', () => {
    expect(formatErrorMessage('string error')).toBe('string error')
    expect(formatErrorMessage(123)).toBe('123')
  })
})

describe('ServerPool retryServer', () => {
  it('throws if server is not configured', async () => {
    const pool = new ServerPool({} as any, { servers: {} }, { getUiToolsSnapshot: () => [] } as any)
    await expect(pool.retryServer('missing')).rejects.toThrow(/not configured/)
  })

  it('cancels pending reconnect timer, resets attempts, and calls startServer', async () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd' } },
    }, { getUiToolsSnapshot: () => [] } as any)

    const timer = setTimeout(() => {}, 10000)
    ;(pool as any).reconnectTimers.set('srv', timer)
    ;(pool as any).reconnectAttempts.set('srv', 4)

    const startSpy = vi.spyOn(pool, 'startServer').mockResolvedValue()
    await pool.retryServer('srv')

    expect((pool as any).reconnectTimers.has('srv')).toBe(false)
    expect((pool as any).reconnectAttempts.has('srv')).toBe(false)
    expect(startSpy).toHaveBeenCalledOnce()
  })
})
