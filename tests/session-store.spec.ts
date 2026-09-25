import { describe, it, expect, vi } from 'vitest'
import { AppSessionStore } from '../src/session-store'

describe('AppSessionStore', () => {
  it('creates unique 256-bit cryptographic tokens and attaches agentId and callId', () => {
    const store = new AppSessionStore()
    const session1 = store.createSession('postgres', 'query', 'ui://postgres/app', ['query', 'explain'], {
      agentId: 'agent-123',
      callId: 'call-456',
    })
    const session2 = store.createSession('postgres', 'query', 'ui://postgres/app', ['query', 'explain'])

    expect(session1.sessionToken).toHaveLength(64) // 32 bytes hex = 64 characters
    expect(session2.sessionToken).toHaveLength(64)
    expect(session1.sessionToken).not.toBe(session2.sessionToken)
    expect(session1.serverName).toBe('postgres')
    expect(session1.allowedReverseTools.has('query')).toBe(true)
    expect(session1.allowedReverseTools.has('drop_database')).toBe(false)
    expect(session1.agentId).toBe('agent-123')
    expect(session1.callId).toBe('call-456')
    expect(session2.agentId).toBeUndefined()
    expect(session2.callId).toBeUndefined()
    store.dispose()
  })

  it('retrieves valid session and rejects invalid or missing token', () => {
    const store = new AppSessionStore()
    const session = store.createSession('server1', 'tool1', 'ui://res')

    expect(store.get(session.sessionToken)).toBe(session)
    expect(store.get('non-existent-token')).toBeUndefined()
    expect(store.get(undefined)).toBeUndefined()
    store.dispose()
  })

  it('enforces TTL expiration', () => {
    const store = new AppSessionStore(-1000) // Negative TTL = immediately expired
    const session = store.createSession('server1', 'tool1', 'ui://res')

    expect(store.get(session.sessionToken)).toBeUndefined()
    store.dispose()
  })

  it('stays within size cap and evicts least recently used (LRU) sessions', () => {
    const store = new AppSessionStore(3600 * 1000, 3) // max 3 sessions
    const s1 = store.createSession('srv', 't1')
    const s2 = store.createSession('srv', 't2')
    const s3 = store.createSession('srv', 't3')

    expect(store.size).toBe(3)
    expect(store.get(s1.sessionToken)).toBeDefined()
    expect(store.get(s2.sessionToken)).toBeDefined()
    expect(store.get(s3.sessionToken)).toBeDefined()

    // Adding s4 will evict s1 if s1 was least recently used, BUT in the line above we accessed s1, s2, s3 in order,
    // so s1 is now MRU? Wait! We called get(s1), then get(s2), then get(s3).
    // So the access order was s1, then s2, then s3 (s1 is oldest of the 3 accessed).
    // Let's create s4: s1 should be evicted!
    const s4 = store.createSession('srv', 't4')
    expect(store.size).toBe(3)
    expect(store.get(s1.sessionToken)).toBeUndefined()
    expect(store.get(s2.sessionToken)).toBeDefined()
    expect(store.get(s3.sessionToken)).toBeDefined()
    expect(store.get(s4.sessionToken)).toBeDefined()
    store.dispose()
  })

  it('updates LRU order on get() so accessed sessions survive eviction', () => {
    const store = new AppSessionStore(3600 * 1000, 3)
    const s1 = store.createSession('srv', 't1')
    const s2 = store.createSession('srv', 't2')
    const s3 = store.createSession('srv', 't3')

    // Touch s1 to make it most recently used. Order becomes: s2 (oldest), s3, s1 (newest)
    expect(store.get(s1.sessionToken)).toBeDefined()

    // Creating s4 should evict s2 (oldest), leaving s3, s1, s4
    const s4 = store.createSession('srv', 't4')
    expect(store.size).toBe(3)
    expect(store.get(s2.sessionToken)).toBeUndefined()
    expect(store.get(s1.sessionToken)).toBeDefined()
    expect(store.get(s3.sessionToken)).toBeDefined()
    expect(store.get(s4.sessionToken)).toBeDefined()
    store.dispose()
  })

  it('prunes expired sessions on createSession before enforcing capacity', () => {
    // Session store with 2 max sessions and 100ms TTL
    const store = new AppSessionStore(100, 2)
    const s1 = store.createSession('srv', 't1')
    const s2 = store.createSession('srv', 't2')
    expect(store.size).toBe(2)

    // Manually expire s1 and s2
    s1.expiresAt = Date.now() - 10
    s2.expiresAt = Date.now() - 10

    // Creating s3 should prune expired s1 and s2 first, so size is 1
    const s3 = store.createSession('srv', 't3')
    expect(store.size).toBe(1)
    expect(store.get(s1.sessionToken)).toBeUndefined()
    expect(store.get(s2.sessionToken)).toBeUndefined()
    expect(store.get(s3.sessionToken)).toBeDefined()
    store.dispose()
  })

  it('periodically prunes expired sessions via timer', () => {
    vi.useFakeTimers()
    try {
      const store = new AppSessionStore(1000, 1000, 500) // TTL 1000ms, prune every 500ms
      const s1 = store.createSession('srv', 't1')
      expect(store.size).toBe(1)

      // Advance time past TTL (1000ms) and next prune interval (1500ms)
      vi.advanceTimersByTime(1600)
      expect(store.size).toBe(0)
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose() stops periodic timer and clears all sessions', () => {
    const store = new AppSessionStore(3600 * 1000, 1000, 5000)
    store.createSession('srv', 't1')
    store.createSession('srv', 't2')
    expect(store.size).toBe(2)

    store.dispose()
    expect(store.size).toBe(0)
  })
})
