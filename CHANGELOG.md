# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.6] - 2026-11-05

### Added

- **`ui/message` form submissions (SEP-1865)**: forms inside rendered MCP Apps now reach the agent. The client bridge registers a `ui/message` handler and declares the `message: { text: {} }` host capability; a new `mcp-apps/messages` endpoint resolves the session's bound agent and delivers validated text as a user-role turn via `agent.followup()` — the same path as typed input. Fixes #11.
- **`allowAppMessages` (per server, default `'approve'`)**: a `'deny' | 'approve' | 'allow'` setting (a plain `boolean` is accepted as legacy shorthand for `'deny'`/`'allow'`) gating form-submission delivery. Under `'approve'`, the first message of each app session asks the human through DSH's approval prompt (server, tool, and an 80-character preview are shown); once granted, further messages from the same session flow without prompting. Every outcome other than `'allowed-once'` fails closed. The approval service is injected whenever any server's effective messages policy is `'approve'`, not only for `allowAppToolCalls: 'approve'` configs.
- **Provenance on delivered messages**: every delivered message carries the source `{ kind: 'mcp-apps', server, tool }` and a visible prefix, `[Submitted via MCP App "<server>" / "<tool>" — app-controlled content, not typed by the user]`, so the model and the transcript reader can tell app-submitted text from typed input (the DSH UI does not yet render unknown source kinds). Server and tool names are sanitized before interpolation — invisible or bidirectional control characters stripped, whitespace collapsed, quotes neutralized, length capped — so a crafted tool name cannot smuggle hidden characters or spoof the marker; the raw names remain in the durable source kind and the host-side delivery log (server, tool, agent, size; never message text or the session token).
- **Content bounds**: text-only delivery (non-text blocks rejected with an explicit error instead of silently dropped), max 32,768 characters and 32 blocks per message, whitespace-only content rejected (matching the human prompt path), and text containing Unicode tag characters (U+E0000–U+E007F) or bidirectional controls (U+061C, U+202A–U+202E, U+2066–U+2069) rejected — characters that render as nothing in a transcript while the model reads them.
- **Per-session rate limit**: max 6 delivered messages per 60-second sliding window per app session, rejected with a `too-many-requests` failure; the counter lives on the session and dies with its 1-hour TTL.
- **Tests**: server coverage for the policy gate, consent-once semantics, fail-closed approval outcomes, boolean shorthand, approval-service injection, every content bound, the rate limit and its sliding window, provenance stamping, and app-facing error hygiene (no agent identifiers); client coverage for `bridge.onmessage` forwarding, the `message` capability declaration, and endpoint-failure surfacing. The smoke fixture renders a real form that submits via `app.sendMessage(...)`, and `scripts/smoke-dsh.mjs` gains a `--messages-policy=` flag; the end-to-end run verifies the approval prompt appears while the agent is idle and the delivered message lands with visible provenance.
- **README**: new "App Message (ui/message) Security Model" section and a config reference row for `allowAppMessages`.

### Changed

- `@deepseek-ai/dsh-llm` (`^0.2.1-rc.5`) is now a required peer: the host bundle imports `createUserMessage` at runtime to build delivered messages. Optional peers are unchanged.

## [0.2.5] - 2026-11-05

### Changed

- **DSH `0.2.1-rc.5` compatibility**: all `@deepseek-ai/dsh-*` peer ranges bumped from `^0.1.7-rc.2` to `^0.2.1-rc.5`, and the matching devDependencies from the exact `0.1.7-rc.2` to the exact `0.2.1-rc.5`. DSH's `evaluatePluginCompatibility` checker rejects plugins whose dsh peers don't satisfy the running version, so `0.2.4` and earlier refuse to load on the `0.2.1-rc.5` runtime (the version now shipped inside the DeepSeek Harness desktop application).
- Cordis devDependency repinned to the exact `4.0.5` the `0.2.1-rc.5` runtime ships; the `^4.0.2` peer range is unchanged (cordis is not covered by the DSH checker).
- `scripts/smoke-dsh.mjs` now installs and runs `@deepseek-ai/dsh@0.2.1-rc.5` for the packaged smoke test.
- `docs/dsh-compatibility.md` and the README compatibility table updated to the new baseline.

### Removed

- **`@deepseek-ai/dsh-client-ui-slots` peer**: the package no longer exists in the DSH `0.2.1-rc.5` runtime; the browser `slots` service is now provided by `@deepseek-ai/dsh-client-ui-renderer`. This plugin never imported the package (the client code injects the `slots` service by name only), so the peer was dropped rather than retargeted. The `tool.call.toolview` and `plugins.detail.section` slot names this plugin registers against are unchanged.

### Fixed

- **Client: app views no longer silently disappear when the turn folds.** The `McpAppToolView` reveal loop bound its MutationObserver target — and the user-gesture listeners that make a manual collapse stick — eagerly, on the first React commit where the iframe exists. The chat host commits the turn-process disclosure around the tool block on a later commit, so that eager binding watched a node too deep to ever observe the host's fold mutations; only the one-shot 300–2500 ms reveal timers defended the view, and a fold landing after they expired was final. The binding is now self-healing: every reveal pass re-resolves the target from the live iframe and re-binds the observer and listeners when it changes, and the effect cleanup removes listeners from the currently-bound node. Adds `tests/client-plugin-race.spec.ts`, which reproduces the real host commit order (the view mounts outside the disclosure, which is committed around the block afterwards) and fails against the old eager binding.
- `tests/dsh-host-contract.spec.ts` now passes an owner `PeerScope` to `ConnectionFetchHandler.fetch`: under DSH `0.2.1-rc.5` the shared-channel fetch handler takes a required `peer` argument and answers `403` for exact routes when the dispatching peer's principal is not `owner` (the plugin's own registered routes are unaffected — the dispatcher invokes them with the request only).

## [0.2.4] - 2026-09-30

### Added

- **Remote MCP Server OAuth 2.0 / PKCE Support**:
  - Secure file-backed OAuth token store (`~/.dsh/mcp-apps/oauth/<server>.json`) with restricted filesystem permissions (`0700` directory, `0600` token file) persisting access tokens, refresh tokens, and dynamic client registration records across DSH restarts.
  - Full OAuth 2.0 authorization code flow with PKCE (RFC 7636) and metadata discovery (RFC 8414 / RFC 9728).
  - Dynamic client registration (RFC 7591) support alongside pre-configured static client credentials.
  - Dedicated `/api/mcp-apps/oauth/callback` web route with popup authentication window coordination via `window.opener.postMessage`.
  - Disconnect / logout endpoint (`/api/mcp-apps/oauth/disconnect`) and "Disconnect" button in the Plugins UI status section to cleanly revoke tokens and unregister tools.
  - `externalUrl` configuration setting for deployments behind reverse proxies or external URLs to ensure accurate OAuth redirect URIs.
- **Resilient Remote Server Lifecycle & Error Handling**:
  - Concise single-line network error reporting: unwraps nested Node.js/Undici causes (`ConnectTimeoutError`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`) instead of printing raw multi-line stack traces to stdout/stderr.
  - Exponential backoff with jitter for automatic server reconnection on connection drop or startup failure.
  - Manual retry RPC endpoint (`/api/mcp-apps/servers/retry`) and interactive "Retry" button on disconnected server rows in the Plugins UI.
  - Immediate lifecycle shutdown: forwards `lifecycleController.signal` into remote transports so pressing `^C` or shutting down DSH aborts in-flight requests immediately without waiting for HTTP socket timeouts.
- **UI & Client Status Enhancements**:
  - Detailed server connection states: "Needs Authorization", "Authenticated", "Connected", and "Disconnected".
  - Interactive "Connect Account", "Disconnect", and "Retry" buttons on server cards with accessible ARIA semantics and responsive design.

[Compare v0.2.3...v0.2.4](https://github.com/katticot/dsh-mcp-apps/compare/v0.2.3...v0.2.4)

## [0.2.3] - 2026-09-28

### Added

- Config schema metadata: every field in `Config` now carries a human-readable `.description()`, timeout fields carry `.role('ms')`, and `env`/`headers` dict values carry `.role('secret')` — DSH's schema-driven settings forms now show documentation and redact secrets before they reach the browser, without changing any validation, default, or type.
- A read-only `servers/status` endpoint and a matching status section on the plugin's page in DSH's Plugins UI: per-server connection state, tool counts, and an expandable, filterable list of individual tool names grouped by visibility (model-visible / app-only / both). Never exposes `command`, `args`, `env`, `headers`, or `url`.
- The package now self-activates as a DSH **bundle**: `dsh plugin add dsh-mcp-apps` inserts its `mcp-apps` row automatically (via `dsh/cordis.patch.yml`), giving it a card and detail page — with the official MCP mark as its icon — in DSH's Plugins UI. Previously it had to be wired in by hand with an `insert:` patch entry and had no presence in that UI at all.

### Changed

- README's Install and Configure sections rewritten for the bundle flow: install via the DSH Harness UI or CLI, then configure by *patching* (not `insert:`-ing) the `mcp-apps` row in your profile's `cordis.patch.yml`. Added a "Migrating from 0.2.x" section for existing `insert:`-based configs.
- Peer ranges bumped to `^0.1.7-rc.2` to match the latest DSH; added `@deepseek-ai/dsh-client-ui-plugin-manager` as an *optional* peer, deliberately left out of `dsh.client.inject` so a deployment without the plugin manager doesn't gate this plugin's own tool-view loading on it.
- `scripts/smoke-dsh.mjs` now patches the bundle's own `mcp-apps` row instead of inserting a second one.
- Common transitive dependencies routed through `@socketregistry` drop-in replacements via pnpm `overrides`.

### Security

- Connection-error messages surfaced through `servers/status` are sanitized before storage: URL userinfo/query/fragment are stripped, any configured secret value (plus `Bearer <token>`-style sub-tokens and percent-encoded variants of it) is redacted, and the result is truncated to 300 characters. Configured secrets under 3 characters are not redacted, to avoid collateral redaction of common short substrings — documented as a known limitation.

[Compare v0.2.2...v0.2.3](https://github.com/katticot/dsh-mcp-apps/compare/v0.2.2...v0.2.3)

## [0.2.2] - 2026-09-27

**Requires DSH >= 0.1.7-rc.2** (this release is incompatible with DSH `0.1.5-rc.x`; see [Compatibility](#compatibility)).

### Fixed

- Restored compatibility with DSH `0.1.7-rc.2`. `0.2.1`'s `@deepseek-ai/dsh-*` peer ranges were pinned to an exact `0.1.5-rc.3`; DSH's `evaluatePluginCompatibility` checker treats an exact version string (no range operator) as equality-only, so it rejected `0.1.7-rc.2` outright with `Plugin dsh-mcp-apps@0.2.1 is incompatible with dsh 0.1.7-rc.2`. Peers are now caret ranges, `^0.1.7-rc.2`.
- Tools failed to register on headless DSH hosts. `src/index.ts` required `webServer` in its Cordis `inject` list even though its host routes go through the public `ctx.connection.fetch.register` contract, which never touches `ctx.webServer`. Since every Cordis 4.x `inject` entry is a hard requirement, this left the plugin's fiber permanently `PENDING` on a host with no web server, so none of its tools registered. `inject` is now `['tools', 'connection']`.
- The plugin now registers its `/api/mcp-apps/*` endpoints through the public `HostConnectionFetch.register(route)` contract instead of a fabricated `Context.connection` shape, returning the public `ConnectionRpcResult` envelope. Shutdown awaits every route's unregister call before tearing down the tool pool and session store.
- `approval` and `agents` are now only injected when a server config actually sets `allowAppToolCalls: 'approve'`, instead of being unconditional hard requirements. An in-flight approval call re-checks that the captured service reference is still current after the request resolves, failing with `unavailable` instead of using a stale reference if the service was swapped or torn down underneath it.
- The client re-discovers MCP app tools after a host reconnect, not just on initial load.
- Two release-pipeline bugs that blocked the first two publish attempts of this version: a bare relative tarball path being misparsed as a hosted-git shorthand by `npm-package-arg` (fixed with a leading `./`), and the npm CLI bundled with `actions/setup-node`'s Node 22 being too old for OIDC trusted publishing (fixed by pinning `npm@11.20.0`, which requires `>= 11.5.1`).

### Added

- A headless-host regression test asserting the plugin's fiber still activates without a `webServer` provider.
- `docs/diagrams/plugin-architecture.html` / `.json`, an architecture diagram of the plugin's Cordis service and lifecycle wiring.
- A no-auth `npm publish --dry-run` guard in `ci.yml` to catch tarball-path regressions on every PR.

### Compatibility

| `dsh-mcp-apps` | Requires DSH |
| :--- | :--- |
| `0.2.2`+ | `>= 0.1.7-rc.2` |
| `0.2.1` and earlier | `0.1.5-rc.x` |

[Compare v0.2.1...v0.2.2](https://github.com/katticot/dsh-mcp-apps/compare/v0.2.1...v0.2.2)

## [0.2.1] - 2026-09-27

Security fixes for two unbounded-memory paths, plus CI hardening. No breaking changes.

### Fixed

- **Stdio memory exhaustion**: a stdio MCP server could send an arbitrarily large unterminated JSON-RPC line and the SDK's `ReadBuffer` would buffer it without limit. `maxMessageBytes` is now passed through as `StdioClientTransport`'s own `maxBufferSize` option, so an oversized line now throws and closes the connection (picked up by the existing reconnect/backoff logic) instead of growing memory unbounded. `maxMessageBytes` now applies to `stdio` servers as well as remote transports, sharing the same 16MB `DEFAULT_MAX_MESSAGE_BYTES` default.
- **Unchecked raw resource reads**: `readResourceRaw` returned `client.readResource()` with no size check, while `readResource` enforced `MAX_RESOURCE_SIZE_BYTES` but measured length in UTF-16 code units and fully base64-decoded blobs just to measure them. Both paths now sum content sizes in UTF-8 bytes for text and in bytes derived algebraically from the base64 length for blobs (no decoding needed), summed across all content items.

### Changed

- Removed the unreachable no-`serverName` fallback branches in `ServerPool.listResources`/`readResourceRaw`/`readResource`, making `serverName` a required parameter (internal; `ServerPool` isn't exported, no user-facing effect).
- Pinned `actions/checkout`, `pnpm/action-setup`, and `actions/setup-node` in `ci.yml` to the same commit SHAs `release.yml` already used.

[Compare v0.2.0...v0.2.1](https://github.com/katticot/dsh-mcp-apps/compare/v0.2.0...v0.2.1)

## [0.2.0] - 2026-09-27

### Breaking

- **Transport removal**: the `ipc` and `websocket` transports were removed. Migrate an `ipc` server to `stdio`, or put it behind an HTTP endpoint (`streamable-http` or `sse`); replace `websocket` with `streamable-http` or `sse`. Remote `url`s must now be `http(s)://`; a config with `transport: 'ipc'` or `'websocket'` now fails validation at startup.
- **`allowAppToolCalls` now defaults to `deny`**, so reverse tool calls from apps are blocked until a server explicitly sets `'deny'` (blocked, default), `'approve'` (routed through the approval handler), or `'allow'` (permitted).
- **`${VAR}` expansion allowlisting**: expansion in `env` and `headers` no longer reads `DSH_*`, secret-like names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`), `SSH_AUTH_SOCK`, or `GPG_AGENT_INFO` unless the server lists them in `allowedVars` — otherwise they expand to an empty string (or the `:-default`).
- **`engines.node` is now `>=22`.** Older Node versions are no longer supported.
- **`./client` no longer exports types**; it is loaded only by the DSH module loader.
- Null servers (`servers.<id>: null`), non-positive timeouts, and malformed remote URLs are now rejected at startup.

### Security

- Session-bound RPC: `tools/call`, `resources/read`, `resources/read-raw`, and `resources/list` now require a valid session token bound to the server that issued it; the unauthenticated fallback was removed.
- CSP hardening: the CSP `<meta>` tag is placed first using `DOMParser`, with a safe fallback; private IP ranges, link-local addresses, and the blanket `img-src https:` rule were removed.
- Remote plain `http://` is now allowed only to loopback addresses (`localhost`, `127.0.0.1`, `[::1]`).
- Incoming messages are capped per server with `maxMessageBytes` to prevent memory exhaustion (remote transports only in this release; extended to `stdio` in 0.2.1).

### Changed

- Published via npm trusted publishing (OIDC), eliminating static tokens and adding cryptographic provenance verification. Release workflow runs on a dedicated `release` environment with minimal permissions and SHA-pinned actions.
- Package contents verified: no dangling source maps, `.npmignore` removed, `packageManager` field added.

[Compare v0.1.0...v0.2.0](https://github.com/katticot/dsh-mcp-apps/compare/v0.1.0...v0.2.0)

## [0.1.0] - 2026-09-23

Initial release: Universal MCP Apps (SEP-1865) host & UI plugin for DeepSeek Harness.

### Added

- Multi-transport server pool (`stdio`, unix domain sockets/`ipc`, remote `sse` & `streamable-http`) — `ipc` and `websocket` were later removed in 0.2.0.
- Dynamic tool synchronization and LLM API schema sanitization (`^[a-zA-Z0-9_-]+$`).
- Sandboxed iframe container with a dynamically synthesized Content Security Policy.
- Resilient PostMessage transport with early handshake buffering.
- Bidirectional AppBridge reverse tool calling and live data refresh fallback.
- Auto-reveal lifecycle coordinator preventing premature DSH turn/process collapse.
- Full unit test suite and automated CI/CD workflows.

[v0.1.0](https://github.com/katticot/dsh-mcp-apps/releases/tag/v0.1.0)

[0.2.4]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/katticot/dsh-mcp-apps/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/katticot/dsh-mcp-apps/releases/tag/v0.1.0
