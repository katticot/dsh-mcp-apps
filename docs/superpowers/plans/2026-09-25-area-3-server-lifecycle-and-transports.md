# Area 3: Server Lifecycle & Transports Implementation Plan (PR 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish hardened server lifecycle management, concurrent server startup, timeout and signal cancellation propagation, automatic reconnection with backoff, secure environment variable expansion, IPC buffer/permission defense, and transport constraints across stdio, IPC, and remote protocols.

**Architecture:** 
- `ServerPool` manages an `AbortController` checked after every asynchronous milestone in `startServer`. Parallel startup uses `Promise.allSettled`, and `stopAll` aborts the pool, awaits settlement of all in-progress starts, and cleanly tears down clients and transports.
- Stdio process management cleans up unused injects (`webServer`, `subprocess`), and environment expansion restricts access to `DSH_*` and `/KEY|PASSWORD|SECRET|TOKEN/i` variables unless explicitly whitelisted.
- Timeouts (`toolCallTimeoutMs ?? defaultTimeoutMs`) and `signal` propagation are enforced through `client.callTool` and `client.readResource`, wired through tool execution signals in `ServerToolManager`.
- Reconnection logic triggers upon unexpected transport/client close with exponential backoff honoring `reconnectOptions`.
- IPC transport incorporates `StringDecoder`, enforces a 16MB line/buffer ceiling, validates 0700 POSIX directory permissions and ownership, while Remote transport forbids non-loopback `http://` and rejects headers on WebSocket connections.
- Size caps enforce maximum resource sizes and maximum tool limits per server.

**Tech Stack:** TypeScript 5.8+, Node.js 22+ (`node:net`, `node:fs`, `node:string_decoder`), DeepSeek Harness (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-subprocess`), `@modelcontextprotocol/sdk`, Vitest 3.2+.

**Spec:** Area 3 (PR 3, high): Server lifecycle and transports.

## Global Constraints

- Never leave zombie processes, leaked sockets, or orphaned tool registrations on shutdown or aborted startup.
- `Promise.allSettled` must be used so slow or failing servers do not block or fail other server connections.
- Tool call timeouts and abort signals must be forwarded to the MCP SDK client calls.
- `${VAR}` template expansion must never read `DSH_*` or case-insensitive secret patterns unless explicitly allowed.
- IPC sockets must reject directories not owned by the current UID or with permissions other than `0700` on POSIX. Max IPC message line/buffer is 16MB.
- Remote transport URLs with `http://` must be rejected unless resolving to loopback (`localhost`, `127.0.0.1`, `::1`). WebSockets with custom headers must throw an error.
- Enforce max 256 tools per server and max 10MB per resource.

## Review Focus

1. **Immediate abort on start**: Calling `startAll()` immediately followed by `stopAll()` cancels in-flight connections and cleanly cleans up all resources without dangling processes.
2. **Slow server concurrency isolation**: One server hangs during connect/handshake; other servers start, register tools, and respond immediately.
3. **Signal and timeout cancellation**: An active tool call reaches its `toolCallTimeoutMs` or receives an abort signal; the underlying call aborts immediately.
4. **Multi-byte UTF-8 split in IPC**: Multi-byte characters (e.g. emojis or CJK glyphs) split across IPC buffer chunks reassemble cleanly without character corruption.
5. **Oversized IPC line buffer overflow**: A malicious or runaway process sends an IPC stream with no newline exceeding 16MB; the transport destroys the socket and errors cleanly.

---

### Task 1: Startup Abort Handling & Parallel Server Launching

**Files:**
- Modify: `src/transports/server-pool.ts`
- Test: `tests/server-pool.spec.ts`

**Interfaces:**
- Produces: `ServerPool.startAll()` using `Promise.allSettled`, abort controller checked across connection stages, and `stopAll()` awaiting pending startups.

- [ ] **Step 1: Write tests for rapid start/stop cancellation and parallel startup**

Create `tests/server-pool.spec.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { ServerPool } from '../src/transports/server-pool'

describe('ServerPool Lifecycle', () => {
  it('startAll runs servers in parallel and slow server does not block others', async () => {
    let fastConnected = false
    const pool = new ServerPool({} as any, {
      servers: {
        fast: { transport: 'stdio', command: 'fast-srv' },
        slow: { transport: 'stdio', command: 'slow-srv' },
      },
    }, { syncServerTools: vi.fn(), evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    vi.spyOn(pool, 'startServer').mockImplementation(async (name: string) => {
      if (name === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 500))
      } else {
        fastConnected = true
      }
    })

    const startPromise = pool.startAll()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fastConnected).toBe(true)
    await startPromise
  })

  it('stopAll aborts pending startups and leaves no registered servers behind', async () => {
    const pool = new ServerPool({} as any, {
      servers: {
        server1: { transport: 'stdio', command: 'srv' },
      },
    }, { syncServerTools: vi.fn(), evictServer: vi.fn(), getUiToolsSnapshot: () => [] } as any)

    vi.spyOn(pool, 'startServer').mockImplementation(async (_name, _config, signal) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (signal?.aborted) throw new Error('Aborted')
    })

    const startPromise = pool.startAll()
    await pool.stopAll()
    await expect(startPromise).resolves.not.toThrow()
    expect((pool as any).servers.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement abort controller and `Promise.allSettled` in `src/transports/server-pool.ts`**

In `src/transports/server-pool.ts`:
1. Add `private lifecycleController = new AbortController()` and `private startupTasks = new Map<string, Promise<void>>()`.
2. Update `startAll()`:
```ts
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
                console.error(`mcp-apps: failed to connect to server "${name}":`, err)
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
```
3. In `startServer(serverName, serverConfig, signal?)`: Check `signal?.aborted` after every await:
   - after transport connect
   - after initial tool sync
   If aborted during startup, invoke `disposeTransport()` immediately and throw.
4. Update `stopAll()`:
```ts
  async stopAll(): Promise<void> {
    this.lifecycleController.abort()
    // Wait for in-flight startups to settle
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/server-pool.ts tests/server-pool.spec.ts
git commit -m "feat(server-pool): parallel server startup and abort-aware stopAll lifecycle"
```

---

### Task 2: Signal & Timeout Cancellation & Reconnection Backoff

**Files:**
- Modify: `src/transports/server-pool.ts`
- Modify: `src/tool-manager.ts`
- Test: `tests/server-pool.spec.ts`

**Interfaces:**
- Produces: Proper timeout options and AbortSignal passing to `callTool` and `readResource`.
- Produces: Client `onclose` cleanup and backoff reconnect logic based on `reconnectOptions`.

- [ ] **Step 1: Write tests for callTool timeout, signal forwarding, and reconnect backoff**

In `tests/server-pool.spec.ts`:
```ts
  it('forwards timeout and signal into client.callTool', async () => {
    const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [] }) }
    const pool = new ServerPool({} as any, {
      servers: { srv: { transport: 'stdio', command: 'cmd', toolCallTimeoutMs: 5000 } },
    }, { getUiToolsSnapshot: () => [] } as any)
    ;(pool as any).servers.set('srv', { client: mockClient, disposeTransport: vi.fn() })

    const controller = new AbortController()
    await pool.callTool('srv', 'test_tool', { a: 1 }, controller.signal)

    expect(mockClient.callTool).toHaveBeenCalledWith(
      { name: 'test_tool', arguments: { a: 1 } },
      { timeout: 5000, signal: controller.signal }
    )
  })

  it('evicts server tools on close and schedules reconnection with backoff', async () => {
    vi.useFakeTimers()
    const evictSpy = vi.fn()
    const pool = new ServerPool({} as any, {
      servers: {
        reconnectingSrv: {
          transport: 'stdio',
          command: 'cmd',
          reconnectOptions: { maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2 },
        } as any,
      },
    }, { evictServer: evictSpy, getUiToolsSnapshot: () => [] } as any)

    const startSpy = vi.spyOn(pool, 'startServer').mockResolvedValue()
    ;(pool as any).handleServerClose('reconnectingSrv')

    expect(evictSpy).toHaveBeenCalledWith('reconnectingSrv')
    vi.advanceTimersByTime(1000)
    expect(startSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement timeout/signal forwarding and reconnect in `server-pool.ts` & `tool-manager.ts`**

In `src/transports/server-pool.ts`:
1. In `callTool(serverName, name, args, signal)`:
```ts
    const serverConfig = this.config.servers[serverName]
    const timeout = serverConfig?.toolCallTimeoutMs ?? this.config.defaultTimeoutMs ?? 30000
    return instance.client.callTool(
      { name, arguments: args ?? {} },
      { timeout, signal }
    )
```
2. In `readResource(serverName, uri, signal)`:
```ts
    const serverConfig = this.config.servers[targetServer]
    const timeout = serverConfig?.toolCallTimeoutMs ?? this.config.defaultTimeoutMs ?? 30000
    const response = await instance.client.readResource(
      { uri },
      { timeout, signal }
    )
```
3. In `startServer`:
```ts
    const transport = ...
    transport.onclose = () => this.handleServerClose(serverName)
```
4. Add reconnect backoff handler:
```ts
  private reconnectAttempts = new Map<string, number>()
  private reconnectTimers = new Map<string, NodeJS.Timeout>()

  private handleServerClose(serverName: string): void {
    this.toolManager.evictServer(serverName)
    this.servers.delete(serverName)

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
    const timer = setTimeout(async () => {
      try {
        if (!this.lifecycleController.signal.aborted) {
          await this.startServer(serverName, serverConfig, this.lifecycleController.signal)
          this.reconnectAttempts.delete(serverName)
        }
      } catch (err) {
        console.error(`mcp-apps: reconnect attempt failed for "${serverName}":`, err)
      }
    }, delay)
    this.reconnectTimers.set(serverName, timer)
  }
```
5. In `src/tool-manager.ts`: Update tool execute to forward `exec?.signal`:
```ts
execute: async (args: unknown, exec?: { agent?: { id?: string }; rootCallId?: string; callId?: string; signal?: AbortSignal }) => {
  ...
  const result = await client.callTool({
    name: tool.name,
    arguments: argumentsValue as Record<string, unknown>,
  }, { signal: exec?.signal })
  ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/server-pool.ts src/tool-manager.ts tests/server-pool.spec.ts
git commit -m "feat(server-pool): wire execution timeouts, cancellation signals, and reconnect backoff"
```

---

### Task 3: Environment Variable Redaction & Clean Injections

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Produces: `expandEnvString` blocking `DSH_*` and `/KEY|PASSWORD|SECRET|TOKEN/i` patterns unless explicitly allowed.
- Produces: `src/index.ts` inject cleaned to `['tools', 'connection']`.

- [ ] **Step 1: Write test for sensitive environment expansion blocking**

In `tests/config.spec.ts`:
```ts
  it('blocks reading DSH_* and sensitive secrets during variable expansion unless explicitly allowed', () => {
    const env = {
      DSH_INTERNAL_TOKEN: 'super-secret',
      API_SECRET_KEY: 'secret-123',
      SAFE_PORT: '9000',
    }

    // Default: blocked
    expect(expandEnvString('${DSH_INTERNAL_TOKEN}', env)).toBe('')
    expect(expandEnvString('${API_SECRET_KEY}', env)).toBe('')
    expect(expandEnvString('${SAFE_PORT}', env)).toBe('9000')

    // Explicitly allowed
    expect(expandEnvString('${DSH_INTERNAL_TOKEN}', env, new Set(['DSH_INTERNAL_TOKEN']))).toBe('super-secret')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/config.ts` and `src/index.ts`**

In `src/config.ts`:
```ts
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

export function expandEnvString(
  value: string,
  env: Record<string, string | undefined> = process.env,
  allowedVars?: Set<string>
): string {
  return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
    const isBlocked = (varName.startsWith(DSH_ENV_PREFIX) || SENSITIVE_ENV_PATTERN.test(varName)) && !allowedVars?.has(varName)
    if (isBlocked) {
      return defaultValue ?? ''
    }
    const val = env[varName]
    if (val !== undefined && val !== '') {
      return val
    }
    return defaultValue ?? ''
  })
}
```
In `src/index.ts`:
```ts
export const inject = ['tools', 'connection']
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/index.ts tests/config.spec.ts
git commit -m "fix(security): prevent secret environment leakage and remove unused plugin injections"
```

---

### Task 4: IPC Hardening: StringDecoder, Line Capping, Directory Ownership

**Files:**
- Modify: `src/transports/ipc.ts`
- Test: `tests/ipc.spec.ts`

**Interfaces:**
- Produces: `IpcClientTransport` with UTF-8 `StringDecoder`, 16MB buffer cap, and POSIX `0700` parent dir checks.

- [ ] **Step 1: Write tests for multi-byte UTF-8 chunks, 16MB line limit, and directory permission validation**

Create `tests/ipc.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { IpcClientTransport } from '../src/transports/ipc'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('IpcClientTransport Hardening', () => {
  it('correctly decodes multi-byte UTF-8 split across chunks', () => {
    const transport = new IpcClientTransport({ transport: 'ipc', socketPath: '/dummy.sock' })
    const messages: any[] = []
    transport.onmessage = (msg) => messages.push(msg)

    // Emoji 🚀 is 4 bytes: [0xF0, 0x9F, 0x9A, 0x80]
    const jsonStr = JSON.stringify({ jsonrpc: '2.0', method: 'notify', params: { text: '🚀' } }) + '\n'
    const fullBuffer = Buffer.from(jsonStr, 'utf8')

    // Split mid-emoji
    const chunk1 = fullBuffer.subarray(0, fullBuffer.indexOf(0x9F) + 1)
    const chunk2 = fullBuffer.subarray(fullBuffer.indexOf(0x9F) + 1)

    ;(transport as any).handleChunk(chunk1)
    ;(transport as any).handleChunk(chunk2)

    expect(messages).toHaveLength(1)
    expect(messages[0].params.text).toBe('🚀')
  })

  it('destroys socket when line length exceeds 16MB', () => {
    const transport = new IpcClientTransport({ transport: 'ipc', socketPath: '/dummy.sock' })
    const destroySpy = vi.fn()
    ;(transport as any).socket = { destroy: destroySpy }

    const oversizedChunk = Buffer.alloc(17 * 1024 * 1024, 65) // 17MB of 'A' without newline
    expect(() => (transport as any).handleChunk(oversizedChunk)).toThrow(/exceeded/i)
    expect(destroySpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ipc.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement StringDecoder, 16MB cap, and directory checks in `src/transports/ipc.ts`**

In `src/transports/ipc.ts`:
```ts
import { StringDecoder } from 'node:string_decoder'

const MAX_IPC_BUFFER_SIZE = 16 * 1024 * 1024 // 16 MB

export class IpcClientTransport implements Transport {
  private decoder = new StringDecoder('utf8')
  ...
  // In start(): POSIX validation
  if (process.platform !== 'win32') {
    const dir = path.dirname(this.socketPath)
    if (fs.existsSync(dir)) {
      const dirStat = fs.statSync(dir)
      if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) {
        throw new Error(`Security violation: IPC directory ${dir} is owned by UID ${dirStat.uid}, expected ${process.getuid()}`)
      }
      const mode = dirStat.mode & 0o777
      if (mode !== 0o700) {
        throw new Error(`Security violation: IPC directory ${dir} mode is 0${mode.toString(8)}, expected 0700`)
      }
    }
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    if (this.buffer.length > MAX_IPC_BUFFER_SIZE) {
      this.close()
      throw new Error(`IPC message size exceeded maximum limit of ${MAX_IPC_BUFFER_SIZE} bytes`)
    }
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) {
        try {
          const parsed = JSON.parse(line) as JSONRPCMessage
          this.onmessage?.(parsed)
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ipc.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/ipc.ts tests/ipc.spec.ts
git commit -m "fix(ipc): apply StringDecoder, 16MB message limit, and 0700 directory verification"
```

---

### Task 5: Remote Transport Loopback Restriction, WebSocket Headers & Size Caps

**Files:**
- Modify: `src/transports/remote.ts`
- Modify: `src/transports/server-pool.ts`
- Test: `tests/remote.spec.ts`

**Interfaces:**
- Produces: `createRemoteTransport` rejecting non-loopback `http://` and rejecting WebSocket headers.
- Produces: Server caps (max 256 tools, max 10MB per resource).

- [ ] **Step 1: Write tests for remote transport restrictions and size caps**

Create `tests/remote.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createRemoteTransport } from '../src/transports/remote'

describe('Remote Transport Security', () => {
  it('rejects http:// transport unless host is loopback', () => {
    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://insecure-remote.com/mcp',
    })).toThrow(/http:\/\/ is forbidden except on loopback/i)

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://localhost:8080/mcp',
    })).not.toThrow()

    expect(() => createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://127.0.0.1:8080/mcp',
    })).not.toThrow()
  })

  it('throws when headers are provided for websocket transport', () => {
    expect(() => createRemoteTransport({
      transport: 'websocket',
      url: 'wss://mcp.example.com/ws',
      headers: { Authorization: 'Bearer token' },
    })).toThrow(/headers are not supported on websocket/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/remote.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement remote restrictions and size capping**

In `src/transports/remote.ts`:
```ts
export function createRemoteTransport(config: RemoteServerConfig): Transport {
  const url = new URL(config.url)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'

  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error(`Insecure transport: http:// is forbidden except on loopback (${url.hostname})`)
  }

  if (config.transport === 'websocket' && config.headers && Object.keys(config.headers).length > 0) {
    throw new Error('WebSocketClientTransport does not support custom HTTP headers')
  }
  ...
```

In `src/transports/server-pool.ts`:
Add limits:
```ts
const MAX_TOOLS_PER_SERVER = 256
const MAX_RESOURCE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
```
Enforce in `refreshTools`:
```ts
if (toolsResult.tools.length > MAX_TOOLS_PER_SERVER) {
  throw new Error(`Server "${serverName}" exceeded maximum tool limit (${MAX_TOOLS_PER_SERVER})`)
}
```
Enforce in `readResource`:
```ts
if (html.length > MAX_RESOURCE_SIZE_BYTES) {
  throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/remote.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run full verification suite**

Run: `pnpm prepublishOnly`
Expected: All tests pass, typecheck passes, build passes.

- [ ] **Step 6: Commit**

```bash
git add src/transports/remote.ts src/transports/server-pool.ts tests/remote.spec.ts
git commit -m "feat(transports): enforce loopback http restrictions, websocket header check, and payload size caps"
```
