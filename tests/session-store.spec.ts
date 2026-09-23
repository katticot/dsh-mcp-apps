import { describe, it, expect } from 'vitest'
import { AppSessionStore } from '../src/session-store'

describe('AppSessionStore', () => {
  it('creates unique 256-bit cryptographic tokens', () => {
    const store = new AppSessionStore()
    const session1 = store.createSession('postgres', 'query', 'ui://postgres/app', ['query', 'explain'])
    const session2 = store.createSession('postgres', 'query', 'ui://postgres/app', ['query', 'explain'])

    expect(session1.sessionToken).toHaveLength(64) // 32 bytes hex = 64 characters
    expect(session2.sessionToken).toHaveLength(64)
    expect(session1.sessionToken).not.toBe(session2.sessionToken)
    expect(session1.serverName).toBe('postgres')
    expect(session1.allowedReverseTools.has('query')).toBe(true)
    expect(session1.allowedReverseTools.has('drop_database')).toBe(false)
  })

  it('retrieves valid session and rejects invalid or missing token', () => {
    const store = new AppSessionStore()
    const session = store.createSession('server1', 'tool1', 'ui://res')

    expect(store.get(session.sessionToken)).toBe(session)
    expect(store.get('non-existent-token')).toBeUndefined()
    expect(store.get(undefined)).toBeUndefined()
  })

  it('enforces TTL expiration', () => {
    const store = new AppSessionStore(-1000) // Negative TTL = immediately expired
    const session = store.createSession('server1', 'tool1', 'ui://res')

    expect(store.get(session.sessionToken)).toBeUndefined()
  })
})
