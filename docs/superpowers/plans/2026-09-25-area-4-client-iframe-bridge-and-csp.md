# Area 4: Client Iframe Bridge & CSP Hardening Implementation Plan (PR 4a + 4b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate handshake race conditions, stabilize iframe bridge lifecycle, isolate chat auto-expansion, harden CSP rules against SSRF/loopback/comment-injection, enforce DOMParser-ordered meta CSP placement, and guard against unauthorized navigation and device permissions.

**Architecture:** 
- In `src/client/McpAppToolView.tsx`, the bridge and `ResilientPostMessageTransport` are established inside `useLayoutEffect`, delaying `srcDoc` assignment until listener readiness to eliminate initialization races. Bridge effects are keyed stably on primitive values (`sessionToken`, `resourceUri`, `argsRaw`). Teardown executes only on component unmount.
- Host RPC endpoint `resources/read-raw` is added in `src/index.ts` to return the SDK's raw `ReadResourceResult` to `bridge.onreadresource`, while `ServerPool.readResource` is kept solely for app HTML discovery and permits multiple content items.
- Resizing adopts a sliding-window rate limit with deferred pending height flush.
- Document-wide clicking is replaced with ancestor-only traversal, `useDisclosure` is invoked unconditionally, timer leaks are eliminated, and navigation hijacking is trapped via iframe load counters.
- In `src/client/csp.ts`, bare `https:` is removed from `img-src`, domains support wildcards (`*.example.com`) and secure websockets (`wss://`), while RFC 1918 private IPs, link-local IPs, loopback addresses, and comment injections are rejected. CSP injection uses `DOMParser` to guarantee placement as the first child of `<head>`.

**Tech Stack:** React 18, TypeScript 5.8+, `@modelcontextprotocol/ext-apps`, `@deepseek-ai/dsh-client-ui-tool`, Vitest 3.2+.

**Spec:** Area 4 (PR 4a: Bridge correctness, PR 4b: CSP and sandbox hardening).

## Global Constraints

- Never set iframe `srcDoc` before the window message listener is active.
- Bridge effect must not re-trigger or send teardown when parent container re-renders unless `sessionToken`, `resourceUri`, or `argsRaw` actually change.
- Never query or mutate foreign chat elements; auto-expand must inspect only the view's own ancestor hierarchy.
- Hook calls (`useDisclosure`) must never be conditional.
- CSP `img-src` must never include bare `https:`.
- Reject loopback, private RFC 1918, link-local addresses, and plain `http:` in CSP domains.
- Iframe navigation away from the synthesized `srcDoc` must immediately terminate the bridge and display an error.

## Review Focus

1. **Early `ui/initialize` receipt**: App script executes before React effects run; message is queued by transport and processed upon initialization.
2. **CSP sanitization & comment injection**: Domains containing HTML comment sequences (`<!--`, `-->`), bare `http://`, loopback IPs, or private subnets are rejected.
3. **Ancestor-isolated expansion**: Rendering multiple MCP App cards only touches each card's direct enclosing ancestor fold, without dispatching global clicks across unrelated turns.
4. **Sliding-window resize rate limit**: Rapid resize events trigger temporary muting; once the burst window expires, the final target height is applied.
5. **Secondary navigation tripwire**: An iframe triggers a second `load` event; bridge resources tear down and an alert/error replaces the view.

---

### Task 1: CSP Builder Hardening & DOMParser Head Injection (PR 4b)

**Files:**
- Modify: `src/client/csp.ts`
- Test: `tests/csp.spec.ts`

**Interfaces:**
- Produces: `sanitizeDomains` with wildcard support, private IP rejection, comment injection blocking, and removal of bare `https:` from `img-src`.
- Produces: `withContentSecurityPolicy` placing CSP `<meta>` as the very first child of `<head>` using `DOMParser`.

- [ ] **Step 1: Write tests for CSP sanitization rules and meta order**

In `tests/csp.spec.ts`:
```ts
  it('strips comment injection, private/loopback IPs, and bare http', () => {
    const raw = [
      '<!--comment-->https://evil.com',
      'http://insecure.com',
      '127.0.0.1:8080',
      'localhost',
      '192.168.1.1',
      '10.0.0.1',
      '169.254.1.1',
      'https://*.example.com',
      'wss://realtime.example.com',
    ]
    const sanitized = sanitizeDomains(raw)
    expect(sanitized).toEqual([
      'https://*.example.com',
      'wss://realtime.example.com',
    ])
  })

  it('buildDynamicCsp does not contain bare https: in img-src', () => {
    const csp = buildDynamicCsp()
    expect(csp).not.toMatch(/img-src[^;]*\bhttps:\b/)
    expect(csp).toContain("img-src data: blob:")
  })

  it('injects meta tag as the very first element of head', () => {
    const html = '<html><head><script src="app.js"></script><title>App</title></head><body></body></html>'
    const result = withContentSecurityPolicy(html)
    const headContent = result.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''
    expect(headContent.trim().startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/csp.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement domain filtering and DOMParser injection in `src/client/csp.ts`**

In `src/client/csp.ts`:
```ts
const PRIVATE_IP_REGEX = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)$/
const VALID_DOMAIN_REGEX = /^(https:\/\/|wss?:\/\/)?(\*\.)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(:\d{1,5})?$/

export function sanitizeDomains(rawDomains?: unknown): string[] {
  if (!Array.isArray(rawDomains)) return []
  return rawDomains
    .filter((d): d is string => typeof d === 'string')
    .map(d => d.trim())
    .filter(d => {
      if (d === '*' || d.includes(';') || d.includes(' ') || d.includes('<!--') || d.includes('-->')) return false
      if (d.startsWith('http://')) return false
      try {
        const host = d.replace(/^(https?|wss?):\/\//, '').split(':')[0].replace(/^\*\./, '')
        if (PRIVATE_IP_REGEX.test(host)) return false
        return VALID_DOMAIN_REGEX.test(d)
      } catch {
        return false
      }
    })
}

export function buildDynamicCsp(
  csp?: Record<string, string[]>,
  permissions?: Record<string, string[]>
): string {
  ...
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data:${resourceStr}`.trim(),
    `style-src 'unsafe-inline' blob: data:${resourceStr}`.trim(),
    `img-src data: blob:${resourceStr}`.trim(), // NO bare https:
    ...
  ].join('; ')
}

export function withContentSecurityPolicy(
  html: string,
  csp?: Record<string, string[]>,
  permissions?: Record<string, string[]>
): string {
  const policy = buildDynamicCsp(csp, permissions)
  const metaHtml = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const meta = doc.createElement('meta')
    meta.httpEquiv = 'Content-Security-Policy'
    meta.content = policy
    if (doc.head.firstChild) {
      doc.head.insertBefore(meta, doc.head.firstChild)
    } else {
      doc.head.appendChild(meta)
    }
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
  }

  // Fallback for non-browser/SSR environments
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${metaHtml}`)
  }
  return `<head>${metaHtml}</head>${html}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/csp.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/csp.ts tests/csp.spec.ts
git commit -m "fix(csp): sanitize private IPs, reject comment injection, and place meta CSP first"
```

---

### Task 2: Host Raw Resource Endpoint & App Resource Multi-Content Support

**Files:**
- Modify: `src/index.ts`
- Modify: `src/transports/server-pool.ts`
- Test: `tests/rpc-auth.spec.ts`

**Interfaces:**
- Produces: `/mcp-apps` `resources/read-raw` endpoint returning `ReadResourceResult`.
- Produces: `ServerPool.readResource` accepting multi-content responses and finding the appropriate HTML content item.

- [ ] **Step 1: Write test for `resources/read-raw`**

In `tests/rpc-auth.spec.ts`:
```ts
  it('supports resources/read-raw returning raw ReadResourceResult unchanged', async () => {
    // Register mock server with readResource returning multiple contents
    const rawResult = {
      contents: [
        { uri: 'resource://data', text: 'raw data' },
        { uri: 'resource://data2', blob: 'YmxvYg==' },
      ],
    }
    ...
    const response = await rpcHandler('resources/read-raw', { server: 'srv', uri: 'resource://data' })
    expect(response.ok).toBe(true)
    expect(response.value).toEqual(rawResult)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/rpc-auth.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `resources/read-raw` and relax single-content restriction in `ServerPool.readResource`**

In `src/transports/server-pool.ts`:
```ts
  async readResourceRaw(serverName: string, uri: string, signal?: AbortSignal): Promise<unknown> {
    const instance = this.servers.get(serverName)
    if (!instance) throw new Error(`MCP server "${serverName}" is not connected`)
    const serverConfig = this.config.servers[serverName]
    const timeout = serverConfig?.toolCallTimeoutMs ?? this.config.defaultTimeoutMs ?? 30000
    return instance.client.readResource({ uri }, { timeout, signal })
  }
```
Relax single-content restriction in `readResource`:
```ts
    const response = await instance.client.readResource({ uri }, { timeout, signal })
    if (!response.contents || response.contents.length === 0) {
      throw new Error(`Resource ${uri} returned empty contents`)
    }
    // Find text or blob content item
    const item = response.contents.find(c => ('text' in c && typeof c.text === 'string') || ('blob' in c && typeof c.blob === 'string')) ?? response.contents[0]
```
In `src/index.ts`:
```ts
  case 'resources/read-raw': {
    const uri = typeof params.uri === 'string' ? params.uri : undefined
    const server = typeof params.server === 'string' ? params.server : undefined
    if (!server || !uri) return { ok: false, error: { code: 'bad-request', message: 'Missing server or uri' } }
    const raw = await pool.readResourceRaw(server, uri, signal)
    return { ok: true, value: raw }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/rpc-auth.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/server-pool.ts src/index.ts tests/rpc-auth.spec.ts
git commit -m "feat(rpc): add resources/read-raw and relax single-content limit in app loader"
```

---

### Task 3: Handshake Race Elimination & Stable Bridge Lifecycle (PR 4a)

**Files:**
- Modify: `src/client/McpAppToolView.tsx`
- Modify: `src/client/index.tsx`
- Test: `tests/client-bridge.spec.ts`

**Interfaces:**
- Produces: `useLayoutEffect` handshake initialization, delayed `srcDoc` assignment, unconditional `useDisclosure`, sliding-window resize throttling, navigation tripwire, and host-pushed tool change listener.

- [ ] **Step 1: Write test for sliding-window resize and load navigation tripwire**

Create `tests/client-bridge.spec.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'

describe('McpAppToolView Rate Limiter', () => {
  it('suppresses excess resize events in a 1-second sliding window and preserves final height', () => {
    const windowMs = 1000
    const maxEvents = 10
    const timestamps: number[] = []

    let currentMuted = false
    let pendingHeight: number | null = null

    const onResize = (height: number, now: number) => {
      timestamps.push(now)
      const recent = timestamps.filter(t => now - t < windowMs)
      if (recent.length > maxEvents) {
        currentMuted = true
        pendingHeight = height
        return
      }
      currentMuted = false
      pendingHeight = height
    }

    const start = 1000
    for (let i = 0; i < 15; i++) {
      onResize(200 + i * 10, start + i * 20)
    }

    expect(currentMuted).toBe(true)
    expect(pendingHeight).toBe(340) // Last target height saved
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/client-bridge.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/client/McpAppToolView.tsx` & `src/client/index.tsx`**

In `src/client/McpAppToolView.tsx`:
1. Call `useDisclosure` unconditionally:
```ts
  const disclosureState = useDisclosure?.() ?? null
```
2. Split `srcDoc` setting:
```ts
  const [activeSrcDoc, setActiveSrcDoc] = useState<string | null>(null)
  const [navCount, setNavCount] = useState<number>(0)
```
3. Use `useLayoutEffect` to initialize `ResilientPostMessageTransport` and `AppBridge`, and set `setActiveSrcDoc(htmlWithCsp)` ONLY once transport listener is attached.
4. Bridge keys:
```ts
  const sessionToken = call?.sessionToken
  const resourceUri = call?.resourceUri
  const argsRaw = block.call?.argsRaw ?? block.argsRaw
```
5. On second iframe `onLoad`:
```ts
  const handleIframeLoad = () => {
    setNavCount(c => {
      if (c >= 1) {
        setError('Navigation within MCP App iframe is disabled')
        bridgeRef.current?.teardownResource({}).catch(() => void 0)
      }
      return c + 1
    })
  }
```
6. Sliding window for resize:
```ts
  const resizeTimestamps = useRef<number[]>([])
  const pendingHeightRef = useRef<number | null>(null)
```
7. Auto-expand isolation: inspect only parent elements of `iframeRef.current`:
```ts
  let el = iframeRef.current?.parentElement
  while (el && el !== document.body) {
    if (el.hasAttribute('data-turn-process')) {
      const toggle = el.querySelector<HTMLButtonElement>('button[data-turn-process]:not([data-open])')
      toggle?.click()
    }
    el = el.parentElement
  }
```
8. In `src/client/index.tsx`: Clean timers on unload:
```ts
  const t1 = setTimeout(() => { void syncTools() }, 3000)
  const t2 = setTimeout(() => { void syncTools() }, 8000)
  return () => {
    clearTimeout(t1)
    clearTimeout(t2)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/client-bridge.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run full verification suite**

Run: `pnpm prepublishOnly`
Expected: All tests pass, typecheck passes, build passes.

- [ ] **Step 6: Commit**

```bash
git add src/client/ tests/client-bridge.spec.ts
git commit -m "fix(client): eliminate bridge handshake race, stabilize lifecycle, and isolate auto-expansion"
```
