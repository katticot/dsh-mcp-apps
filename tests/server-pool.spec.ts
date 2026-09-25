import { describe, it, expect, vi } from 'vitest'
import { ServerPool } from '../src/transports/server-pool'

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
