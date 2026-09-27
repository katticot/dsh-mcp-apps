# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.2.2]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/katticot/dsh-mcp-apps/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/katticot/dsh-mcp-apps/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/katticot/dsh-mcp-apps/releases/tag/v0.1.0
