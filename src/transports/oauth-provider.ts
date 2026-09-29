import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthOptions } from '../config'
import { OAuthTokenStore, type StoredOAuthTokens } from './oauth-token-store'

function toWireTokens(tokens: StoredOAuthTokens): OAuthTokens {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: tokens.tokenType ?? 'Bearer',
    scope: tokens.scope,
    expires_in: tokens.expiresAt !== undefined ? Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1000)) : undefined,
  }
}

function toStoredTokens(tokens: OAuthTokens): StoredOAuthTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    expiresAt: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
  }
}

/**
 * Per-server `OAuthClientProvider`, backed by {@link OAuthTokenStore}.
 *
 * `codeVerifier()`/`saveCodeVerifier()` below are never actually invoked by
 * this plugin's own flow and exist only to satisfy the interface (both are
 * required, not optional) — see `ServerPool.getAuthorizeUrl` for why and how
 * this plugin bypasses the SDK's `auth()` orchestrator instead.
 */
export class RemoteOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string
  private readonly options: OAuthOptions
  private readonly store: OAuthTokenStore
  /** This DSH host's configured `externalUrl` (`Config.externalUrl`) — never derived from a request, since it's baked into dynamic client registration and must stay stable across authorize/callback/refresh. */
  private readonly externalUrl: string
  private inFlightCodeVerifier: string | undefined

  constructor(serverName: string, options: true | OAuthOptions, externalUrl: string, store: OAuthTokenStore = new OAuthTokenStore()) {
    this.serverName = serverName
    this.options = options === true ? {} : options
    this.externalUrl = externalUrl.replace(/\/$/, '')
    this.store = store
  }

  get redirectUrl(): string {
    return `${this.externalUrl}/api/mcp-apps/oauth/callback?server=${encodeURIComponent(this.serverName)}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'dsh-mcp-apps',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_post' : 'none',
      scope: this.options.scopes?.join(' '),
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.options.clientId) {
      return { client_id: this.options.clientId, client_secret: this.options.clientSecret }
    }
    return this.store.getClientInformation(this.serverName) as OAuthClientInformationMixed | undefined
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    if (this.options.clientId) return
    this.store.setClientInformation(this.serverName, clientInformation)
  }

  tokens(): OAuthTokens | undefined {
    const stored = this.store.getTokens(this.serverName)
    return stored ? toWireTokens(stored) : undefined
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.setTokens(this.serverName, toStoredTokens(tokens))
  }

  /** No-op — see `ServerPool.getAuthorizeUrl` for how the authorize URL actually reaches the caller. */
  redirectToAuthorization(): void {}

  saveCodeVerifier(codeVerifier: string): void {
    this.inFlightCodeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.inFlightCodeVerifier) {
      throw new Error(`No PKCE code verifier available for server "${this.serverName}"`)
    }
    return this.inFlightCodeVerifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    switch (scope) {
      case 'all':
        this.store.clear(this.serverName)
        break
      case 'client':
        this.store.clearClientInformation(this.serverName)
        break
      case 'tokens':
        this.store.clearTokens(this.serverName)
        break
      case 'verifier':
        this.inFlightCodeVerifier = undefined
        break
      case 'discovery':
        // Discovery state isn't persisted by this provider — nothing to clear.
        break
    }
  }
}
