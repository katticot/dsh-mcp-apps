# How It Works

This document covers the internals of `dsh-mcp-apps`: how a `ui://` resource
becomes a sandboxed iframe in DSH chat, and the mechanisms that keep that
iframe secure, responsive, and well-behaved. If you just want to install and
configure the plugin, see the [README](../README.md).

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

## Mechanisms

- **Sandboxed Web Applications**: Renders rich interactive UIs (dashboards, charts, maps, forms) inside an isolated `<iframe sandbox="allow-scripts allow-forms allow-downloads">` (without `allow-same-origin`) with a Content Security Policy synthesized from resource metadata. Domains are sanitized with a hand-rolled allowlist regex (not a full RFC 3986 URL parser) that rejects wildcards, private/loopback/link-local IPs, `http://`, and comment-injection payloads (`<!--`/`-->`) before they reach the policy string; the `<meta http-equiv="Content-Security-Policy">` tag is inserted as the first child of `<head>`.
- **Resilient PostMessage Handshake**: Solves iframe race conditions where inline `<script>` in `srcDoc` sends `ui/initialize` during HTML parsing before parent listeners attach. `ResilientPostMessageTransport` calls `window.addEventListener('message', ...)` synchronously in its constructor and buffers early JSON-RPC packets in FIFO order until `bridge.connect()` finishes wiring `onmessage`.
- **Multi-Transport Server Pool**: Manages concurrent MCP connections, started in parallel with reconnect backoff, across **Stdio** (isolated subprocesses with environment scrubbing via `@deepseek-ai/dsh-subprocess`) and **Remote** (SSE and Streamable HTTP). Only transports defined by the MCP specification are supported: `stdio`, `streamable-http`, and `sse` (deprecated upstream, kept for older servers).
- **LLM Schema Compliance**: Normalizes tool names to `^[a-zA-Z0-9_-]+$`, caps lengths at 64 characters, and appends SHA-256 collision digests (`mcp__<server>__<tool>_<hash>`) to satisfy frontier LLM API schemas. Tool sync is fingerprinted (description + input schema + UI resource URI) so unchanged tools aren't re-registered on every reconnect.
- **DSH Anti-Collapse Auto-Reveal**: Walks up the DOM from the iframe and, on a `[hidden]` ancestor, dispatches a `beforematch` event and removes the attribute — detecting and reversing DSH's `useSearchableHidden` fold behavior rather than intercepting the hook itself — so interactive dashboards don't collapse into 1-line folded accordions when model streaming finishes. Includes an `Interactive App` badge, manual fold toggle, and state-preserving styles (`contain: strict`).
- **Reverse Tool-Call Security**: Session tokens plus a per-server `allowAppToolCalls` policy gate which tools an embedded app can call back into the host (see the README's [Reverse Tool-Call Security Model](../README.md#reverse-tool-call-security-model)).
- **Dynamic Resizing with Circuit Breaker**: Listens to `ui/notifications/size-changed` with a 6px hysteresis deadband, height clamping (160px–1200px), `requestAnimationFrame`-scheduled updates, and a 1-second sliding-window circuit breaker (mutes after 10 resize events within any 1000ms window, then flushes the last pending height once the window clears) to prevent layout thrashing.

## The `./client` entry

`./client` (the browser-side bundle loaded by DSH's `window.__ModuleLoader__`)
is loader-only: it has no `types` entry in `package.json#exports` and cannot
be imported directly from Node or a bundler — only the `.` (host) entry ships
type declarations.
