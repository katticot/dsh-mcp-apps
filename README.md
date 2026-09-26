# dsh-mcp-apps

[![npm](https://img.shields.io/npm/v/dsh-mcp-apps.svg?style=flat-square)](https://www.npmjs.com/package/dsh-mcp-apps)
[![Downloads](https://img.shields.io/npm/dw/dsh-mcp-apps.svg?style=flat-square)](https://www.npmjs.com/package/dsh-mcp-apps)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb.svg?style=flat-square&logo=react)](https://react.dev/)
[![Cordis](https://img.shields.io/badge/Cordis-v4.0-7952b3.svg?style=flat-square)](https://cordis.moe/)
[![Tests](https://img.shields.io/badge/Tests-passing-brightgreen.svg?style=flat-square&logo=vitest)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Universal SEP-1865 MCP Apps Host & UI Plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).**

Render live, interactive, sandboxed web applications directly inside DSH chat turns when Model Context Protocol (MCP) servers return `ui://` resources.

---

## What It Does

- **Sandboxed Web Applications**: Renders rich interactive UIs (dashboards, charts, maps, forms) inside an isolated `<iframe sandbox="allow-scripts allow-forms allow-downloads">` (without `allow-same-origin`) with a Content Security Policy synthesized from resource metadata. Domains are sanitized with a hand-rolled allowlist regex (not a full RFC 3986 URL parser) that rejects wildcards, private/loopback/link-local IPs, `http://`, and comment-injection payloads (`<!--`/`-->`) before they reach the policy string; the `<meta http-equiv="Content-Security-Policy">` tag is inserted as the first child of `<head>`.
- **Resilient PostMessage Handshake**: Solves iframe race conditions where inline `<script>` in `srcDoc` sends `ui/initialize` during HTML parsing before parent listeners attach. `ResilientPostMessageTransport` calls `window.addEventListener('message', ...)` synchronously in its constructor and buffers early JSON-RPC packets in FIFO order until `bridge.connect()` finishes wiring `onmessage`.
- **Multi-Transport Server Pool**: Manages concurrent MCP connections, started in parallel with reconnect backoff, across **Stdio** (isolated subprocesses with environment scrubbing via `@deepseek-ai/dsh-subprocess`) and **Remote** (SSE and Streamable HTTP). Only transports defined by the MCP specification are supported: `stdio`, `streamable-http`, and `sse` (deprecated upstream, kept for older servers).
- **LLM Schema Compliance**: Normalizes tool names to `^[a-zA-Z0-9_-]+$`, caps lengths at 64 characters, and appends SHA-256 collision digests (`mcp__<server>__<tool>_<hash>`) to satisfy frontier LLM API schemas. Tool sync is fingerprinted (description + input schema + UI resource URI) so unchanged tools aren't re-registered on every reconnect.
- **DSH Anti-Collapse Auto-Reveal**: Walks up the DOM from the iframe and, on a `[hidden]` ancestor, dispatches a `beforematch` event and removes the attribute — detecting and reversing DSH's `useSearchableHidden` fold behavior rather than intercepting the hook itself — so interactive dashboards don't collapse into 1-line folded accordions when model streaming finishes. Includes an `Interactive App` badge, manual fold toggle, and state-preserving styles (`contain: strict`).
- **Reverse Tool-Call Security**: Session tokens plus a per-server `allowAppToolCalls` policy gate which tools an embedded app can call back into the host (see [Reverse Tool-Call Security Model](#reverse-tool-call-security-model) below).
- **Dynamic Resizing with Circuit Breaker**: Listens to `ui/notifications/size-changed` with a 6px hysteresis deadband, height clamping (160px–1200px), `requestAnimationFrame`-scheduled updates, and a 1-second sliding-window circuit breaker (mutes after 10 resize events within any 1000ms window, then flushes the last pending height once the window clears) to prevent layout thrashing.

---

## Architecture

```
DSH Chat Turn ──> McpAppToolView (React 18)
                        │
                        ├─ Sandboxed <iframe> (AppBridge UI Guest)
                        │       ▲
                        │       │ postMessage
                        ▼       ▼
                  ResilientPostMessageTransport (Early Queue Buffer)
                        │
                        │ RPC (/mcp-apps channel)
                        ▼
                  Cordis 4 Host Plugin (apply)
                        │
                        ├─ ServerToolManager (Name Sanitization, Fingerprinted Sync & Visibility)
                        ├─ AppSessionStore (Reverse Tool-Call Session Tokens)
                        └─ ServerPool (stdio | sse | streamable-http)
```

---

## Quick Start

### 1. Installation

Install `dsh-mcp-apps` into your DSH environment:

```bash
pnpm add dsh-mcp-apps
```

### 2. Configure DSH (`cordis.patch.yml`)

Add the plugin to your profile configuration (e.g. `~/.dsh/cordis.patch.yml` or `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: mcp-apps
  name: 'dsh-mcp-apps'
  config:
    defaultTimeoutMs: 30000
    servers:
      # Local Stdio Subprocess (env variables support ${VAR} / ${VAR:-default} expansion)
      powerhive:
        transport: stdio
        command: go
        args: ['run', 'main.go']
        cwd: '/path/to/mcp-server'
        env:
          DATABASE_URL: '${DATABASE_URL}'
        toolCallTimeoutMs: 45000
        allowAppToolCalls: approve

      # Remote SSE / Streamable HTTP server
      remote-analytics:
        transport: sse
        url: 'https://mcp.example.com/sse'
        headers:
          Authorization: 'Bearer ${MCP_TOKEN}'
        allowedVars: [MCP_TOKEN]   # secret-shaped vars are blocked unless listed
        reconnectOptions:
          maxRetries: 10
```

---

## Reverse Tool-Call Security Model

Rendered apps can call back into host tools (e.g. a "Refresh Data" button). That path is locked down by default:

- **Session tokens**: every `tools/call` request from an app must carry a valid `AppSessionStore` session token, scoped to the tool names and server it was issued for. A missing, expired, or mismatched-server token is rejected before the tool ever runs (`src/index.ts`).
- **`allowAppToolCalls` (per server, default `false`/`'deny'`)**: a `'deny' | 'approve' | 'allow'` setting (a plain `boolean` is also accepted as legacy shorthand for `false`/`'allow'`).
  - `'deny'` (default): no tools are exposed for reverse calls from that server's apps.
  - `'allow'` / `true`: reverse calls are permitted without approval.
  - `'approve'`: each reverse call is routed through `ctx.approval` (`@deepseek-ai/dsh-user-approval`) and requires the originating agent to have an open turn (`agent.status === 'running'`); outside of that window, or if the approval/agent services aren't available, the call fails with `unavailable` rather than silently allowing or hanging.
- **App-only / model-only visibility**: tools marked app-only (`isToolVisibilityAppOnly`) are never registered with the LLM's tool list, and tools marked model-only (`isToolVisibilityModelOnly`) are excluded from the set an app is allowed to call back into — each direction is a one-way gate.

## Configuration Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `servers` | `Record<string, ServerConfig>` | `{}` | Map of server identifiers to transport configs. Names cannot contain `__` or end with `_`. |
| `defaultTimeoutMs` | `number` | `30000` | Fallback timeout in ms for tool calls (must be `>= 1`). |
| `servers.<id>.transport` | `'stdio' \| 'sse' \| 'streamable-http'` | *(Required)* | Transport mechanism. Only transports defined by the MCP specification are supported: `stdio`, `streamable-http`, and `sse` (deprecated upstream, kept for older servers). |
| `servers.<id>.command` | `string` | — | Executable binary path (for `stdio`). |
| `servers.<id>.args` | `string[]` | `[]` | Command arguments (for `stdio`). |
| `servers.<id>.cwd` | `string` | — | Working directory (for `stdio`). |
| `servers.<id>.env` | `Record<string, string>` | `{}` | Environment variables, with `${VAR}` / `${VAR:-default}` expansion (for `stdio`). |
| `servers.<id>.url` | `string` | — | Remote endpoint URL (for `sse`, `streamable-http`); must match `http(s)://`. Plain `http://` is only allowed to a loopback host (`localhost`, `127.0.0.1`, `::1`) — anything else is rejected at connect time. |
| `servers.<id>.headers` | `Record<string, string>` | `{}` | Custom HTTP headers, with the same `${VAR}` expansion as `env` (for `sse`, `streamable-http`). |
| `servers.<id>.toolCallTimeoutMs` | `number` | `30000` | Per-server tool call timeout in ms (must be `>= 1`). |
| `servers.<id>.reconnectOptions` | `{ maxRetries?, initialDelayMs?, maxDelayMs?, backoffFactor? }` | `{5, 1000, 30000, 1.5}` | Exponential-backoff reconnect tuning, applied on `stdio` and remote (`sse`, `streamable-http`) transports. |
| `servers.<id>.allowAppToolCalls` | `'deny' \| 'approve' \| 'allow' \| boolean` | `false` (`'deny'`) | Reverse tool-call policy — see [Reverse Tool-Call Security Model](#reverse-tool-call-security-model). |
| `servers.<id>.allowedPermissions` | `string[]` | `[]` | Allowlist for `camera`, `microphone`, and `geolocation` iframe permissions requested by a resource's UI metadata; all three are denied unless explicitly listed here. Other permission keys pass through unfiltered into the iframe's `allow` attribute. |
| `servers.<id>.allowedVars` | `string[]` | `[]` | Env var names this server may read via `${VAR}` expansion (in `env` or `headers`) despite being `DSH_*`-prefixed, secret-shaped (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`), or an agent socket (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), which are blocked by default. E.g. `allowedVars: ['API_TOKEN']` lets `headers: { Authorization: 'Bearer ${API_TOKEN}' }` resolve (for `stdio`, `sse`, `streamable-http`). |
| `servers.<id>.maxMessageBytes` | `number` | `16777216` (16MB) | Maximum size in bytes of a single incoming message from a remote server (for `sse`, `streamable-http`; must be `>= 1`). This caps each individual SSE event (not the total stream lifetime) via a byte-counting wrapper around `fetch`. Protects against a malicious or misbehaving remote server exhausting host memory. |

`${VAR}` / `${VAR:-default}` expansion only applies to `env` and `headers` values — not to `url`, `args`, or `cwd`. `$$` is an escaped literal `$`. A default value cannot itself contain a nested `${...}` expansion (e.g. `${MISSING:-${PORT}}` is taken literally, not expanded recursively).

---

## Development & Testing

```bash
# Install dependencies
pnpm install

# Type-check
pnpm typecheck

# Build host and client bundles (tsdown)
pnpm build

# Run Vitest test suite
pnpm test
```

`./client` (the browser-side bundle loaded by DSH's `window.__ModuleLoader__`) is loader-only: it has no `types` entry in `package.json#exports` and cannot be imported directly from Node or a bundler — only the `.` (host) entry ships type declarations.

---

## License

MIT © [katticot](https://github.com/katticot)
