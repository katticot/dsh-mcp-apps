# Design: OAuth for remote MCP servers

Status: draft design, not yet implemented. No `oauth.ts`, callback route, or
`OAuthClientProvider` exists in this codebase today — this document specs
what to build.

## Why this differs from the pasted proposal

The proposal (a `Thought for 10s` transcript) sketched a `src/transports/oauth/`
engine that hand-rolls RFC 9728 discovery, RFC 7591 Dynamic Client
Registration, and PKCE. Checked against what's actually installed here:

- **`@modelcontextprotocol/sdk@1.30.0` (`dependencies`, confirmed via
  `pnpm list`) already implements all of it.** `client/auth.ts` exports a full
  `OAuthClientProvider` interface plus orchestration: `auth()`,
  `discoverOAuthProtectedResourceMetadata()` (RFC 9728),
  `discoverAuthorizationServerMetadata()` (RFC 8414),
  `registerClient()` (RFC 7591 DCR), `startAuthorization()` /
  `exchangeAuthorization()` / `refreshAuthorization()` (PKCE, S256, code
  exchange, refresh). `StreamableHTTPClientTransport` and
  `SSEClientTransport` both take an `authProvider?: OAuthClientProvider`
  constructor option and drive that whole flow internally — attach the
  existing access token, transparently refresh on expiry, and throw
  `UnauthorizedError` when a fresh authorize step is needed. There is no
  discovery/DCR/PKCE engine left to write; the work is **implementing
  `OAuthClientProvider`** (token persistence + redirect handling) and wiring
  it into `createRemoteTransport` (`src/transports/remote.ts`).
- **The callback endpoint is simpler than "loopback listener vs. new web
  route."** `HostConnectionFetch.register()` (from
  `@deepseek-ai/dsh-client-connection`, already a required peer) accepts
  `methods: ('GET' | 'HEAD' | 'POST')[]` and an arbitrary path below `/api`
  with query parameters preserved on the request URL (`rpc.d.ts`,
  `ConnectionFetchRoute`). `src/index.ts` already registers five POST routes
  this way. A sixth, GET, route — `/api/mcp-apps/oauth/callback` — needs
  nothing new from the host. No loopback HTTP server, no separate process.
  (One caveat carried over from the existing routes: `createSharedFetchHandler`
  applies DSH's own Host/Origin + browser-session checks before a route's
  `fetch` runs, per `ConnectionFetchHandler`'s doc comment — the callback
  still works because the IdP redirects the *user's own already-authenticated
  browser tab* back to it, not a bare server-to-server call.)
- **There is no host-provided place to persist anything.** Checked
  `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-subprocess`, and
  `@deepseek-ai/cordis` for a data/profile directory service — none exists.
  `AppSessionStore` (`src/session-store.ts`) is in-memory only, and
  `docs/dsh-compatibility.md`'s host-service table lists nothing for
  storage. So a token store under `~/.dsh/mcp-apps/` (as the proposal
  suggested) is not a host convention we're plugging into — it's a new
  filesystem contract this plugin would own and must document.
- **There is already a documented workaround.** `README.md`'s Configure
  section already tells users to run `mcp-remote` as a `stdio` subprocess for
  an OAuth-protected server (`servers.my-oauth-server` example). This design
  adds a native path; it should not remove that documented option, since
  users already depend on it and it still covers servers where no browser is
  available (headless/CI profiles).
- **Config schema has no `oauth` key today.** `RemoteServerConfig`
  (`src/config.ts`) is `{ transport, url, headers, toolCallTimeoutMs,
  reconnectOptions, allowAppToolCalls, allowedPermissions, allowedVars,
  maxMessageBytes }` — no `oauth` field, and the `Config` schema (built with
  `@deepseek-ai/schemastery`) has no matching union member. This is new
  schema, not a rename.
- **The client UI only exists for `web`.** `McpAppsStatusSection.tsx` is a
  read-only status list today (server name, transport, connected, tool
  counts) — no per-server action buttons at all. Per the README
  troubleshooting section, this component doesn't render outside the `web`
  profile, so "Connect Account" is inherently `web`-profile-only, same as the
  rest of the client bundle.

Everything else in the proposal — discover-on-401, PKCE, DCR, a token
lifecycle manager, and a status badge with a connect button — is directionally
right and is kept below, just re-scoped against what the SDK already gives us
for free.

## Scope

In scope:
- `oauth: true | { clientId?, clientSecret?, scopes? }` on `RemoteServerConfig`
  (`sse` / `streamable-http` only; `stdio` keeps using `mcp-remote` or its own
  env-based auth).
- One `OAuthClientProvider` implementation, one file-backed token store, one
  GET callback route, three new RPC endpoints, one UI affordance.

Out of scope (flag as follow-ups, not blocking v1):
- `client_credentials` / non-interactive grants (SDK supports a
  `grantType`-parameterized flow via `OAuthClientProvider#invalidateCredentials`
  and grant-specific request prep, but the proposal and this design are both
  scoped to the interactive authorization-code + PKCE flow a human approves).
- Encryption at rest for the token file (see Open questions).
- Multi-window/device sign-in races beyond a single in-flight authorization
  per server (see Concurrency below).

## Architecture

```
 DSH web profile (browser)                    dsh-mcp-apps (Node host plugin)
 ───────────────────────                       ──────────────────────────────
 McpAppsStatusSection                           src/index.ts
   "● Requires Auth"                              /api/mcp-apps/oauth/status
   [Connect Account] ──POST status──────────►      /api/mcp-apps/oauth/authorize
                                                    /api/mcp-apps/oauth/callback (GET)
        │ opens popup to authorize URL                     │
        ▼                                                  ▼
   IdP authorize page                          src/transports/oauth-provider.ts
        │ user approves                          DshOAuthClientProvider
        │ redirect ──GET code+state──────────►     implements OAuthClientProvider
                                                    - clientInformation()/saveClientInformation()
                                                    - tokens()/saveTokens()
                                                    - codeVerifier()/saveCodeVerifier()
                                                    - redirectUrl (fixed: the callback route above)
                                                          │
                                                          ▼
                                                 src/transports/oauth-token-store.ts
                                                    reads/writes ~/.dsh/mcp-apps/oauth/<server>.json
                                                          │
                                                          ▼
                                                 src/transports/remote.ts
                                                    createRemoteTransport(config, provider?)
                                                    passes { authProvider } to
                                                    StreamableHTTPClientTransport / SSEClientTransport
                                                          │
                                                          ▼
                                                 server-pool.ts: client.connect(transport)
                                                    SDK: attach access token, refresh silently,
                                                    or throw UnauthorizedError → status flips to
                                                    "needs-auth" instead of endless reconnect
```

The SDK's `auth()` / transport-level `authProvider` handling covers the
"Dynamic Token Refresher" and "Dynamic Header Injection" boxes from the
proposal's diagram entirely — there is no custom fetch wrapper or refresh
timer to write; that's what `authProvider` on the transport already does on
every request.

## Config schema

```yaml
servers:
  linear-mcp:
    transport: streamable-http
    url: 'https://mcp.linear.app/mcp'
    oauth: true                # auto-discovery: RFC 9728 + RFC 8414 + RFC 7591 DCR
  # or, for a server that requires a pre-registered client:
  github-mcp:
    transport: streamable-http
    url: 'https://mcp.github.example.com/mcp'
    oauth:
      clientId: '${GITHUB_MCP_CLIENT_ID}'
      clientSecret: '${GITHUB_MCP_CLIENT_SECRET}'
      scopes: ['repo', 'read:org']
```

`src/config.ts` additions:

```ts
export interface OAuthOptions {
  clientId?: string
  clientSecret?: string
  scopes?: string[]
}

export interface RemoteServerConfig {
  // ...existing fields
  oauth?: true | OAuthOptions
}
```

`clientSecret` follows the same `Schema.string().role('secret')` +
`${VAR}` expansion + `allowedVars` treatment `headers` values already get in
`expandEnvVars` — it must never appear in `ServerStatus` or in a sanitized
error message, exactly like the existing `headers`/`env` handling in
`secretValuesFor()` (`server-pool.ts`).

## `OAuthClientProvider` implementation

One instance per `oauth`-enabled server, constructed in `createRemoteTransport`
alongside the existing `expandedHeaders`/`cappedFetch` setup:

- `redirectUrl`: fixed, host-wide constant —
  `<dsh-web-origin>/api/mcp-apps/oauth/callback?server=<name>` — not
  per-server-configurable, so it can be safelisted with the IdP once.
- `clientMetadata`: `{ client_name: 'dsh-mcp-apps', redirect_uris: [redirectUrl],
  grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method:
  clientSecret ? 'client_secret_basic' : 'none', scope: options.scopes?.join(' ') }`.
- `clientInformation()` / `saveClientInformation()`: static passthrough of
  `clientId`/`clientSecret` when configured; otherwise reads/writes the DCR
  result via the token store (so registration happens once per server, not
  once per process start).
- `tokens()` / `saveTokens()`: file-backed, see below.
- `codeVerifier()` / `saveCodeVerifier()`: also file-backed (short-lived —
  cleared once exchanged), keyed by `state` so two concurrent authorize
  attempts for the same server (two browser tabs) don't clobber each other's
  verifier.
- `redirectToAuthorization(url)`: this side (Node host) never opens a
  browser itself — the authorize URL is instead returned to the client over
  RPC (`oauth/authorize`) and the *client* opens the popup. The SDK's
  `auth()` returns `'REDIRECT'` plus the URL is separately obtainable via
  `startAuthorization()`, so the RPC handler calls `auth()` and reports the
  URL back rather than relying on this callback firing server-side.
- `validateResourceURL`: left to SDK default (validates the returned
  `resource` matches the configured server URL — protects against a
  malicious AS handing back tokens scoped to a different resource).
- `invalidateCredentials('tokens')`: called when `server-pool.ts` sees a
  `401`/`UnauthorizedError` from an established connection (token revoked
  server-side) — clears the stored token so the next connect attempt starts
  a fresh authorize instead of retrying a dead token forever.

## Token store

`src/transports/oauth-token-store.ts`:

- One JSON file per server: `~/.dsh/mcp-apps/oauth/<server-name>.json`
  (directory `0700`, file `0600`, matching the existing `EXTRA_BLOCKED_ENV_VARS`
  / secret-handling posture elsewhere in this codebase). Never inside the
  git-tracked plugin directory.
- Contents: `{ clientInformation?, tokens?: { accessToken, refreshToken,
  expiresAt, scope }, pendingVerifiers: Record<state, { codeVerifier,
  createdAt }> }`.
- `pendingVerifiers` entries older than 10 minutes are pruned on every read
  (an abandoned authorize attempt shouldn't accumulate indefinitely).
- **Open question** (see below): plaintext-on-disk vs. OS keychain. Proposal
  said "encrypted or filesystem-scoped" without picking one — this design
  defaults to filesystem-scoped (mode `0600`) for v1, matching how `headers`/
  `env` secrets are already handled (never encrypted, just access-controlled
  and redacted from any RPC-visible surface), and calls out keychain
  integration as a v2 candidate since it would need a per-OS dependency
  (`keytar`-equivalent) this repo doesn't currently have.

## New RPC endpoints (`src/index.ts`)

Added to the existing `endpoints` tuple and `handleEndpoint` switch,
following the same `ConnectionRpcResult` pattern as `servers/status`:

| Endpoint | Method | Auth | Behavior |
| --- | --- | --- | --- |
| `oauth/status` | POST (existing pattern) | none (like `servers/status`: no secrets in the shape) | Per-`oauth`-enabled server: `'unauthenticated' \| 'authenticated' \| 'expired' \| 'error'`. Folded into the existing `servers/status` response as an optional `oauth?: OAuthStatus` field on `ServerStatus`, so the UI doesn't need a second poll. |
| `oauth/authorize` | POST | none — this *starts* auth, nothing to authenticate yet | `{ server: string }` → calls SDK `auth(provider, { serverUrl })`, returns `{ authorizeUrl }` for the client to open in a popup. |
| `oauth/callback` | **GET** (new route kind) | DSH's existing Host/Origin browser check (same as other routes) | Reads `code`/`state`/`error` off `request.url` query string, resolves the pending verifier keyed by `state`, calls `exchangeAuthorization` under the hood via `auth(provider, { serverUrl, authorizationCode: code })`, then returns a small self-closing HTML page (`window.close()`) so the popup dismisses itself and the opener refreshes via the existing `ui-tools/changed`/`connection/reset` events `McpAppsStatusSection` already listens for. |

`oauth/callback` is the one route that isn't JSON RPC — it needs
`requestBody: 'buffered'` is irrelevant (GET has no body) and the handler
returns `text/html`, not `Response.json(...)`. This is a second Fetch-route
shape alongside the five existing POST/JSON ones; `ConnectionFetchRoute`
already supports it (`methods`, arbitrary `fetch: (request) => Promise<Response>`),
so nothing in `dsh-client-connection` needs to change.

## Server-pool integration

`server-pool.ts#startServer` currently does `await client.connect(transport)`
inside a try/catch that only distinguishes "connected" vs "not connected,
retry with backoff." For an `oauth`-enabled server, add a third outcome:

- Catch `UnauthorizedError` specifically (imported from
  `@modelcontextprotocol/sdk/client/auth.js`) and set a new
  `needsAuth: true` flag in `lastErrors`/`ServerStatus`, **skip** the
  exponential-backoff reconnect loop for that server (retrying a connection
  that needs a human to click "Connect Account" wastes reconnect budget and
  spams `lastError`), and resume normal `startServer()` once `oauth/callback`
  successfully stores a token (reuse the existing `handleServerClose` /
  `startupTasks` machinery to avoid a second concurrent `startServer` call).

## UI: `McpAppsStatusSection.tsx`

- `ServerStatus` gains `oauth?: { state: 'unauthenticated' | 'authenticated' | 'expired' }` (parsed defensively like the rest of `parseServerStatus`, dropped if malformed — same "best-effort read-only display" posture already documented on this component).
- Row gets a badge (`● Requires Auth` / `● Connected`, styled like the
  existing `ConnectionPill`) and, only when `unauthenticated`/`expired`, a
  `[Connect Account]` button next to the existing `ConnectionPill`.
- Click handler: `rpc.call('/api', 'mcp-apps/oauth/authorize', { server })`
  → `window.open(authorizeUrl, '_blank', 'popup')`. No polling loop needed —
  `oauth/callback`'s closing page plus the existing `connection/reset` /
  `ui-tools/changed` event subscription (already wired in this component's
  `useEffect`) is what triggers the re-fetch after the popup closes.

## Security considerations

- PKCE (S256) is mandatory — the SDK always generates and validates it; no
  config knob to disable it.
- `state` is single-use and expires with its `pendingVerifiers` entry (10
  min), closing the CSRF window the proposal's diagram implies but doesn't
  spell out.
- `redirectUrl` is fixed and server-side-constructed from the DSH host's own
  origin — never taken from client input — so an attacker can't redirect an
  authorization code to an off-host listener.
- `clientSecret`, `accessToken`, `refreshToken` must never appear in
  `ServerStatus` (the `oauth` field above is intentionally state-only, no
  token values) or in `sanitizeErrorMessage()` output — extend
  `secretValuesFor()` in `server-pool.ts` to also include the current
  access/refresh token for a server so an SDK error that happens to echo one
  gets redacted the same way header secrets already do.
- Token file permissions (`0600`)/directory (`0700`) enforced on write, not
  just assumed from `umask`.
- `https://` only for the callback and authorize/token endpoints — this
  reuses the loopback-exception logic already in `createRemoteTransport`
  (`url.protocol === 'http:' && !isLoopback` throws), so an OAuth-protected
  server misconfigured with a plain-`http://` authorization server fails the
  same way a plain-`http://` MCP endpoint already does.

## Concurrency / edge cases

- Two browser tabs both open in DSH and one clicks "Connect Account" while a
  prior authorize is still pending for the same server: second `oauth/authorize`
  call is fine (fresh `state`+verifier pair); an abandoned first attempt just
  ages out via the 10-minute prune.
- Server restarts mid-flow (DSH plugin reload) before the callback lands:
  `pendingVerifiers` is on disk, not in memory, so it survives a plugin
  restart within the plugin process but not a full profile restart that
  changes the token file's location — acceptable, since the user can just
  retry "Connect Account."
- A server that returns `oauth: true` but never actually requires it (no
  `401`/`WWW-Authenticate`): SDK's `auth()` orchestration only engages the
  flow when the server signals it's needed, so this is a config no-op, not
  an error — matches the proposal's "auto-discovery" framing.

## Testing plan

Following this repo's existing patterns (`tests/dsh-host-contract.spec.ts`,
`server-pool` unit tests):
- Unit: `oauth-token-store.ts` (file round-trip, permission bits, pruning,
  concurrent-state isolation) — no network.
- Unit: `DshOAuthClientProvider` against a fake `OAuthClientProvider`
  contract test (can reuse the SDK's own `simpleOAuthClientProvider` example
  under `examples/client/` as a reference implementation to diff against).
- Integration: fake authorization server (RFC 9728 metadata + RFC 7591 DCR +
  token endpoint) spun up in-test, `createRemoteTransport` with `oauth: true`
  against it, assert `UnauthorizedError` before authorize and successful
  connect after simulating the callback.
- `servers/status` / `oauth/status` RPC: extend `dsh-host-contract.spec.ts`
  style tests to assert `oauth` never leaks a token value.
- No new browser/artifact test is strictly required for the button itself
  beyond the existing `McpAppsStatusSection` unit tests (React Testing
  Library, per the existing file's structure) plus one manual smoke pass
  against a real OAuth-protected MCP server before release, same as
  `docs/dsh-compatibility.md`'s existing smoke-test posture.

## Open questions (need a decision before implementation)

1. **Token file encryption.** Plaintext + `0600` (matches existing secret
   posture in this repo) vs. OS keychain (new dependency, better protection
   against another local process reading the file). Recommend plaintext for
   v1 given no existing precedent for keychain integration here.
2. **Callback route path stability.** `/api/mcp-apps/oauth/callback` becomes
   part of every OAuth app registration (client_id / redirect_uri on file
   with each IdP) — changing it later breaks every user's existing
   registration. Confirm this path before shipping v1.
3. **Multi-server DCR reuse.** If two configured servers share the same
   authorization server (same `issuer`), should they share one registered
   client, or register independently per server name (simpler, matches the
   "one token file per server name" model above, at the cost of duplicate
   DCR registrations)? This design defaults to independent-per-server.

## Phased rollout

1. Config schema + `oauth-token-store.ts` + `DshOAuthClientProvider`, no UI —
   testable end-to-end via a fake AS in CI.
2. `oauth/authorize` + `oauth/callback` RPC/route wiring, `server-pool.ts`
   `UnauthorizedError` handling.
3. `McpAppsStatusSection` badge + button.
4. Docs: README Configure section gains an `oauth: true` example alongside
   the existing `mcp-remote` one (kept, not replaced); `docs/how-it-works.md`
   gains an OAuth subsection; `docs/dsh-compatibility.md`'s host-service
   table gets a row noting the new filesystem contract (`~/.dsh/mcp-apps/oauth/`)
   isn't a host-provided service.
