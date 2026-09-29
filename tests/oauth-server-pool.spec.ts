import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, discoverOAuthServerInfo, registerClient, startAuthorization, exchangeAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { ServerPool } from '../src/transports/server-pool'
import type { Config, RemoteServerConfig } from '../src/config'

// Actual implementations (and default resolved values) are supplied fresh in
// `beforeEach` below — see the comment there for why.
vi.mock('@modelcontextprotocol/sdk/client/auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>()
  return {
    ...actual,
    discoverOAuthServerInfo: vi.fn(),
    registerClient: vi.fn(),
    startAuthorization: vi.fn(),
    exchangeAuthorization: vi.fn(),
  }
})

let homeDir = ''

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeDir }
})

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-apps-oauth-pool-test-'))
  // Normally injected by tsdown's `define` at build time; stubbed here since
  // these tests exercise the real (unmocked) `startServer`.
  ;(globalThis as any).__PKG_VERSION__ = '0.0.0-test'

  // `vi.restoreAllMocks()` below (afterEach) calls `.mockRestore()` on every
  // mock, which for a standalone `vi.fn()` (not a `vi.spyOn` on a real
  // method, like these module-mocked SDK functions) has no "original"
  // implementation to restore to and leaves it returning `undefined` —
  // re-applied fresh before every test so that reset doesn't leak across tests.
  vi.mocked(discoverOAuthServerInfo).mockReset().mockResolvedValue({
    authorizationServerUrl: 'https://auth.example.com',
    authorizationServerMetadata: undefined,
    resourceMetadata: undefined,
  })
  vi.mocked(registerClient).mockReset().mockResolvedValue({ client_id: 'dcr-client', redirect_uris: [] } as any)
  vi.mocked(startAuthorization).mockReset().mockResolvedValue({
    authorizationUrl: new URL('https://auth.example.com/authorize?foo=bar'),
    codeVerifier: 'verifier-123',
  })
  vi.mocked(exchangeAuthorization).mockReset().mockResolvedValue({ access_token: 'at', token_type: 'Bearer' })
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
  delete (globalThis as any).__PKG_VERSION__
})

const oauthServerConfig: RemoteServerConfig = {
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  oauth: true,
}

const toolManagerStub = {
  getToolCounts: () => ({ toolCount: 0, uiToolCount: 0 }),
  getToolSummaries: () => [],
  getUiToolsSnapshot: () => [],
  syncServerTools: vi.fn(),
  evictServer: vi.fn(),
} as any

describe('ServerPool OAuth handling', () => {
  it('skips connecting when oauth is configured and no tokens are stored yet', async () => {
    const connectSpy = vi.spyOn(Client.prototype, 'connect')
    const pool = new ServerPool({} as any, {
      servers: { srv: oauthServerConfig },
    }, toolManagerStub)

    await pool.startServer('srv', oauthServerConfig)

    expect(connectSpy).not.toHaveBeenCalled()
    expect((pool as any).servers.has('srv')).toBe(false)

    const status = pool.getStatusSnapshot().find(s => s.name === 'srv')
    expect(status?.connected).toBe(false)
    expect(status?.oauth).toEqual({ state: 'unauthenticated' })
  })

  it('catches UnauthorizedError from connect, marks needsAuth, and does not throw', async () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: oauthServerConfig },
    }, toolManagerStub)
    ;(pool as any).oauthTokenStore.setTokens('srv', { accessToken: 'stale-token' })

    vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new UnauthorizedError('token expired'))

    await expect(pool.startServer('srv', oauthServerConfig)).resolves.toBeUndefined()

    expect((pool as any).oauthNeedsAuth.get('srv')).toBe(true)
    expect((pool as any).servers.has('srv')).toBe(false)

    const status = pool.getStatusSnapshot().find(s => s.name === 'srv')
    expect(status?.oauth).toEqual({ state: 'expired' })
  })

  it('rethrows a non-UnauthorizedError connect failure unchanged', async () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: oauthServerConfig },
    }, toolManagerStub)
    ;(pool as any).oauthTokenStore.setTokens('srv', { accessToken: 'token' })

    vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new Error('network unreachable'))

    await expect(pool.startServer('srv', oauthServerConfig)).rejects.toThrow('network unreachable')
    expect((pool as any).oauthNeedsAuth.get('srv')).toBeUndefined()
  })

  it('reports no oauth status for a server without oauth configured', () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
    }, toolManagerStub)

    const status = pool.getStatusSnapshot().find(s => s.name === 'srv')
    expect(status?.oauth).toBeUndefined()
  })

  it('includes the server\'s stored tokens as redaction candidates for lastErrors', async () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: oauthServerConfig },
    }, toolManagerStub)
    ;(pool as any).oauthTokenStore.setTokens('srv', { accessToken: 'super-secret-access-token' })

    vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new Error('failed: token super-secret-access-token was rejected'))

    await expect(pool.startServer('srv', oauthServerConfig)).rejects.toThrow()

    // startServer itself doesn't populate lastErrors (its caller does); exercise
    // the same helper the caller uses to confirm the token is a candidate.
    const candidates = (pool as any).oauthSecretCandidates('srv')
    expect(candidates).toContain('super-secret-access-token')
  })
})

describe('ServerPool OAuth authorize/callback (redirect_uri derivation)', () => {
  const configWithExternalUrl: Config = {
    servers: { srv: oauthServerConfig },
    externalUrl: 'https://dsh.example.com',
  }
  const expectedRedirectUri = 'https://dsh.example.com/api/mcp-apps/oauth/callback?server=srv'

  it('builds the redirect_uri from Config.externalUrl only, never from request-supplied data', async () => {
    const pool = new ServerPool({} as any, configWithExternalUrl, toolManagerStub)

    const authorizeUrl = await pool.getAuthorizeUrl('srv')
    expect(authorizeUrl).toBe('https://auth.example.com/authorize?foo=bar')

    expect(registerClient).toHaveBeenCalledWith('https://auth.example.com', expect.objectContaining({
      clientMetadata: expect.objectContaining({ redirect_uris: [expectedRedirectUri] }),
    }))
    expect(startAuthorization).toHaveBeenCalledWith('https://auth.example.com', expect.objectContaining({
      redirectUrl: expectedRedirectUri,
    }))
  })

  it('rejects cleanly when externalUrl is not configured', async () => {
    const pool = new ServerPool({} as any, { servers: { srv: oauthServerConfig } }, toolManagerStub)
    await expect(pool.getAuthorizeUrl('srv')).rejects.toThrow(/externalUrl/)
  })

  it('completeOAuthCallback exchanges tokens using the same redirect_uri used for authorization', async () => {
    const pool = new ServerPool({} as any, configWithExternalUrl, toolManagerStub)
    vi.spyOn(pool, 'retryAuth').mockImplementation(() => {})

    await pool.getAuthorizeUrl('srv')
    const state = (startAuthorization as any).mock.calls[0][1].state as string

    await pool.completeOAuthCallback('srv', 'auth-code', state)

    expect(exchangeAuthorization).toHaveBeenCalledWith('https://auth.example.com', expect.objectContaining({
      redirectUri: expectedRedirectUri,
      authorizationCode: 'auth-code',
      codeVerifier: 'verifier-123',
    }))
  })
})

describe('ServerPool OAuth disconnect', () => {
  it('rejects if server is not configured for OAuth', async () => {
    const pool = new ServerPool({} as any, {
      servers: { stdio_srv: { transport: 'stdio', command: 'cmd' } },
    }, toolManagerStub)

    await expect(pool.disconnectOAuth('stdio_srv')).rejects.toThrow(/not configured for OAuth/)
    await expect(pool.disconnectOAuth('non_existent')).rejects.toThrow(/not configured for OAuth/)
  })

  it('closes active connection, evicts tools, cancels reconnect timer, and clears stored tokens', async () => {
    const pool = new ServerPool({} as any, {
      servers: { srv: oauthServerConfig },
    }, toolManagerStub)

    const closeMock = vi.fn().mockResolvedValue(undefined)
    const disposeTransportMock = vi.fn().mockResolvedValue(undefined)
    const clientStub = { close: closeMock, onclose: vi.fn() } as any
    const instance = { client: clientStub, disposeTransport: disposeTransportMock }
    ;(pool as any).servers.set('srv', instance)
    ;(pool as any).oauthTokenStore.setTokens('srv', { accessToken: 'valid-token' })
    ;(pool as any).oauthNeedsAuth.set('srv', false)

    const timer = setTimeout(() => {}, 10000)
    ;(pool as any).reconnectTimers.set('srv', timer)
    ;(pool as any).reconnectAttempts.set('srv', 3)

    expect(pool.getStatusSnapshot().find(s => s.name === 'srv')?.connected).toBe(true)
    expect(pool.getStatusSnapshot().find(s => s.name === 'srv')?.oauth?.state).toBe('authenticated')

    await pool.disconnectOAuth('srv')

    expect(clientStub.onclose).toBeUndefined()
    expect(closeMock).toHaveBeenCalledOnce()
    expect(disposeTransportMock).toHaveBeenCalledOnce()
    expect(toolManagerStub.evictServer).toHaveBeenCalledWith('srv')
    expect((pool as any).reconnectTimers.has('srv')).toBe(false)
    expect((pool as any).reconnectAttempts.has('srv')).toBe(false)
    expect((pool as any).oauthTokenStore.getTokens('srv')).toBeUndefined()
    expect((pool as any).oauthNeedsAuth.get('srv')).toBeUndefined()

    const status = pool.getStatusSnapshot().find(s => s.name === 'srv')
    expect(status?.connected).toBe(false)
    expect(status?.oauth?.state).toBe('unauthenticated')
  })
})

