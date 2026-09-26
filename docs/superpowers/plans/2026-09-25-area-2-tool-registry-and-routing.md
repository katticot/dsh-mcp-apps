# Area 2: Tool Registry & Routing Implementation Plan (PR 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement safe, atomic tool synchronization, reliable tool routing, change detection via fingerprinting, unambiguous tool naming, and sequence-ordered tool refreshes in `ServerToolManager` and `ServerPool`.

**Architecture:** 
- In `src/transports/server-pool.ts`, `findServerForTool` searches registered UI tools by `rawName` or `publicName` and returns `undefined` when no matching server is found. Notification listeners for `ToolListChangedNotificationSchema` are attached before the first tool listing, and refreshes are tagged with monotonic sequence IDs to discard out-of-order responses.
- In `src/tool-manager.ts`, `syncServerTools` builds candidate disposers in isolation, wraps each tool registration in try-catch to isolate bad tools (including malformed non-`ui://` URIs), fingerprints each tool's definition (`description`, `inputSchema`, `resourceUri`), disposes and replaces only changed definitions while retaining identical ones, detects public name collisions at registration time, and atomically swaps in the new disposer state.
- In `src/config.ts`, the server dictionary schema rejects server names containing consecutive underscores (`__`) or ending with an underscore (`_`), eliminating naming ambiguities.

**Tech Stack:** TypeScript 5.8+, Node.js 22+, `@deepseek-ai/schemastery`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, Vitest 3.2+.

**Spec:** Area 2 (PR 2, high): Tool registry and routing.

## Global Constraints

- Server names containing `__` or ending in `_` must be rejected at config validation time.
- Bad tools (schema errors, non-`ui://` URIs) must be logged and skipped without aborting registration of valid sibling tools.
- Tool sync must be atomic: stored disposers must not be partially mutated if an unexpected fatal exception occurs.
- Re-register tools only when their fingerprint (`hash(description, inputSchema, resourceUri)`) changes.
- Duplicate public names generated during registration must be deduplicated with a deterministic hash suffix.
- Tool refreshes must use sequence numbers: out-of-order refresh responses must be discarded.

## Review Focus

1. **Mid-list bad tool handling**: A server exposes 3 tools where tool 2 has a non-`ui://` URI or malformed definition. Expected: tool 1 and tool 3 successfully register; tool 2 is logged and skipped.
2. **Definition change re-registration**: A server re-syncs with tool A's description or URI changed. Expected: the old disposer for tool A is called, a new disposer is registered, and tool B (unchanged) retains its original registration.
3. **Ambiguous server and tool names**: Configuration with server names `a__b` or `a_` is rejected by config schema; registering `('a__b', 'c')` and `('a', 'b__c')` never produces colliding unhandled names.
4. **Out-of-order refreshes**: Refresh #1 returns after Refresh #2 completes. Expected: the state from Refresh #2 remains registered; Refresh #1 is dropped.
5. **Lookup fallback removal**: `findServerForTool("unknown_tool")` returns `undefined`, never falling back to an arbitrary connected server.

---

### Task 1: Fix `findServerForTool` & lookup accuracy

**Files:**
- Modify: `src/transports/server-pool.ts:120-135`
- Test: `tests/tool-manager.spec.ts`

**Interfaces:**
- Consumes: `UiToolDescriptor` (`publicName`, `rawName`, `serverName`).
- Produces: `findServerForTool(toolName: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

In `tests/tool-manager.spec.ts`:
```ts
describe('findServerForTool', () => {
  it('returns matching server for raw or public name and undefined for unknown tool', async () => {
    const mockToolsService = { register: vi.fn(() => vi.fn()) }
    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const pool = new ServerPool({} as any, { servers: {} }, manager)

    manager.syncServerTools('weather-srv', {} as any, [
      {
        name: 'get_forecast',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'ui://weather/forecast' } },
      },
    ])

    expect(pool.findServerForTool('get_forecast')).toBe('weather-srv')
    expect(pool.findServerForTool('mcp__weather-srv__get_forecast')).toBe('weather-srv')
    expect(pool.findServerForTool('unknown_tool')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: FAIL (or returns incorrect fallback if servers map is populated).

- [ ] **Step 3: Implement minimal fix in `src/transports/server-pool.ts`**

In `src/transports/server-pool.ts`, replace `findServerForTool`:
```ts
  findServerForTool(toolName: string): string | undefined {
    const snapshot = this.getUiToolsSnapshot()
    const foundUi = snapshot.find(t => t.rawName === toolName || t.publicName === toolName)
    if (foundUi?.serverName) return foundUi.serverName
    return undefined
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/server-pool.ts tests/tool-manager.spec.ts
git commit -m "fix(tool-manager): return undefined for unknown tools in findServerForTool"
```

---

### Task 2: Config Schema Server Name Ambiguity Protection

**Files:**
- Modify: `src/config.ts:80-84`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Consumes: `@deepseek-ai/schemastery`.
- Produces: `Config.servers` key validation rejecting `__` and trailing `_`.

- [ ] **Step 1: Write failing tests for server name restrictions**

In `tests/config.spec.ts`:
```ts
  it('rejects server names that contain __ or end with _', () => {
    expect(() => Config({
      servers: {
        'invalid__name': { transport: 'stdio', command: 'node' },
      },
    } as any)).toThrow()

    expect(() => Config({
      servers: {
        'trailing_': { transport: 'stdio', command: 'node' },
      },
    } as any)).toThrow()

    const valid = Config({
      servers: {
        'valid-name': { transport: 'stdio', command: 'node' },
        'valid_name_2': { transport: 'stdio', command: 'node' },
      },
    } as any)
    expect(valid.servers['valid-name']).toBeDefined()
    expect(valid.servers['valid_name_2']).toBeDefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: FAIL (Schema currently accepts any string key).

- [ ] **Step 3: Update `Config` schema in `src/config.ts`**

In `src/config.ts`:
```ts
export const SERVER_NAME_REGEX = /^(?!.*__)(?!.*_$)[a-zA-Z0-9_-]+$/

const ServerNameSchema = Schema.string()
  .pattern(SERVER_NAME_REGEX)
  .description('Server name cannot contain consecutive underscores or end with an underscore')

export const Config: Schema<Config> = Schema.object({
  servers: Schema.dict(Schema.union([StdioSchema, RemoteSchema, IpcSchema]), ServerNameSchema).default({}),
  defaultTimeoutMs: Schema.number().default(30000),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.spec.ts
git commit -m "fix(config): reject server names containing __ or ending with _"
```

---

### Task 3: Safe, Resilient Tool Synchronization and Duplicate Detection

**Files:**
- Modify: `src/tool-manager.ts`
- Test: `tests/tool-manager.spec.ts`

**Interfaces:**
- Produces: `ServerToolManager.syncServerTools` with:
  - Isolation of invalid tools (malformed schemas, invalid non-`ui://` URI).
  - Fingerprinting of tools (`description`, `inputSchema`, `resourceUri`).
  - Collision detection adding deterministic hash suffix on colliding public names.
  - Atomic disposer swap inside `finally`.

- [ ] **Step 1: Write failing tests for bad tool skip, re-registration on change, and duplicate names**

In `tests/tool-manager.spec.ts`:
```ts
  it('skips a bad tool mid-list without failing remaining tools', () => {
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return vi.fn()
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    const tools: Tool[] = [
      { name: 'tool_one', inputSchema: { type: 'object' } },
      {
        name: 'bad_tool',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'https://invalid-non-ui-scheme.com' } },
      },
      { name: 'tool_three', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, tools)
    expect(registered).toContain('mcp__test-srv__tool_one')
    expect(registered).not.toContain('mcp__test-srv__bad_tool')
    expect(registered).toContain('mcp__test-srv__tool_three')
  })

  it('re-registers tools whose definition changed and retains unchanged ones', () => {
    const disposed: string[] = []
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return () => disposed.push(def.name)
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    const initialTools: Tool[] = [
      { name: 'stable_tool', description: 'v1', inputSchema: { type: 'object' } },
      { name: 'changing_tool', description: 'v1', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, initialTools)
    expect(registered).toHaveLength(2)

    // Re-sync with changed description
    const updatedTools: Tool[] = [
      { name: 'stable_tool', description: 'v1', inputSchema: { type: 'object' } },
      { name: 'changing_tool', description: 'v2 modified', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('test-srv', {} as any, updatedTools)
    // changing_tool disposed and re-registered
    expect(disposed).toContain('mcp__test-srv__changing_tool')
    expect(disposed).not.toContain('mcp__test-srv__stable_tool')
  })

  it('detects duplicate public names and generates unique names with hash suffix', () => {
    const registered: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registered.push(def.name)
        return vi.fn()
      }),
    }
    const manager = new ServerToolManager(mockToolsService, new AppSessionStore())

    // Tools that would normalize to the same public name
    const tools: Tool[] = [
      { name: 'query_db', inputSchema: { type: 'object' } },
      { name: 'query-db', inputSchema: { type: 'object' } },
    ]

    manager.syncServerTools('srv', {} as any, tools)
    expect(registered).toHaveLength(2)
    expect(registered[0]).not.toEqual(registered[1])
  })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement fingerprinting, bad-tool isolation, collision detection, and atomic swap**

In `src/tool-manager.ts`:
1. Add helper to fingerprint tool definition:
```ts
function computeToolFingerprint(tool: Tool, resourceUri?: string): string {
  const content = JSON.stringify({
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {},
    resourceUri: resourceUri ?? '',
  })
  return crypto.createHash('sha256').update(content).digest('hex')
}
```
2. Track `toolFingerprints: Map<string, Map<string, string>> = new Map()`.
3. Track active public names across servers or within server to detect duplicate registrations. If `candidatePublicName` is already claimed in this sync or by another active tool, append `_${hash}`.
4. If `resourceUri` is present and does not start with `ui://`, log a warning and skip that tool.
5. In `syncServerTools`, build `nextServerDisposers` and `nextServerFingerprints` locally in memory.
6. Swap inside `try ... finally` block:
```ts
    try {
      // Loop over tools with individual try/catch
    } finally {
      this.disposers.set(serverName, nextServerDisposers)
      this.fingerprints.set(serverName, nextServerFingerprints)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-manager.ts tests/tool-manager.spec.ts
git commit -m "feat(tool-manager): resilient tool sync with definition fingerprinting and collision handling"
```

---

### Task 4: Ordered Refreshes & Notification Listener Lifecycle

**Files:**
- Modify: `src/transports/server-pool.ts`
- Test: `tests/tool-manager.spec.ts`

**Interfaces:**
- Produces: `ServerPool.refreshTools` ordered by sequence numbers, dropping stale list results, and subscribing to `ToolListChangedNotificationSchema` before initial sync.

- [ ] **Step 1: Write test for out-of-order refresh dropping**

In `tests/tool-manager.spec.ts`:
```ts
  it('drops out-of-order tool refresh responses so the newest list wins', async () => {
    const syncSpy = vi.fn()
    const mockToolManager = {
      syncServerTools: syncSpy,
      getUiToolsSnapshot: () => [],
      evictServer: vi.fn(),
    } as any

    const pool = new ServerPool({} as any, { servers: {} }, mockToolManager)

    // Simulate two concurrent listTools calls where call 1 resolves AFTER call 2
    let resolveFirst!: (value: any) => void
    const firstCallPromise = new Promise(resolve => { resolveFirst = resolve })

    const mockClient = {
      listTools: vi.fn()
        .mockImplementationOnce(() => firstCallPromise)
        .mockImplementationOnce(async () => ({ tools: [{ name: 'v2_tool', inputSchema: {} }] })),
      setNotificationHandler: vi.fn(),
    } as any

    // Trigger refresh 1
    const p1 = (pool as any).refreshTools('srv', mockClient)
    // Trigger refresh 2
    const p2 = (pool as any).refreshTools('srv', mockClient)

    await p2
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenLastCalledWith('srv', mockClient, [{ name: 'v2_tool', inputSchema: {} }], undefined)

    // Now resolve the first call late
    resolveFirst({ tools: [{ name: 'v1_tool', inputSchema: {} }] })
    await p1

    // Should still have been called only once, ignoring stale v1_tool
    expect(syncSpy).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: FAIL (refresh 1 overwrites refresh 2).

- [ ] **Step 3: Implement monotonic refresh sequence in `src/transports/server-pool.ts`**

In `src/transports/server-pool.ts`:
Add state:
```ts
  private refreshSeq = new Map<string, number>()
  private lastAppliedSeq = new Map<string, number>()
```
In `startServer`:
```ts
    // Subscribe to tool changes BEFORE initial sync
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools(serverName, client)
      } catch (err) {
        console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err)
      }
    })

    // Initial tool sync
    await this.refreshTools(serverName, client)
```
In `refreshTools`:
```ts
  private async refreshTools(serverName: string, client: Client): Promise<void> {
    const seq = (this.refreshSeq.get(serverName) ?? 0) + 1
    this.refreshSeq.set(serverName, seq)

    const toolsResult = await client.listTools()
    const lastSeq = this.lastAppliedSeq.get(serverName) ?? 0
    if (seq < lastSeq) {
      // Outdated response; discard
      return
    }
    this.lastAppliedSeq.set(serverName, seq)

    const serverConfig = this.config.servers[serverName]
    this.toolManager.syncServerTools(serverName, client, toolsResult.tools, serverConfig)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run full verification suite**

Run: `pnpm prepublishOnly`
Expected: All tests pass, typecheck passes, build passes.

- [ ] **Step 6: Commit**

```bash
git add src/transports/server-pool.ts tests/tool-manager.spec.ts
git commit -m "feat(server-pool): sequence-order tool refreshes and register notification handlers before initial sync"
```
