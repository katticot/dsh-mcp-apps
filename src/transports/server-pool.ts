import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge'
import {
  UnauthorizedError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { Context } from '@deepseek-ai/cordis'
import { expandEnvVars, resolveToolCallTimeoutMs, type Config, type OAuthOptions, type ServerConfig } from '../config'
import type { ServerToolManager, UiToolDescriptor, ToolSummary } from '../tool-manager'
import { createStdioTransport, type ManagedStdio } from './subprocess'
import { createRemoteTransport } from './remote'
import { OAuthTokenStore } from './oauth-token-store'
import { RemoteOAuthProvider } from './oauth-provider'

/** Replacement text for a redacted secret or a stripped URL query/fragment/userinfo. */
const REDACTED = '[redacted]'

/** `lastErrors` entries are truncated to this many characters (plus an ellipsis) before storage. */
export const MAX_ERROR_MESSAGE_LENGTH = 300

/** Matches a `scheme://...` token so its userinfo/query/fragment can be stripped without touching the rest of the message. */
const URL_TOKEN_PATTERN = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g

/** `scheme://[user:pass@]host/path?query#fragment` -> `scheme://host/path` (userinfo, query and fragment dropped). */
function sanitizeUrlToken(token: string): string {
  const schemeEnd = token.indexOf('://')
  if (schemeEnd === -1) return token
  const scheme = token.slice(0, schemeEnd + 3)
  let rest = token.slice(schemeEnd + 3)

  const queryOrFragmentIndex = rest.search(/[?#]/)
  if (queryOrFragmentIndex !== -1) rest = rest.slice(0, queryOrFragmentIndex)

  const pathStart = rest.indexOf('/')
  let authority = pathStart === -1 ? rest : rest.slice(0, pathStart)
  const path = pathStart === -1 ? '' : rest.slice(pathStart)

  const userinfoEnd = authority.lastIndexOf('@')
  if (userinfoEnd !== -1) authority = authority.slice(userinfoEnd + 1)

  return `${scheme}${authority}${path}`
}

/**
 * Sanitizes a raw connect/reconnect failure message before it is stored in
 * `lastErrors` and served back over the unauthenticated `servers/status` RPC.
 *
 * The MCP SDK's connect failures can embed a remote server's configured
 * `url` verbatim (a `fetch failed: https://host/mcp?token=...` style
 * message), so every URL-shaped token in the message has its userinfo,
 * query string and fragment stripped, keeping only `scheme://host/path`.
 * `secretValues` additionally redacts any literal occurrence of this
 * server's own expanded env values (stdio) or header values (remote), and
 * of the recognizable parts of those values {@link expandSecretCandidates}
 * derives (e.g. just the token out of a `Bearer <token>` header, and its
 * percent-encoded form) — belt-and-suspenders for a subprocess or library
 * that happens to echo one back in an error. Finally, whitespace/newlines
 * are collapsed and the result is truncated to
 * {@link MAX_ERROR_MESSAGE_LENGTH} characters.
 */
export function sanitizeErrorMessage(message: string, secretValues: readonly string[] = []): string {
  let sanitized = message
  // Redact longer candidates first so a full configured value (e.g. a whole
  // "Bearer xyz" header) is matched and replaced with one [redacted] before
  // any of its shorter parts (e.g. just "xyz") get a chance to match inside
  // what's left, which would otherwise leave stray [redacted] fragments.
  const candidates = [...new Set(secretValues.flatMap(expandSecretCandidates))].sort((a, b) => b.length - a.length)
  for (const secret of candidates) {
    // A very short "secret" (e.g. an empty default, or a short whitespace-
    // separated token) would redact common substrings across the whole
    // message instead of the intended value, so these are skipped here.
    // They may still leak into lastError uncensored - see the ServerStatus
    // doc comment.
    if (secret.length < 3) continue
    sanitized = sanitized.split(secret).join(REDACTED)
  }

  sanitized = sanitized.replace(URL_TOKEN_PATTERN, sanitizeUrlToken)
  sanitized = sanitized.replace(/\s+/g, ' ').trim()

  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
  }
  return sanitized
}

/**
 * Extracts a concise, human-readable error description from an error,
 * including root-cause details for Node.js `TypeError: fetch failed` or network errors
 * (e.g. ConnectTimeoutError, ECONNREFUSED) without dumping multi-line stack traces.
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error) {
      const causeMsg = cause.message
      if (causeMsg && causeMsg !== err.message) {
        return `${err.message} (${causeMsg})`
      }
    } else if (cause && typeof cause === 'object') {
      const msg = (cause as { message?: unknown }).message
      const code = (cause as { code?: unknown }).code
      if (typeof msg === 'string' && msg && msg !== err.message) {
        return `${err.message} (${msg})`
      }
      if (typeof code === 'string' && code) {
        return `${err.message} (${code})`
      }
    }
    return err.message
  }
  return String(err)
}

/** Leading `<scheme> <credential>` auth header words whose credential part is worth redacting on its own. */
const AUTH_SCHEME_WORDS = /^(bearer|basic|token|bot|apikey)\s+(.+)$/i

/**
 * Expands one configured secret value (e.g. a full `Authorization` header
 * value like `Bearer abc123xyz`) into every literal form worth redacting on
 * its own, since an error message rarely echoes the whole configured value
 * verbatim — it's more likely to quote just the credential out of a header.
 * Includes: the full value; each whitespace-separated part of it that's
 * long enough to not be a common word (>= 8 chars); the credential after a
 * leading auth scheme word (Bearer/Basic/Token/Bot/ApiKey), regardless of
 * its own length as long as it's still >= 3 chars; and the percent-encoded
 * form of each of those, when it differs (a URL-embedded token is often
 * percent-encoded).
 */
function expandSecretCandidates(secret: string): string[] {
  const candidates = new Set<string>([secret])

  for (const part of secret.split(/\s+/)) {
    if (part.length >= 8) candidates.add(part)
  }

  const schemeMatch = secret.match(AUTH_SCHEME_WORDS)
  if (schemeMatch) candidates.add(schemeMatch[2])

  for (const candidate of [...candidates]) {
    const encoded = encodeURIComponent(candidate)
    if (encoded !== candidate) candidates.add(encoded)
  }

  return [...candidates]
}

/**
 * Secret values configured for one server (expanded env for stdio, expanded
 * headers for remote) — the set {@link sanitizeErrorMessage} redacts (after
 * expanding each via {@link expandSecretCandidates}) if a connect/reconnect
 * failure message happens to embed one, or a recognizable part of one,
 * verbatim.
 */
function secretValuesFor(serverConfig: ServerConfig, extra: string[] = []): string[] {
  const dict = serverConfig.transport === 'stdio' ? serverConfig.env : serverConfig.headers
  return [...Object.values(expandEnvVars(dict, process.env, new Set(serverConfig.allowedVars))), ...extra]
}

export interface ServerInstance {
  client: Client
  managedStdio?: ManagedStdio
  disposeTransport: () => Promise<void>
}

export interface ResourceResponse {
  uri: string
  html: string
  csp?: Record<string, string[]>
  permissions?: Record<string, string[]>
}

/**
 * Read-only, per-server connection status. Deliberately excludes everything
 * that could leak configuration secrets: no `command`, `args`, `env`,
 * `headers`, or `url` — the RPC endpoint that serves this must never grow
 * one of those back in. `lastError` is only best-effort sanitized by
 * {@link sanitizeErrorMessage}: it can still contain a short (< 3 char)
 * secret fragment, or any secret-derived substring the redaction pass
 * doesn't recognize. `tools`, when present, carries only each tool's
 * `rawName`/`publicName`/`visibility`/`hasUi` — never `description` or
 * `inputSchema`. `oauth`, when present, carries only a coarse `state` —
 * never a token value.
 */
export interface ServerStatus {
  name: string
  transport: ServerConfig['transport']
  connected: boolean
  toolCount: number
  uiToolCount: number
  lastError?: string
  tools?: ToolSummary[]
  oauth?: { state: 'unauthenticated' | 'authenticated' | 'expired' }
}

export const MAX_TOOLS_PER_SERVER = 256
export const MAX_RESOURCE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Byte length a base64 string decodes to, computed from the encoded string
 * itself (each 4 base64 chars encode 3 bytes, minus 1 byte per trailing `=`
 * padding char) rather than by actually decoding it. Lets callers enforce a
 * size cap on a blob without allocating a full decoded copy just to measure
 * it.
 */
function base64DecodedByteLength(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  let padding = 0
  if (base64.endsWith('==')) padding = 2
  else if (base64.endsWith('=')) padding = 1
  return Math.floor((len * 3) / 4) - padding
}

/** Byte size of one resource content item: UTF-8 bytes for text, decoded-without-decoding bytes for a blob. */
function resourceContentByteSize(content: unknown): number {
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown; blob?: unknown }
    if (typeof c.text === 'string') return Buffer.byteLength(c.text, 'utf8')
    if (typeof c.blob === 'string') return base64DecodedByteLength(c.blob)
  }
  return 0
}

/** Total byte size across every content item of a resource read result. */
function totalResourceContentBytes(contents: readonly unknown[]): number {
  return contents.reduce((sum: number, c) => sum + resourceContentByteSize(c), 0)
}

export class ServerPool {
  private ctx: Context
  private config: Config
  private toolManager: ServerToolManager
  private servers = new Map<string, ServerInstance>()
  private refreshSeq = new Map<string, number>()
  private lastAppliedSeq = new Map<string, number>()
  private lifecycleController = new AbortController()
  private startupTasks = new Map<string, Promise<void>>()
  /** Last connect/reconnect failure message per server, cleared on the next successful connect. Never holds env/headers/args. */
  private lastErrors = new Map<string, string>()
  private oauthTokenStore = new OAuthTokenStore()
  private oauthProviders = new Map<string, RemoteOAuthProvider>()
  /** Set when a connect attempt against an oauth-enabled server's stored tokens throws `UnauthorizedError`; cleared on a successful connect or fresh tokens. Never holds a token value. */
  private oauthNeedsAuth = new Map<string, boolean>()

  constructor(ctx: Context, config: Config, toolManager: ServerToolManager) {
    this.ctx = ctx
    this.config = config
    this.toolManager = toolManager
  }

  private initialSyncPromise: Promise<void> | null = null

  startAll(): Promise<void> {
    if (!this.initialSyncPromise) {
      this.initialSyncPromise = (async () => {
        const tasks = Object.entries(this.config.servers).map(async ([name, serverConfig]) => {
          const task = (async () => {
            try {
              if (this.lifecycleController.signal.aborted) return
              await this.startServer(name, serverConfig, this.lifecycleController.signal)
            } catch (err) {
              if (!this.lifecycleController.signal.aborted) {
                const rawMessage = formatErrorMessage(err)
                const sanitized = sanitizeErrorMessage(rawMessage, secretValuesFor(serverConfig, this.oauthSecretCandidates(name)))
                this.lastErrors.set(name, sanitized)
                console.warn(`mcp-apps: failed to connect to server "${name}": ${sanitized}`)
                this.scheduleReconnect(name)
              }
            } finally {
              this.startupTasks.delete(name)
            }
          })()
          this.startupTasks.set(name, task)
          return task
        })
        await Promise.allSettled(tasks)
      })()
    }
    return this.initialSyncPromise
  }

  async waitForInitialSync(timeoutMs = 15000): Promise<void> {
    if (this.initialSyncPromise) {
      await Promise.race([
        this.initialSyncPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    }
  }

  async startServer(serverName: string, serverConfig: ServerConfig, signal?: AbortSignal): Promise<void> {
    const isAborted = () => signal?.aborted || this.lifecycleController.signal.aborted
    if (isAborted()) return

    const client = new Client({
      name: 'dsh-mcp-apps',
      version: __PKG_VERSION__,
    }, {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: [RESOURCE_MIME_TYPE],
          },
        },
      },
    })

    let managedStdio: ManagedStdio | undefined
    let disposeTransport: () => Promise<void>

    if (serverConfig.transport === 'stdio') {
      managedStdio = createStdioTransport(serverConfig)
      disposeTransport = managedStdio.dispose
      try {
        await client.connect(managedStdio.transport)
      } catch (err) {
        await managedStdio.dispose().catch(() => void 0)
        await client.close().catch(() => void 0)
        throw err
      }
    } else {
      let authProvider: OAuthClientProvider | undefined
      if (serverConfig.oauth) {
        authProvider = this.getOrCreateOAuthProvider(serverName, serverConfig.oauth)
        if (!this.oauthTokenStore.getTokens(serverName)) {
          // Not yet authenticated: don't attempt to connect (and don't let
          // the SDK's internal auth() perform a premature dynamic client
          // registration against an unset redirect origin) — wait for
          // `oauth/authorize` + `oauth/callback` to obtain a token and call
          // `retryAuth`.
          return
        }
      }

      const remote = createRemoteTransport(serverConfig, authProvider, this.lifecycleController.signal)
      disposeTransport = () => remote.close()
      try {
        await client.connect(remote)
      } catch (err) {
        await remote.close().catch(() => void 0)
        await client.close().catch(() => void 0)
        if (err instanceof UnauthorizedError) {
          this.oauthNeedsAuth.set(serverName, true)
          return
        }
        throw err
      }
      this.oauthNeedsAuth.delete(serverName)
    }

    if (isAborted()) {
      await client.close().catch(() => void 0)
      await disposeTransport().catch(() => void 0)
      return
    }

    const instance: ServerInstance = {
      client,
      managedStdio,
      disposeTransport,
    }
    this.servers.set(serverName, instance)

    client.onclose = () => this.handleServerClose(serverName)

    // Dynamic tool change subscription (attached BEFORE initial sync)
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools(serverName, client)
      } catch (err) {
        console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err)
      }
    })

    await this.refreshTools(serverName, client)
    this.lastErrors.delete(serverName)
  }

  private async refreshTools(serverName: string, client: Client): Promise<void> {
    const seq = (this.refreshSeq.get(serverName) ?? 0) + 1
    this.refreshSeq.set(serverName, seq)

    const toolsResult = await client.listTools()

    // Guard against a zombie refresh: listTools() may resolve after this
    // server was stopped, evicted, or replaced by a reconnect while the
    // request was in flight. Only apply the result if this client instance
    // is still the active one for this server and the lifecycle is alive.
    if (this.lifecycleController.signal.aborted) return
    if (this.servers.get(serverName)?.client !== client) return

    if (toolsResult.tools.length > MAX_TOOLS_PER_SERVER) {
      throw new Error(`Server "${serverName}" exceeded maximum tool limit (${MAX_TOOLS_PER_SERVER})`)
    }
    const lastSeq = this.lastAppliedSeq.get(serverName) ?? 0
    if (seq < lastSeq) {
      // Outdated response; discard
      return
    }
    this.lastAppliedSeq.set(serverName, seq)

    const serverConfig = this.config.servers[serverName]
    this.toolManager.syncServerTools(serverName, client, toolsResult.tools, serverConfig)
  }

  getUiToolsSnapshot(): UiToolDescriptor[] {
    return this.toolManager.getUiToolsSnapshot()
  }

  /**
   * Read-only status of every configured server. Deliberately built from
   * only the fields on {@link ServerStatus} — never spreads `serverConfig`
   * or any part of it, so a future config field can't leak here by accident.
   */
  getStatusSnapshot(): ServerStatus[] {
    return Object.entries(this.config.servers).map(([name, serverConfig]) => {
      const { toolCount, uiToolCount } = this.toolManager.getToolCounts(name)
      return {
        name,
        transport: serverConfig.transport,
        connected: this.servers.has(name),
        toolCount,
        uiToolCount,
        lastError: this.lastErrors.get(name),
        tools: this.toolManager.getToolSummaries(name),
        oauth: serverConfig.transport === 'stdio' || !serverConfig.oauth ? undefined : {
          state: !this.oauthTokenStore.getTokens(name)
            ? 'unauthenticated' as const
            : this.oauthNeedsAuth.get(name)
              ? 'expired' as const
              : 'authenticated' as const,
        },
      }
    })
  }

  async listResources(serverName: string): Promise<unknown> {
    const instance = this.servers.get(serverName)
    if (!instance) throw new Error(`MCP server "${serverName}" is not connected`)
    return instance.client.listResources()
  }

  async readResourceRaw(serverName: string, uri?: string, signal?: AbortSignal): Promise<unknown> {
    if (!uri) throw new Error('Missing resource URI')

    const instance = this.servers.get(serverName)
    if (!instance) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }

    const serverConfig = this.config.servers[serverName]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    const response = await instance.client.readResource({ uri }, { timeout, signal })

    const contents = (response as { contents?: unknown[] }).contents ?? []
    const totalBytes = totalResourceContentBytes(contents)
    if (totalBytes > MAX_RESOURCE_SIZE_BYTES) {
      throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`)
    }

    return response
  }

  async readResource(serverName: string, uri?: string, signal?: AbortSignal): Promise<ResourceResponse> {
    if (!uri) throw new Error('Missing resource URI')

    const instance = this.servers.get(serverName)
    if (!instance) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }

    const serverConfig = this.config.servers[serverName]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    const response = await instance.client.readResource({ uri }, { timeout, signal })
    if (!response.contents || response.contents.length === 0) {
      throw new Error(`Resource ${uri} returned invalid content items`)
    }

    // Find HTML text or blob item, or fallback to first item
    const item = response.contents.find(c => {
      const mime = 'mimeType' in c ? (c as { mimeType?: string }).mimeType : undefined
      if (mime?.includes('html')) return true
      return ('text' in c && typeof c.text === 'string' && (c.text.includes('<html') || c.text.includes('<!DOCTYPE'))) ||
             ('blob' in c && typeof c.blob === 'string')
    }) ?? response.contents[0]

    if (!('text' in item && typeof item.text === 'string') && !('blob' in item && typeof item.blob === 'string')) {
      throw new Error(`Resource ${uri} returned neither text nor blob HTML`)
    }

    // Measure before decoding: for a blob this is computed from the base64
    // length alone, so an oversized item is rejected without allocating a
    // full decoded copy just to measure it.
    if (resourceContentByteSize(item) > MAX_RESOURCE_SIZE_BYTES) {
      throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`)
    }

    let html: string | undefined
    if ('text' in item && typeof item.text === 'string') {
      html = item.text
    } else if ('blob' in item && typeof item.blob === 'string') {
      html = Buffer.from(item.blob, 'base64').toString('utf8')
    }

    if (!html) {
      throw new Error(`Resource ${uri} returned neither text nor blob HTML`)
    }

    const meta = (item as { _meta?: unknown; meta?: unknown })._meta ?? (item as { meta?: unknown }).meta
    const ui = typeof meta === 'object' && meta !== null ? (meta as { ui?: { csp?: Record<string, string[]>; permissions?: Record<string, string[]> } }).ui : undefined

    let permissions = ui?.permissions
    if (permissions) {
      const allowed = new Set(serverConfig?.allowedPermissions ?? [])
      permissions = Object.fromEntries(
        Object.entries(permissions).filter(([key]) => {
          if (['camera', 'microphone', 'geolocation'].includes(key)) {
            return allowed.has(key)
          }
          return true
        })
      )
    }

    return {
      uri,
      html,
      csp: ui?.csp,
      permissions,
    }
  }

  async callTool(
    serverName: string,
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const instance = this.servers.get(serverName)
    if (!instance) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }
    const serverConfig = this.config.servers[serverName]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    return instance.client.callTool(
      {
        name,
        arguments: args ?? {},
      },
      undefined,
      { timeout, signal }
    )
  }

  private reconnectAttempts = new Map<string, number>()
  private reconnectTimers = new Map<string, NodeJS.Timeout>()

  handleServerClose(serverName: string): void {
    this.toolManager.evictServer(serverName)
    this.servers.delete(serverName)
    this.scheduleReconnect(serverName)
  }

  private scheduleReconnect(serverName: string): void {
    if (this.lifecycleController.signal.aborted) return

    const serverConfig = this.config.servers[serverName]
    const opts = serverConfig?.reconnectOptions
    if (!opts) return

    const attempts = this.reconnectAttempts.get(serverName) ?? 0
    const maxRetries = opts.maxRetries ?? 5
    if (attempts >= maxRetries) {
      console.warn(`mcp-apps: max reconnect attempts reached for "${serverName}"`)
      return
    }

    const factor = opts.backoffFactor ?? 1.5
    const initial = opts.initialDelayMs ?? 1000
    const maxDelay = opts.maxDelayMs ?? 30000
    const delay = Math.min(initial * Math.pow(factor, attempts), maxDelay)

    this.reconnectAttempts.set(serverName, attempts + 1)

    // Avoid double reconnects: drop any timer already pending for this
    // server before scheduling the new one.
    const existingTimer = this.reconnectTimers.get(serverName)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverName)

      if (this.lifecycleController.signal.aborted) return
      // A startServer() for this name is already running (e.g. from a
      // prior reconnect or the initial startAll); don't start a second one.
      if (this.startupTasks.has(serverName)) return

      const task = (async () => {
        try {
          await this.startServer(serverName, serverConfig, this.lifecycleController.signal)
          this.reconnectAttempts.delete(serverName)
          this.lastErrors.delete(serverName)
        } catch (err) {
          const rawMessage = formatErrorMessage(err)
          const sanitized = sanitizeErrorMessage(rawMessage, secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)))
          this.lastErrors.set(serverName, sanitized)
          console.warn(`mcp-apps: reconnect attempt ${attempts + 1} failed for "${serverName}": ${sanitized}`)
          this.scheduleReconnect(serverName)
        } finally {
          this.startupTasks.delete(serverName)
        }
      })()
      this.startupTasks.set(serverName, task)
      await task
    }, delay)
    this.reconnectTimers.set(serverName, timer)
  }

  private getOrCreateOAuthProvider(serverName: string, options: true | OAuthOptions): RemoteOAuthProvider {
    let provider = this.oauthProviders.get(serverName)
    if (!provider) {
      provider = new RemoteOAuthProvider(serverName, options, this.config.externalUrl ?? '', this.oauthTokenStore)
      this.oauthProviders.set(serverName, provider)
    }
    return provider
  }

  /** Extra redaction candidates for {@link sanitizeErrorMessage}: this server's current access/refresh token, if any. */
  private oauthSecretCandidates(serverName: string): string[] {
    const tokens = this.oauthTokenStore.getTokens(serverName)
    if (!tokens) return []
    return [tokens.accessToken, tokens.refreshToken].filter((v): v is string => typeof v === 'string')
  }

  /** Sanitizes an error for one server the same way a connect/reconnect failure is (see `sanitizeErrorMessage`), for callers outside this class (e.g. the `oauth/*` RPC handlers in `src/index.ts`) that surface an error for an unauthenticated caller. */
  sanitizeError(serverName: string, err: unknown): string {
    const serverConfig = this.config.servers[serverName]
    const rawMessage = err instanceof Error ? err.message : String(err)
    if (!serverConfig) return sanitizeErrorMessage(rawMessage)
    return sanitizeErrorMessage(rawMessage, secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)))
  }

  /** Serializes async work per server name (a promise chain keyed by `serverName`), so two concurrent `oauth/authorize` calls for the same not-yet-registered server can't each perform their own dynamic client registration and race to persist a different client. */
  private oauthLocks = new Map<string, Promise<unknown>>()
  private withOAuthLock<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.oauthLocks.get(serverName) ?? Promise.resolve()
    const run = prior.then(fn, fn)
    this.oauthLocks.set(serverName, run.then(() => void 0, () => void 0))
    return run
  }

  /**
   * Resolves the authorize URL for an oauth-enabled server: performs RFC
   * 9728/8414 discovery, registers a dynamic client if none is configured or
   * already registered, then calls the SDK's low-level `startAuthorization`
   * directly instead of the `auth()` orchestrator — `auth()` is built to
   * drive an interactive flow itself (redirecting a user agent it controls),
   * but the authorize URL here has to be handed back over RPC for the
   * caller's own browser to open, so this plugin never lets `auth()` (or
   * `redirectToAuthorization`, see `RemoteOAuthProvider`) drive that part;
   * `completeOAuthCallback` below likewise calls `exchangeAuthorization`
   * directly rather than going through `auth()`.
   *
   * The redirect URI is built from `Config.externalUrl`, never from a
   * request: an inbound request's own URL/Host header is caller-controlled
   * and would let an anonymous caller poison this server's persisted OAuth
   * client registration (`registerClient` below) with an attacker-chosen
   * redirect target.
   */
  async getAuthorizeUrl(serverName: string): Promise<string> {
    const serverConfig = this.config.servers[serverName]
    if (!serverConfig || serverConfig.transport === 'stdio' || !serverConfig.oauth) {
      throw new Error(`Server "${serverName}" is not configured for OAuth`)
    }
    if (!this.config.externalUrl) {
      throw new Error('OAuth requires `externalUrl` to be configured on this plugin (see README.md#configure)')
    }
    const oauth = serverConfig.oauth

    return this.withOAuthLock(serverName, async () => {
      const provider = this.getOrCreateOAuthProvider(serverName, oauth)

      const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } = await discoverOAuthServerInfo(serverConfig.url)

      let clientInformation = await provider.clientInformation()
      if (!clientInformation) {
        clientInformation = await registerClient(authorizationServerUrl, {
          metadata: authorizationServerMetadata,
          clientMetadata: provider.clientMetadata,
        })
        await provider.saveClientInformation(clientInformation)
      }

      const scope = oauth === true ? undefined : oauth.scopes?.join(' ')
      const state = crypto.randomUUID()
      const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
        metadata: authorizationServerMetadata,
        clientInformation,
        redirectUrl: provider.redirectUrl,
        scope,
        state,
        resource: resourceMetadata ? new URL(resourceMetadata.resource) : undefined,
      })

      this.oauthTokenStore.setPendingVerifier(serverName, state, codeVerifier)
      return authorizationUrl.toString()
    })
  }

  /**
   * Completes an authorization-code exchange for the `oauth/callback` route,
   * stores the resulting tokens, and re-triggers `startServer` for that one
   * server so it connects with them.
   */
  async completeOAuthCallback(serverName: string, code: string, state: string): Promise<void> {
    const serverConfig = this.config.servers[serverName]
    if (!serverConfig || serverConfig.transport === 'stdio' || !serverConfig.oauth) {
      throw new Error(`Server "${serverName}" is not configured for OAuth`)
    }

    const pending = this.oauthTokenStore.getPendingVerifier(serverName, state)
    if (!pending) {
      throw new Error('No matching pending authorization for this state (it may have expired)')
    }

    const provider = this.getOrCreateOAuthProvider(serverName, serverConfig.oauth)
    const clientInformation = await provider.clientInformation()
    if (!clientInformation) {
      throw new Error(`No OAuth client registered for server "${serverName}"`)
    }

    const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } = await discoverOAuthServerInfo(serverConfig.url)

    const tokens = await exchangeAuthorization(authorizationServerUrl, {
      metadata: authorizationServerMetadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: pending.codeVerifier,
      redirectUri: provider.redirectUrl,
      resource: resourceMetadata ? new URL(resourceMetadata.resource) : undefined,
    })

    await provider.saveTokens(tokens)
    this.oauthTokenStore.deletePendingVerifier(serverName, state)
    this.oauthNeedsAuth.delete(serverName)
    this.retryAuth(serverName)
  }

  /** Re-triggers `startServer` for one server after fresh tokens are stored, reusing `startupTasks` bookkeeping to avoid double-connecting. */
  retryAuth(serverName: string): void {
    if (this.lifecycleController.signal.aborted) return
    if (this.startupTasks.has(serverName)) return
    const serverConfig = this.config.servers[serverName]
    if (!serverConfig) return

    const task = (async () => {
      try {
        await this.startServer(serverName, serverConfig, this.lifecycleController.signal)
        this.lastErrors.delete(serverName)
      } catch (err) {
        const rawMessage = formatErrorMessage(err)
        const sanitized = sanitizeErrorMessage(rawMessage, secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)))
        this.lastErrors.set(serverName, sanitized)
        console.warn(`mcp-apps: post-auth connect failed for "${serverName}": ${sanitized}`)
      } finally {
        this.startupTasks.delete(serverName)
      }
    })()
    this.startupTasks.set(serverName, task)
  }

  /**
   * Manually retries connecting to a server (e.g. from the UI "Retry" button).
   * Resets reconnect backoff counters and cancels any pending timer.
   */
  async retryServer(serverName: string): Promise<void> {
    const serverConfig = this.config.servers[serverName]
    if (!serverConfig) {
      throw new Error(`Server "${serverName}" is not configured`)
    }

    const timer = this.reconnectTimers.get(serverName)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(serverName)
    }
    this.reconnectAttempts.delete(serverName)

    await this.startServer(serverName, serverConfig, this.lifecycleController.signal)
  }

  /**
   * Disconnects an OAuth-authenticated server, stops any reconnect attempts,
   * evicts its tools from the host, and clears stored credentials.
   */
  async disconnectOAuth(serverName: string): Promise<void> {
    const serverConfig = this.config.servers[serverName]
    if (!serverConfig || serverConfig.transport === 'stdio' || !serverConfig.oauth) {
      throw new Error(`Server "${serverName}" is not configured for OAuth`)
    }

    return this.withOAuthLock(serverName, async () => {
      const timer = this.reconnectTimers.get(serverName)
      if (timer) {
        clearTimeout(timer)
        this.reconnectTimers.delete(serverName)
      }
      this.reconnectAttempts.delete(serverName)

      const instance = this.servers.get(serverName)
      if (instance) {
        instance.client.onclose = undefined
        this.servers.delete(serverName)
        this.toolManager.evictServer(serverName)
        try {
          await instance.client.close().catch(() => void 0)
          await instance.disposeTransport().catch(() => void 0)
        } catch (err) {
          console.error(`mcp-apps: error closing server "${serverName}" on disconnect:`, err)
        }
      }

      this.oauthTokenStore.clear(serverName)
      this.oauthProviders.delete(serverName)
      this.oauthNeedsAuth.delete(serverName)
      this.lastErrors.delete(serverName)
    })
  }

  async stopAll(): Promise<void> {
    this.lifecycleController.abort()
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()

    await Promise.allSettled(Array.from(this.startupTasks.values()))

    for (const [name, instance] of this.servers.entries()) {
      try {
        await instance.client.close().catch(() => void 0)
        await instance.disposeTransport().catch(() => void 0)
      } catch (err) {
        console.error(`mcp-apps: error stopping server "${name}":`, err)
      }
      this.toolManager.evictServer(name)
    }
    this.servers.clear()
  }
}
