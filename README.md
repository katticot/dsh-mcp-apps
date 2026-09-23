# dsh-mcp-apps

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb.svg?style=flat-square&logo=react)](https://react.dev/)
[![Cordis](https://img.shields.io/badge/Cordis-v4.0-7952b3.svg?style=flat-square)](https://cordis.moe/)
[![MCP](https://img.shields.io/badge/MCP-SEP--1865-orange.svg?style=flat-square)](https://modelcontextprotocol.io/)
[![Vitest](https://img.shields.io/badge/Tests-17%20passed-brightgreen.svg?style=flat-square&logo=vitest)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Universal Model Context Protocol (MCP) Apps Host & UI Plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**

*Render rich, interactive, sandboxed web applications directly inside DSH chat turns.*

</div>

---

## Overview

**`dsh-mcp-apps`** is a production-grade host runtime and UI extension plugin for DeepSeek Harness (DSH). It implements the **SEP-1865 (MCP Apps)** specification, allowing any Model Context Protocol server that exposes interactive UI resources (`ui://...`) to render live, interactive web apps (dashboards, charts, geographic maps, interactive inspectors, data grids) directly inside conversational chat turns.

Built on **Cordis 4**, **React 18**, and `@modelcontextprotocol/ext-apps`, `dsh-mcp-apps` bridges the gap between static JSON tool responses and responsive user interfaces while maintaining uncompromising sandbox security, robust bidirectional RPC communication, and seamless integration with DSH's chat lifecycle.

---

## Problem Statement vs. Solution

| Challenge in Traditional LLM Tool UIs | How `dsh-mcp-apps` Solves It |
| :--- | :--- |
| **Static Text & JSON Blobs**<br>Frontier models return complex hierarchical data, metrics, or geospatial points as raw markdown or JSON that users must decipher manually. | **Live Sandboxed Web UIs**<br>MCP tools advertise `ui://` resources. When invoked, `dsh-mcp-apps` dynamically mounts an isolated, responsive HTML/JS web application inside the chat turn. |
| **Iframe Race Conditions**<br>Inline `<script>` in iframe `srcDoc` executes immediately during HTML parsing, dispatching `ui/initialize` before the parent React component attaches its `load` event listener. Handshakes stall indefinitely. | **`ResilientPostMessageTransport`**<br>Attaches parent window message listeners synchronously upon construction, buffering early JSON-RPC packets in an internal queue and flushing them upon bridge connection. |
| **DSH Accordion Auto-Collapse**<br>DSH's turn execution engine (`useSearchableHidden`) collapses tool call blocks into a 1-line folded accordion (`1 tool call >`) once model streaming finishes, hiding active interactive apps. | **Anti-Collapse Auto-Reveal**<br>Intercepts DOM mutation attributes (`hidden`, `data-open`, `aria-expanded`), triggers `beforematch` events, reveals ancestors, and provides an explicit header with status badge and manual toggle. |
| **Cross-Site Scripting & Ambient Credential Leaks**<br>MCP sub-processes or remote apps might attempt to read ambient credentials, exfiltrate data, or make unauthorized cross-origin requests. | **Dynamic CSP & Subprocess Scrubbing**<br>Synthesizes strict CSP `meta` tags with RFC 3986 domain validation. Subprocesses inherit a scrubbed environment stripped of host secrets via `@deepseek-ai/dsh-subprocess`. |
| **Tool Name Validation Failures**<br>Frontier LLM provider APIs (DeepSeek, OpenAI, Anthropic) enforce strict identifier regexes (`^[a-zA-Z0-9_-]+$`, max 64 chars). Server tool names often violate these constraints. | **Deterministic Schema Sanitization**<br>Tool names are normalized with character substitution and capped with SHA-256 collision-resistant hashes (`mcp__<server>__<tool>_<hash>`), ensuring 100% API schema compliance. |
| **Iframe Layout Thrashing**<br>Unregulated `ui/notifications/size-changed` notifications cause infinite resize loops and layout stutter in the browser. | **Hysteresis & Circuit Breaker**<br>Enforces a 6px hysteresis deadband, height clamping (`160px`–`1200px`), requestAnimationFrame batching, and a 10Hz burst circuit breaker. |

---

## Architecture

The system operates across two boundaries: the **DSH Host Process** (Node.js/Cordis service pool) and the **DSH Web Client** (React 18 slot injection).

```
                                  DEEPSEEK HARNESS (DSH)
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  Client Tier (Browser / React 18)                                                      │
│                                                                                        │
│   ┌──────────────┐     renders slot     ┌──────────────────────────────────────────┐   │
│   │   DSH Chat   │ ───────────────────> │ McpAppToolView                           │   │
│   │  TurnProcess │                      │  ├─ Anti-Collapse Auto-Reveal Controller  │   │
│   └──────────────┘                      │  ├─ Interactive App Badge & Fold Toggle │   │
│                                         │  └─ Dynamic Hysteresis Resizer           │   │
│                                         └────────────────────┬─────────────────────┘   │
│                                                              │ embeds                  │
│                                                              ▼                         │
│                                         ┌──────────────────────────────────────────┐   │
│                                         │ Sandboxed <iframe>                       │   │
│                                         │  ├─ sandbox="allow-scripts allow-forms"  │   │
│                                         │  ├─ <meta Dynamic CSP (RFC 3986)>        │   │
│                                         │  └─ AppBridge UI Guest Application       │   │
│                                         └────────────────────▲─────────────────────┘   │
│                                                              │ postMessage             │
│                                         ┌────────────────────▼─────────────────────┐   │
│                                         │ ResilientPostMessageTransport            │   │
│                                         │  └─ Early JSON-RPC Message Buffer        │   │
│                                         └────────────────────┬─────────────────────┘   │
│                                                              │ RPC calls via           │
│                                                              │ ctx.connection          │
└──────────────────────────────────────────────────────────────┼─────────────────────────┘
                                                               │ (/mcp-apps channel)
┌──────────────────────────────────────────────────────────────┼─────────────────────────┐
│  Host Tier (Node.js / Cordis 4 Runtime)                      ▼                         │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Plugin Lifecycle Coordinator (apply)                                           │   │
│   │  ├─ RPC Router: tools/list-ui, resources/read, tools/call                      │   │
│   │  └─ In-Flight Draining Grace Period (2000ms teardown safety)                   │   │
│   └─────────────┬─────────────────────────────────┬────────────────────────────────┘   │
│                 │                                 │                                    │
│                 ▼                                 ▼                                    │
│   ┌───────────────────────────┐     ┌───────────────────────────┐                      │
│   │ ServerToolManager         │     │ AppSessionStore           │                      │
│   │  ├─ Name Sanitization     │     │  ├─ 256-bit Crypto Tokens │                      │
│   │  ├─ DSH Tool Registration │     │  ├─ Reverse Tool Scoping  │                      │
│   │  └─ Ghost Tool Pruning    │     │  └─ TTL / Expiry Guard    │                      │
│   └─────────────┬─────────────┘     └───────────────────────────┘                      │
│                 │                                                                      │
│                 ▼                                                                      │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ ServerPool (Multi-Transport Connection Pool)                                   │   │
│   │  ├─ Stdio Transport        (Subprocess groups, scrubbedParentEnv)              │   │
│   │  ├─ Remote SSE / HTTP      (SSEClientTransport, StreamableHTTPClientTransport) │   │
│   │  └─ Local IPC Transport    (Unix Domain Sockets, POSIX UID security checks)    │   │
│   └─────────────┬─────────────────────────┬─────────────────────────┬──────────────┘   │
└─────────────────┼─────────────────────────┼─────────────────────────┼──────────────────┘
                  │                         │                         │
                  ▼                         ▼                         ▼
          ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
          │ Local Subproc│          │ Cloud Server │          │ Unix Socket  │
          │  MCP Server  │          │ (SSE/Stream) │          │ Daemon (IPC) │
          └──────────────┘          └──────────────┘          └──────────────┘
```

---

## Key Features & Engineering Highlights

### 1. Multi-Transport Server Pool
The runtime manages a resilient connection pool across heterogeneous MCP transports with unified tool discovery and resource routing:
- **Stdio (`subprocess`)**: Launches local binaries using isolated process groups. Ambient process environment variables are scrubbed via `@deepseek-ai/dsh-subprocess` (`scrubbedParentEnv`) to prevent credential leakage. Environment variables configured in `env` support dynamic expansion (`${VAR}` and `${VAR:-default}`).
- **Remote (`sse` & `streamable-http`)**: Connects to remote services using `@modelcontextprotocol/sdk` client transports (`SSEClientTransport`, `StreamableHTTPClientTransport`, and `WebSocketClientTransport`). Custom authorization headers with environment interpolation (`Authorization: Bearer ${API_KEY}`) are supported.
- **Local IPC (`ipc`)**: Connects to Unix domain sockets with POSIX file ownership verification. Asserts that the socket exists, is an actual UNIX socket, and matches the executing user's UID (`process.getuid()`) to prevent local privilege escalation or spoofing.

### 2. Resilient PostMessage Transport (`ResilientPostMessageTransport`)
When mounting an HTML document containing inline scripts via `srcDoc`, the guest document begins parsing and running JavaScript immediately. In traditional iframe integrations, the guest calls `ui/initialize` before the host React tree has attached event listeners, resulting in unresolvable handshake deadlocks.
- `ResilientPostMessageTransport` binds a global `window.addEventListener('message')` immediately at construction time.
- Incoming JSON-RPC packets arriving before connection readiness are captured in an internal `earlyQueue`.
- Once `AppBridge.connect()` completes, all queued messages are flushed in FIFO order, guaranteeing reliable handshakes even on slow hardware or complex bundles.

### 3. Strict Sandboxed Execution & Dynamic CSP
Security is enforced at both the iframe sandbox boundary and the document policy level:
- **Sandboxed Container**: Rendered using `<iframe sandbox="allow-scripts allow-forms allow-downloads">`. Note the absence of `allow-same-origin`, preventing the guest application from accessing host cookies, local storage, or the DSH window DOM.
- **Dynamic Content Security Policy**: Extracts declared capabilities from `_meta.ui.csp` and `permissions` in the resource metadata.
- **RFC 3986 Domain Sanitization**: Domain candidates for `resourceDomains`, `connectDomains`, and `frameDomains` are validated against strict RFC 3986 hostname regexes. Wildcards (`*`), command injections, and semicolon delimiters are stripped.
- Injects a synthesized `<meta http-equiv="Content-Security-Policy">` directly into the document's `<head>`.

### 4. LLM API Schema Compliance
Large language model APIs (DeepSeek, OpenAI, Anthropic) enforce strict parameter schemas and tool identifier naming rules (`^[a-zA-Z0-9_-]+$`, max 64 characters).
- Raw MCP tool names and server identifiers often contain spaces, dots, slashes, or excessive lengths.
- `publicToolName(serverName, rawName)` normalizes invalid characters to underscores.
- If the resulting name exceeds 64 characters, it generates a collision-resistant deterministic name using a 12-character SHA-256 digest suffix:
  ```ts
  mcp__<serverName>__<rawName>_<sha256(server\0raw)[0..12]>
  ```
- Guarantees 0% schema validation rejections when transmitting tool definitions to upstream LLM providers.

### 5. Bidirectional Reverse Tool Calling & Live Refreshes
Interactive MCP Apps often require refreshing data or triggering secondary operations directly from the UI (for example, clicking a "Refresh Metrics" button on a dashboard).
- When a tool executes, `ServerToolManager` issues a cryptographically secure 256-bit random hex session token via `AppSessionStore`.
- The session token binds the UI instance to its issuing server and a whitelist of permitted reverse tools (`allowedReverseTools`).
- The guest application issues `tools/call` requests over the `AppBridge`. The host verifies session token authenticity and tool permissions before execution, with fallback resolution across known servers.

### 6. DSH Anti-Collapse Auto-Reveal
By default, DeepSeek Harness's `TurnProcess` folds completed tool calls into compact accordion buttons (`1 tool call >`) via its internal `useSearchableHidden` hook to keep chat history tidy.
- For interactive apps (dashboards, charts, forms), collapsing destroys user interactivity.
- `McpAppToolView` deploys an active DOM observer that detects ancestor elements flagged with `hidden`, emits synthetic `beforematch` events, and clears the attribute.
- Schedules settlement passes at key turn intervals (300ms, 800ms, 1500ms, 2500ms), and automatically unbinds after 3.5 seconds to preserve intentional user collapses.
- Renders an `Interactive App` badge with manual `Collapse ▲ / Expand ▼` controls and CSS `contain: strict` to retain iframe DOM and WebGL canvas states during folding.

### 7. Smooth Dynamic Auto-Resizing
The plugin listens to guest `ui/notifications/size-changed` events to adapt iframe height automatically:
- **Hysteresis Deadband**: Ignores height fluctuations smaller than 6 pixels, preventing micro-jitter.
- **Bounding Clamp**: Restricts iframe height between `160px` and `1200px`.
- **Circuit Breaker**: Detects runaway resize loops (e.g. guest layout bugs triggering cyclic resizes). If more than 30 resize events fire in rapid succession, the circuit breaker trips, muting resizes for 10 seconds.
- Batched with `requestAnimationFrame` for stutter-free 60fps transitions.

---

## Quick Start

### 1. Installation

Install the package into your DSH harness environment:

```bash
pnpm add dsh-mcp-apps
```

Ensure peer dependencies are satisfied:
```bash
pnpm add @deepseek-ai/cordis @deepseek-ai/dsh-subprocess @deepseek-ai/dsh-tools react react-dom
```

### 2. Configuration (`cordis.patch.yml`)

Add `dsh-mcp-apps` to your DSH configuration profile (e.g. `~/.dsh/cordis.patch.yml`):

```yaml
- id: mcp-apps
  name: 'dsh-mcp-apps'
  config:
    defaultTimeoutMs: 30000
    servers:
      # 1. Local Stdio Subprocess
      powerhive:
        transport: stdio
        command: go
        args: ['run', 'main.go']
        cwd: '/Users/keita/Developer/powerhive-mcp-go'
        env:
          POWERHIVE_DB_URL: '${DATABASE_URL}'
          LOG_LEVEL: 'info'
        toolCallTimeoutMs: 45000

      # 2. Remote Server-Sent Events (SSE)
      cloud-analytics:
        transport: sse
        url: 'https://mcp.internal.net/sse'
        headers:
          Authorization: 'Bearer ${MCP_REMOTE_TOKEN}'
          X-Tenant-ID: 'production'
        reconnectOptions:
          maxRetries: 5
          initialDelayMs: 1000
          maxDelayMs: 30000
          backoffFactor: 1.5

      # 3. Streamable HTTP Transport
      streaming-service:
        transport: streamable-http
        url: 'https://stream.internal.net/mcp'
        headers:
          Authorization: 'Bearer ${STREAM_API_KEY}'

      # 4. Local POSIX Unix Domain Socket (IPC)
      local-daemon:
        transport: ipc
        socketPath: '/tmp/mcp-daemon.sock'
        toolCallTimeoutMs: 15000
```

---

## Configuration Reference

### Top-Level Config

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `servers` | `Record<string, ServerConfig>` | `{}` | Map of server identifiers to their transport configurations. |
| `defaultTimeoutMs` | `number` | `30000` | Fallback timeout in milliseconds for tool calls and RPC responses. |

### Stdio Transport Config (`transport: 'stdio'`)

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `command` | `string` | *(Required)* | Executable command or binary path. |
| `args` | `string[]` | `[]` | Command line arguments. |
| `cwd` | `string` | `undefined` | Working directory for the spawned process. |
| `env` | `Record<string, string>` | `{}` | Environment variables (supports `${VAR}` and `${VAR:-default}`). |
| `toolCallTimeoutMs` | `number` | `30000` | Per-tool call timeout limit. |

### Remote Transport Config (`transport: 'sse' \| 'streamable-http' \| 'websocket'`)

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | *(Required)* | Full HTTP(S) or WS(S) endpoint URL. |
| `headers` | `Record<string, string>` | `{}` | Custom HTTP headers sent with handshakes and requests. |
| `reconnectOptions` | `ReconnectOptions` | `{}` | Backoff policy for network reconnection. |

### IPC Transport Config (`transport: 'ipc'`)

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `socketPath` | `string` | *(Required)* | Path to the Unix domain socket on the local filesystem. |
| `toolCallTimeoutMs` | `number` | `30000` | Per-tool call timeout limit. |

---

## Creating an MCP App (Server-Side Guide)

To build an MCP server compatible with `dsh-mcp-apps`, expose a tool that references a `ui://` resource and implement the corresponding resource handler according to **SEP-1865**.

### Example: Go Server Implementation

```go
// 1. Advertise the Tool with UI Resource Metadata
tool := mcp.Tool{
    Name:        "render_cluster_dashboard",
    Description: "Renders an interactive real-time cluster monitor.",
    InputSchema: schema,
    Meta: map[string]any{
        "ui": map[string]any{
            "resourceUri": "ui://cluster/dashboard.html",
        },
    },
}

// 2. Serve the UI Resource with CSP & Permissions
resource := mcp.ResourceContents{
    URI:      "ui://cluster/dashboard.html",
    MimeType: "text/html;profile=mcp-app",
    Text:     htmlContent,
    Meta: map[string]any{
        "ui": map[string]any{
            "csp": map[string][]string{
                "connectDomains":  []string{"https://api.cluster.local"},
                "resourceDomains": []string{"https://cdn.jsdelivr.net"},
            },
            "permissions": map[string][]string{
                "connectDomains": []string{"https://api.cluster.local"},
            },
        },
    },
}
```

### Example: Inside the Guest App (`dashboard.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps/dist/index.iife.js"></script>
</head>
<body style="font-family: sans-serif; padding: 16px;">
  <h3>Live Cluster Dashboard</h3>
  <div id="status">Connecting to Host...</div>
  <button id="refreshBtn">Refresh Stats</button>

  <script>
    const app = new mcpExtApps.App({ name: "Cluster Dashboard", version: "1.0.0" });

    app.ontoolinput = (params) => {
      document.getElementById("status").textContent = "Loaded cluster: " + params.arguments.clusterId;
    };

    document.getElementById("refreshBtn").addEventListener("click", async () => {
      // Reverse tool call back to host
      const res = await app.callTool({ name: "powerhive_live_stats", arguments: { verbose: true } });
      console.log("Updated metrics:", res);
    });

    app.connect();
  </script>
</body>
</html>
```

---

## Development & Testing

### Project Structure

```
dsh-mcp-apps/
├── src/
│   ├── index.ts               # Host plugin entrypoint (Cordis lifecycle coordinator)
│   ├── config.ts              # Schemastery schema & env expansion utilities
│   ├── tool-manager.ts        # Schema normalizer, tool registrar & ghost tool eviction
│   ├── session-store.ts       # 256-bit cryptographic session token manager
│   ├── client/
│   │   ├── index.tsx          # DSH Web Client plugin (slot injection & sync)
│   │   ├── McpAppToolView.tsx # React view, anti-collapse observer, ResilientPostMessageTransport
│   │   ├── csp.ts             # Dynamic RFC 3986 CSP synthesizer & domain validator
│   │   └── transport.ts       # MessagePortTransport utility
│   └── transports/
│       ├── server-pool.ts     # Multi-server lifecycle & unified routing
│       ├── subprocess.ts      # Stdio transport with scrubbedParentEnv
│       ├── remote.ts          # SSE, Streamable HTTP, and WebSocket transports
│       └── ipc.ts             # Unix domain socket transport with UID checks
└── tests/
    ├── config.spec.ts         # Config validation & env var interpolation tests (7 tests)
    ├── csp.spec.ts            # CSP building & RFC 3986 sanitization tests (4 tests)
    ├── session-store.spec.ts  # Session token creation, TTL & pruning tests (3 tests)
    └── tool-manager.spec.ts   # Name normalization & publicToolName tests (3 tests)
```

### Build Commands

```bash
# Install dependencies
pnpm install

# Run build pipeline (powered by tsdown / rolldown)
pnpm build

# Execute unit tests
pnpm test
```

### Test Suite Summary

The unit test suite covers core functionality across configuration parsing, cryptographic tokens, security policies, and tool name normalization:

```
 ✓ tests/session-store.spec.ts (3 tests)
   - creates sessions with unique 256-bit crypto tokens
   - respects TTL and expires stale sessions
   - prunes expired sessions cleanly

 ✓ tests/csp.spec.ts (4 tests)
   - sanitizes domain lists against RFC 3986 regex
   - filters wildcards (*), semicolons, and malformed strings
   - builds complete CSP headers with default-src 'none'
   - injects meta tag into document head

 ✓ tests/config.spec.ts (7 tests)
   - parses stdio, remote, and ipc server configurations
   - expands simple ${ENV} expressions
   - handles ${ENV:-default} fallback values
   - handles missing variables without fallbacks
   - recursively expands environment dictionaries

 ✓ tests/tool-manager.spec.ts (3 tests)
   - normalizes standard server and tool names
   - sanitizes invalid characters to underscores
   - truncates and hashes names exceeding 64 characters

Test Files  4 passed (4)
     Tests  17 passed (17)
```

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
