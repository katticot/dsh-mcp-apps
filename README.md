# dsh-mcp-apps

[![npm](https://img.shields.io/npm/v/dsh-mcp-apps.svg?style=flat-square)](https://www.npmjs.com/package/dsh-mcp-apps)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb.svg?style=flat-square&logo=react)](https://react.dev/)
[![Cordis](https://img.shields.io/badge/Cordis-v4.0-7952b3.svg?style=flat-square)](https://cordis.moe/)
[![Tests](https://img.shields.io/badge/Tests-17%20passed-brightgreen.svg?style=flat-square&logo=vitest)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Universal SEP-1865 MCP Apps Host & UI Plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).**

Render live, interactive, sandboxed web applications directly inside DSH chat turns when Model Context Protocol (MCP) servers return `ui://` resources.

---

## What It Does

- **Sandboxed Web Applications**: Renders rich interactive UIs (dashboards, charts, maps, forms) inside an isolated `<iframe sandbox="allow-scripts allow-forms allow-downloads">` (without `allow-same-origin`) with dynamic Content Security Policy (CSP) synthesized from resource metadata and validated against RFC 3986.
- **Resilient PostMessage Handshake**: Solves iframe race conditions where inline `<script>` in `srcDoc` sends `ui/initialize` during HTML parsing before parent listeners attach. `ResilientPostMessageTransport` hooks window events synchronously and buffers early JSON-RPC packets in FIFO order.
- **Multi-Transport Server Pool**: Manages concurrent MCP connections across **Stdio** (isolated subprocesses with environment scrubbing via `@deepseek-ai/dsh-subprocess`), **Remote** (SSE & Streamable HTTP with custom headers), and **Local IPC** (Unix domain sockets with POSIX UID verification).
- **LLM Schema Compliance**: Normalizes tool names to `^[a-zA-Z0-9_-]+$`, caps lengths at 64 characters, and appends SHA-256 collision digests (`mcp__<server>__<tool>_<hash>`) to satisfy frontier LLM API schemas.
- **DSH Anti-Collapse Auto-Reveal**: Intercepts DSH's `useSearchableHidden` hook to prevent interactive dashboards from collapsing into 1-line folded accordions when model streaming finishes. Includes an `Interactive App` badge, manual fold toggle, and state-preserving styles (`contain: strict`).
- **Secure Reverse Tool Calls**: Issues cryptographically secure 256-bit session tokens that scope and authorize UI interactions back to host tools (e.g. clicking a "Refresh Data" button).
- **Dynamic Resizing with Circuit Breaker**: Listens to `ui/notifications/size-changed` with a 6px hysteresis deadband, height clamping (160px–1200px), and a 30-event burst circuit breaker to prevent layout thrashing.

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
                        ├─ ServerToolManager (Name Sanitization & Registration)
                        ├─ AppSessionStore (256-bit Reverse Tool Tokens)
                        └─ ServerPool (stdio | sse | streamable-http | ipc)
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
      # Local Stdio Subprocess (env variables support ${VAR} expansion)
      powerhive:
        transport: stdio
        command: go
        args: ['run', 'main.go']
        cwd: '/path/to/mcp-server'
        env:
          DATABASE_URL: '${DATABASE_URL}'
        toolCallTimeoutMs: 45000

      # Remote SSE / Streamable HTTP Server
      remote-analytics:
        transport: sse
        url: 'https://mcp.example.com/sse'
        headers:
          Authorization: 'Bearer ${MCP_TOKEN}'

      # Local Unix Domain Socket
      daemon:
        transport: ipc
        socketPath: '/tmp/mcp-daemon.sock'
```

---

## Configuration Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `servers` | `Record<string, ServerConfig>` | `{}` | Map of server identifiers to transport configs. |
| `defaultTimeoutMs` | `number` | `30000` | Fallback timeout in ms for tool calls. |
| `servers.<id>.transport` | `'stdio' \| 'sse' \| 'streamable-http' \| 'ipc'` | *(Required)* | Transport mechanism. |
| `servers.<id>.command` | `string` | — | Executable binary path (for `stdio`). |
| `servers.<id>.args` | `string[]` | `[]` | Command arguments (for `stdio`). |
| `servers.<id>.cwd` | `string` | — | Working directory (for `stdio`). |
| `servers.<id>.env` | `Record<string, string>` | `{}` | Environment variables with `${VAR:-default}` expansion (for `stdio`). |
| `servers.<id>.url` | `string` | — | Remote HTTP/SSE endpoint URL (for `sse`, `streamable-http`). |
| `servers.<id>.headers` | `Record<string, string>` | `{}` | Custom HTTP headers (for `sse`, `streamable-http`). |
| `servers.<id>.socketPath` | `string` | — | Local Unix socket path with UID verification (for `ipc`). |
| `servers.<id>.toolCallTimeoutMs` | `number` | `30000` | Per-server tool call timeout in ms. |
| `servers.<id>.allowedVars` | `string[]` | `[]` | Env var names this server may read via `${VAR}` expansion (in `env` or `headers`) despite being `DSH_*`-prefixed, secret-shaped (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`), or an agent socket (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), which are blocked by default. E.g. `allowedVars: ['API_TOKEN']` lets `headers: { Authorization: 'Bearer ${API_TOKEN}' }` resolve (for `stdio`, `sse`, `streamable-http`). |

### Windows IPC (limitation)

On POSIX, the `ipc` transport verifies before connecting that the socket's
parent directory is `0700` and that both the directory and the socket file
are owned by the current user, refusing to connect otherwise. **Windows has
no equivalent check implemented.** There is no cross-platform, dependency-free
way to inspect a named pipe's ACL from Node without a native addon, so rather
than silently skipping the check, `IpcClientTransport` logs a `console.warn`
identifying the gap every time it connects on `win32` and connects anyway
(it fails open, not closed, since a hard failure would make `ipc` entirely
unusable on Windows for a check we can't perform). If you use the `ipc`
transport on Windows, make sure the named pipe itself is protected by an
appropriate ACL — the plugin cannot verify this for you on that platform.

---

## Development & Testing

```bash
# Install dependencies
pnpm install

# Build host and client bundles (tsdown / rolldown)
pnpm build

# Run Vitest test suite
pnpm test
```

The test suite includes 17 passing unit tests covering configuration parsing, environment interpolation, RFC 3986 CSP synthesis, session token generation/expiration, and tool name schema normalization.

---

## License

MIT © [katticot](https://github.com/katticot)
