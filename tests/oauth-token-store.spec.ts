import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuthTokenStore } from '../src/transports/oauth-token-store'

// The store hard-codes ~/.dsh/mcp-apps/oauth; mock node:os's homedir() so
// these tests never touch the real home directory and each test starts from
// a clean slate.
let homeDir = ''

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeDir }
})

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-apps-oauth-test-'))
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
})

describe('OAuthTokenStore', () => {
  it('round-trips tokens and client information', () => {
    const store = new OAuthTokenStore()
    store.setTokens('srv', { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', scope: 'read' })
    store.setClientInformation('srv', { client_id: 'abc' })

    expect(store.getTokens('srv')).toEqual({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', scope: 'read' })
    expect(store.getClientInformation('srv')).toEqual({ client_id: 'abc' })
  })

  it('returns undefined for a server with no stored state', () => {
    const store = new OAuthTokenStore()
    expect(store.getTokens('missing')).toBeUndefined()
    expect(store.getClientInformation('missing')).toBeUndefined()
    expect(store.getPendingVerifier('missing', 'state1')).toBeUndefined()
  })

  it("keeps two different states from clobbering each other's verifier", () => {
    const store = new OAuthTokenStore()
    store.setPendingVerifier('srv', 'state-a', 'verifier-a')
    store.setPendingVerifier('srv', 'state-b', 'verifier-b')

    expect(store.getPendingVerifier('srv', 'state-a')?.codeVerifier).toBe('verifier-a')
    expect(store.getPendingVerifier('srv', 'state-b')?.codeVerifier).toBe('verifier-b')

    store.deletePendingVerifier('srv', 'state-a')
    expect(store.getPendingVerifier('srv', 'state-a')).toBeUndefined()
    expect(store.getPendingVerifier('srv', 'state-b')?.codeVerifier).toBe('verifier-b')
  })

  it('prunes pending verifiers older than 10 minutes on read', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)
    const store = new OAuthTokenStore()
    store.setPendingVerifier('srv', 'old-state', 'verifier-old')

    vi.setSystemTime(now + 11 * 60 * 1000)
    store.setPendingVerifier('srv', 'new-state', 'verifier-new')

    expect(store.getPendingVerifier('srv', 'old-state')).toBeUndefined()
    expect(store.getPendingVerifier('srv', 'new-state')?.codeVerifier).toBe('verifier-new')
    vi.useRealTimers()
  })

  it('writes the oauth directory and file with restrictive permissions', () => {
    const store = new OAuthTokenStore()
    store.setTokens('srv', { accessToken: 'at' })

    const dir = join(homeDir, '.dsh', 'mcp-apps', 'oauth')
    const file = join(dir, 'srv.json')
    expect(existsSync(file)).toBe(true)

    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('clear() removes tokens, client information, and pending verifiers', () => {
    const store = new OAuthTokenStore()
    store.setTokens('srv', { accessToken: 'at' })
    store.setClientInformation('srv', { client_id: 'abc' })
    store.setPendingVerifier('srv', 'state', 'verifier')

    store.clear('srv')

    expect(store.getTokens('srv')).toBeUndefined()
    expect(store.getClientInformation('srv')).toBeUndefined()
    expect(store.getPendingVerifier('srv', 'state')).toBeUndefined()
  })

  it('clearTokens() and clearClientInformation() only clear their own field', () => {
    const store = new OAuthTokenStore()
    store.setTokens('srv', { accessToken: 'at' })
    store.setClientInformation('srv', { client_id: 'abc' })

    store.clearTokens('srv')
    expect(store.getTokens('srv')).toBeUndefined()
    expect(store.getClientInformation('srv')).toEqual({ client_id: 'abc' })

    store.clearClientInformation('srv')
    expect(store.getClientInformation('srv')).toBeUndefined()
  })

  it("keeps different servers' state independent", () => {
    const store = new OAuthTokenStore()
    store.setTokens('srv-a', { accessToken: 'a' })
    store.setTokens('srv-b', { accessToken: 'b' })

    expect(store.getTokens('srv-a')?.accessToken).toBe('a')
    expect(store.getTokens('srv-b')?.accessToken).toBe('b')
  })
})
