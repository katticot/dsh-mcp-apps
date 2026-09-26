# CI Safety Net & Reverse Tool-Call Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a robust CI typechecking safety net (Area 0) and implement strict reverse tool-call authorization and bounded session management for MCP Apps (Area 1).

**Architecture:** 
- Area 0 adds `pnpm typecheck` (`tsc --noEmit`) to GitHub Actions CI, addresses type declaration gaps in context and transport code, adds workflow permissions, aligns Node engine requirements, and expands TypeScript configuration to cover `tests/`.
- Area 1 implements a bounded LRU `AppSessionStore` with expiration pruning, scopes reverse tool calling to server-configured allowlists, binds sessions to tool execution context (`agentId`, `callId`), prevents app-only tools from registering to the model runtime, and strictly guards `/mcp-apps` RPC `tools/call` against unauthenticated, cross-server, or disallowed calls.

**Tech Stack:** TypeScript 5.8+, Node.js 22+, DeepSeek Harness (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-subprocess`), `@modelcontextprotocol/ext-apps`, Vitest 3.2+.

**Spec:** Area 0 (PR 0: CI safety net) and Area 1 (PR 1: Reverse tool-call authorization).

## Global Constraints

- Never use unauthenticated fallbacks (`params.server` or `findServerForTool`) in `/mcp-apps` `tools/call`.
- `allowAppToolCalls` must be a per-server configuration option defaulting to `false`.
- App-only tools (`isToolVisibilityAppOnly`) must not be registered with the LLM in `ctx.tools`.
- Sessions must be bounded to 1,000 entries by default, evicting the least recently used entry.
- CI workflow must declare `permissions: { contents: read }`.
- `package.json` engines must require Node `>=22.0.0` matching CI matrix.

## Review Focus

1. **Unauthenticated Reverse Call**: A caller invokes `/mcp-apps` `tools/call` with null/undefined/empty `sessionToken`. Expected: rejection with code `unauthorized`.
2. **Expired Session Call**: A caller invokes `/mcp-apps` `tools/call` with a token that has passed its TTL. Expected: rejection with code `unauthorized`.
3. **Model-Only Tool Execution**: An iframe app invokes a tool marked with `visibility: ["model"]`. Expected: rejection with code `forbidden`.
4. **Cross-Server Execution**: An iframe app provides a valid session for `serverA` but requests a tool from `serverB` or passes `server: "serverB"`. Expected: rejection with code `forbidden`.
5. **Session Capacity Overflow**: More than 1,000 active sessions are created. Expected: store size remains at 1,000, evicting the least recently accessed sessions.

---

### Task 1: Area 0 - CI Safety Net & TypeScript Verification

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `src/transports/subprocess.ts:1-20`
- Modify: `src/client/index.tsx:35-50`
- Modify: `src/index.ts:1-35`
- Modify: `src/transports/server-pool.ts:120-130`

**Interfaces:**
- Produces: `pnpm typecheck` script that verifies all `src/` and `tests/` files cleanly.

- [ ] **Step 1: Update package.json scripts and engines**

In `package.json`:
Add `"typecheck": "tsc --noEmit"` to `"scripts"`.
Update `"engines"`: `"node": ">=22.0.0"`.

```json
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm typecheck && pnpm test && pnpm build"
  },
  "engines": {
    "node": ">=22.0.0"
  },
```

- [ ] **Step 2: Update tsconfig.json to include tests**

In `tsconfig.json`:
Update `"include": ["src/**/*", "tests/**/*"]` and remove `"tests"` from `"exclude"`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./lib"
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "lib"]
}
```

- [ ] **Step 3: Update .github/workflows/ci.yml with permissions and typecheck step**

In `.github/workflows/ci.yml`:
Add `permissions: { contents: read }` at the root workflow level.
Add step `- name: Type check \n run: pnpm typecheck` prior to running unit tests.

```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read

jobs:
  test:
    name: Test & Build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [ 22.x ]
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Set up Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm typecheck

      - name: Run unit tests
        run: pnpm test

      - name: Build plugin
        run: pnpm build
```

- [ ] **Step 4: Fix scrubbedParentEnv argument error**

In `src/transports/subprocess.ts`:
Line 13 calls `scrubbedParentEnv(process.env)`. `scrubbedParentEnv` expects 0 arguments.
Change to:
```ts
  const safeEnv = {
    ...scrubbedParentEnv(),
    ...expandedEnv,
  }
```

- [ ] **Step 5: Fix Context type augmentation and remove `@ts-expect-error` in src/index.ts**

In `src/index.ts`:
Augment `@deepseek-ai/cordis` module Context interface with `tools: ToolsService` and `connection`:
```ts
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import { AppSessionStore } from './session-store'
import { ServerToolManager, type ToolsService } from './tool-manager'
import { ServerPool } from './transports/server-pool'

export const name = 'mcp-apps'
export const inject = ['tools', 'webServer', 'connection', 'subprocess']
export { Config }

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
    connection: {
      register?: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      rpc: {
        handle: (ctx: Context, path: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>, options?: unknown) => () => void
      }
    }
  }
}
```
Remove `// @ts-expect-error ctx.tools conforms to ToolsService` above `new ServerToolManager(ctx.tools, sessionStore)`.

- [ ] **Step 6: Fix McpAppToolView props type error in src/client/index.tsx**

In `src/client/index.tsx`:
Change `(props: unknown)` in `ctx.slots.register` to cast props or type as `any`:
```tsx
            return ctx.slots.register({
              name: 'tool.call.toolview',
              key: tool.publicName,
            }, (props: any) => (
              <McpAppToolView
                {...props}
                tool={tool}
                connection={connection}
              />
            ))
```

- [ ] **Step 7: Add `@ts-expect-error` on server-pool.ts:125 for PR 2**

In `src/transports/server-pool.ts`:
Line 125 references `t.tool.name`. Per specification, PR 2 addresses this method. Add `@ts-expect-error PR 2 fixes this` above line 125:
```ts
  findServerForTool(toolName: string): string | undefined {
    const snapshot = this.getUiToolsSnapshot()
    // @ts-expect-error PR 2 fixes this
    const foundUi = snapshot.find(t => t.tool.name === toolName || t.publicName === toolName)
    if (foundUi?.serverName) return foundUi.serverName
```

- [ ] **Step 8: Verify typecheck passes and fails on deliberate error**

Run: `pnpm typecheck`
Expected: PASS (0 errors).

Add deliberate error to `src/index.ts` (e.g. `const deliberateError: number = 'abc'`).
Run: `pnpm typecheck`
Expected: FAIL with TS2322.
Revert deliberate error.

- [ ] **Step 9: Commit Task 1**

```bash
git add package.json tsconfig.json .github/workflows/ci.yml src/
git commit -m "ci: add typecheck safety net, configure workflow permissions, and fix tsc errors"
```

---

### Task 2: Area 1 - App-Only Tool Exclusion and Tool Call Session Binding

**Files:**
- Modify: `src/tool-manager.ts`
- Modify: `tests/tool-manager.spec.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/ext-apps/app-bridge` (`isToolVisibilityAppOnly`, `isToolVisibilityModelOnly`).
- Produces: `ServerToolManager` that avoids registering app-only tools with `ctx.tools`, scopes `allowedReverseTools` to `visibility: ["app"]`, and creates sessions bound to tool execution context (`agentId`, `callId`).

- [ ] **Step 1: Write test for app-only tool LLM registration prevention**

In `tests/tool-manager.spec.ts`:
Add a test asserting that tools with `visibility: ['app']` are NOT registered via `toolsService.register`, while UI tools and standard model tools are:
```ts
  it('does not register app-only tools with ctx.tools for the LLM', () => {
    const registeredNames: string[] = []
    const mockToolsService = {
      register: vi.fn((def: any) => {
        registeredNames.push(def.name)
        return vi.fn()
      }),
    }
    const sessionStore = new AppSessionStore()
    const manager = new ServerToolManager(mockToolsService, sessionStore)
    const mockClient = {} as any

    const tools: Tool[] = [
      {
        name: 'app_internal_tool',
        description: 'For app UI only',
        inputSchema: { type: 'object' },
        _meta: { ui: { visibility: ['app'] } },
      },
      {
        name: 'model_and_app_tool',
        description: 'Both can use',
        inputSchema: { type: 'object' },
        _meta: { ui: { visibility: ['model', 'app'] } },
      },
    ]

    manager.syncServerTools('test-server', mockClient, tools, { transport: 'stdio', command: 'test', allowAppToolCalls: true })

    expect(registeredNames).toContain('mcp__test_server__model_and_app_tool')
    expect(registeredNames).not.toContain('mcp__test_server__app_internal_tool')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: FAIL (app-only tool was registered).

- [ ] **Step 3: Implement app-only tool filtering in `syncServerTools`**

In `src/tool-manager.ts`:
Import `isToolVisibilityAppOnly` from `@modelcontextprotocol/ext-apps/app-bridge`.
Inside `syncServerTools(serverName, client, tools, serverConfig)` loop:
```ts
    for (const tool of tools) {
      const publicName = publicToolName(serverName, tool.name)
      const resourceUri = getToolUiResourceUri(tool) ?? (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri

      if (resourceUri) {
        this.uiTools.set(publicName, {
          serverName,
          rawName: tool.name,
          publicName,
          resourceUri,
        })
      } else {
        this.uiTools.delete(publicName)
      }

      // App-only tools must not be registered with the LLM in ctx.tools
      if (isToolVisibilityAppOnly(tool)) {
        continue
      }

      // If tool was already registered, retain its existing disposer unless updated
      const existingDisposer = existingServerDisposers.get(publicName)
      if (existingDisposer) {
        nextServerDisposers.set(publicName, existingDisposer)
        existingServerDisposers.delete(publicName)
        continue
      }
      ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/tool-manager.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify session binding to execution identity**

Ensure `definition.execute(args, exec)` creates the session once per execution call, capturing `exec?.agent?.id` and `exec?.rootCallId ?? exec?.callId`, and passes `_sessionToken` through to `presentationMeta`.
Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/tool-manager.ts tests/tool-manager.spec.ts
git commit -m "feat(security): exclude app-only tools from LLM registration and bind sessions to tool calls"
```

---

### Task 3: Area 1 - Strict Reverse Call Authorization & Bounded Session Store

**Files:**
- Modify: `src/config.ts`
- Modify: `src/session-store.ts`
- Modify: `src/index.ts`
- Create/Modify: `tests/session-store.spec.ts`
- Create/Modify: `tests/rpc-auth.spec.ts`

**Interfaces:**
- Produces: Strict `/mcp-apps` `tools/call` RPC rejection and 1k-bounded LRU session store.

- [ ] **Step 1: Write integration tests for reverse tool call rejection rules**

In `tests/rpc-auth.spec.ts`:
Verify all 5 required test cases:
1. Call with no token is rejected (`unauthorized`).
2. Call with an expired token is rejected (`unauthorized`).
3. Model-only tool is rejected (`forbidden`).
4. Tool on a different server is rejected (`forbidden`).
5. Session store stays within its size cap (evicts LRU).

- [ ] **Step 2: Run tests to verify coverage**

Run: `pnpm vitest run tests/rpc-auth.spec.ts tests/session-store.spec.ts`
Expected: All 15 tests pass.

- [ ] **Step 3: Verify no unauthenticated fallbacks exist in `src/index.ts`**

Inspect lines 55-80 of `src/index.ts`:
Confirm that `params.server` fallback and `findServerForTool` fallback have been completely removed, ensuring every call requires a valid session.

- [ ] **Step 4: Run full verification suite**

Run: `pnpm prepublishOnly`
Expected:
1. `pnpm typecheck` succeeds (0 errors).
2. `vitest run` passes 100% of test suites.
3. `pnpm build` completes with 0 warnings or errors.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/ tests/
git commit -m "feat(security): enforce strict reverse call authorization and bounded session store"
```
