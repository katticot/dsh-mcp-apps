import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Resolved lazily (not at module load) so tests can point `homedir()` elsewhere before the first call. */
function oauthDir(): string {
  return join(homedir(), '.dsh', 'mcp-apps', 'oauth')
}

/** A pending PKCE authorize attempt's verifier is dropped once older than this. */
const PENDING_VERIFIER_TTL_MS = 10 * 60 * 1000

export interface StoredOAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  tokenType?: string
}

export interface PendingVerifier {
  codeVerifier: string
  createdAt: number
}

export interface StoredOAuthState {
  /** `OAuthClientInformationFull` from the SDK, when dynamically registered. Not needed if a `clientId` is statically configured. */
  clientInformation?: unknown
  tokens?: StoredOAuthTokens
  pendingVerifiers: Record<string, PendingVerifier>
}

function emptyState(): StoredOAuthState {
  return { pendingVerifiers: {} }
}

function pathFor(serverName: string): string {
  return join(oauthDir(), `${serverName}.json`)
}

/**
 * No encryption: plaintext JSON restricted by filesystem permissions
 * (0700 dir, 0600 file), the same trust model this plugin already applies to
 * `headers`/`env` secrets — access-controlled and redacted from status/error
 * output, never encrypted at rest.
 *
 * `mode` on `mkdirSync`/`writeFileSync` only applies when that call actually
 * creates the directory/file, so permissions are re-applied with an explicit
 * `chmodSync` on every write too — otherwise a pre-existing directory/file
 * left with looser permissions (e.g. from an older version of this plugin)
 * would never be corrected.
 */
function ensureDir(): void {
  const dir = oauthDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function pruneExpired(state: StoredOAuthState): StoredOAuthState {
  const cutoff = Date.now() - PENDING_VERIFIER_TTL_MS
  const pendingVerifiers: Record<string, PendingVerifier> = {}
  for (const [authState, verifier] of Object.entries(state.pendingVerifiers)) {
    if (verifier.createdAt >= cutoff) pendingVerifiers[authState] = verifier
  }
  return { ...state, pendingVerifiers }
}

function readState(serverName: string): StoredOAuthState {
  try {
    const raw = readFileSync(pathFor(serverName), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredOAuthState>
    return pruneExpired({ pendingVerifiers: {}, ...parsed })
  } catch {
    return emptyState()
  }
}

/**
 * Writes via a temp file + rename in the same directory so a reader never
 * observes a partially written file (`rename` is atomic on the same
 * filesystem) — the closest this in-process, lock-free store gets to
 * guarding against another process writing the same file concurrently.
 */
function writeState(serverName: string, state: StoredOAuthState): void {
  ensureDir()
  const finalPath = pathFor(serverName)
  const tmpPath = `${finalPath}.tmp-${randomUUID()}`
  writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, finalPath)
}

export class OAuthTokenStore {
  getClientInformation(serverName: string): unknown {
    return readState(serverName).clientInformation
  }

  setClientInformation(serverName: string, clientInformation: unknown): void {
    const state = readState(serverName)
    writeState(serverName, { ...state, clientInformation })
  }

  getTokens(serverName: string): StoredOAuthTokens | undefined {
    return readState(serverName).tokens
  }

  setTokens(serverName: string, tokens: StoredOAuthTokens): void {
    const state = readState(serverName)
    writeState(serverName, { ...state, tokens })
  }

  getPendingVerifier(serverName: string, authState: string): PendingVerifier | undefined {
    return readState(serverName).pendingVerifiers[authState]
  }

  setPendingVerifier(serverName: string, authState: string, codeVerifier: string): void {
    const state = readState(serverName)
    writeState(serverName, {
      ...state,
      pendingVerifiers: { ...state.pendingVerifiers, [authState]: { codeVerifier, createdAt: Date.now() } },
    })
  }

  deletePendingVerifier(serverName: string, authState: string): void {
    const state = readState(serverName)
    if (!(authState in state.pendingVerifiers)) return
    const pendingVerifiers = { ...state.pendingVerifiers }
    delete pendingVerifiers[authState]
    writeState(serverName, { ...state, pendingVerifiers })
  }

  /** Clears everything stored for a server (`invalidateCredentials('all')`, or a future explicit "disconnect" action). */
  clear(serverName: string): void {
    writeState(serverName, emptyState())
  }

  clearTokens(serverName: string): void {
    const state = readState(serverName)
    writeState(serverName, { ...state, tokens: undefined })
  }

  clearClientInformation(serverName: string): void {
    const state = readState(serverName)
    writeState(serverName, { ...state, clientInformation: undefined })
  }
}
