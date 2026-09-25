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
})
