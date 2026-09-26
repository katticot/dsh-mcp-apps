# Area 5: Packaging, Dependencies, and Release Implementation Plan (PR 5 + Area 6 Folded In)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up package exports and dependency declarations, inject build-time version strings, harden GitHub Actions release workflow with trusted publishing and commit SHA pinning, eliminate dead code, harden configuration schema/variable expansion, update documentation, and verify clean typechecking in an isolated consumer project against the packed tarball.

**Architecture:**
- **Package & Exports:** Drop `./client` type declarations in `package.json` and disable DTS generation for the client bundle in `tsdown.config.ts`; document `./client` as an internal bundle intended solely for DSH module loader (`window.__ModuleLoader__.load`). Update `package.json` `"files"` to include source maps (`lib/**/*.map`) and remove `.npmignore`.
- **Dependencies:** Relocate `react` from runtime dependencies to `peerDependencies` (marked optional) and `devDependencies`. Add `zod` to `peerDependencies` (`^3.25 || ^4.0`). Resolve Cordis peer mismatch by updating `@deepseek-ai/cordis` peer requirement to `^4.0.4`. Remove unused `@deepseek-ai/dsh-tools` peer dependency. Add `packageManager` field.
- **Build-Time Version Injection:** Use `tsdown`'s `define` option to inject `__PACKAGE_VERSION__` from `package.json` into both host ESM and client CJS bundles, replacing hardcoded `'0.1.0'` strings in `src/transports/server-pool.ts` and `src/client/McpAppToolView.tsx`.
- **Dead Code Cleanup:** Remove unused `src/client/transport.ts` (`MessagePortTransport`) and strip unused imports across the source tree.
- **Config & Schema Hardening (Area 6):** Ensure `Schema.dict` rejects null server configurations (`servers: { a: null }`), validate URL syntax for remote transports, clamp timeouts to non-negative numbers (`min(0)`), support `${VAR:-${FALLBACK:-default}}` nested defaults and `$$` dollar-escapes, and expand variables across `url`, `args`, and `cwd` in subprocess and remote transports.
- **Release Workflow:** Upgrade `.github/workflows/release.yml` to pin action steps to commit SHAs, declare minimal permissions (`contents: read`, `id-token: write`), verify that the trigger tag is on `main` and matches `package.json` version, publish via npm trusted publishing with `--provenance` in a protected `release` environment, and streamline `prepublishOnly` scripts to eliminate redundant test runs.
- **Documentation (Area 6):** Update `README.md` to correct outdated claims regarding RFC 3986, 10Hz throttling, synchronous event hooking, and searchable-hidden disclosure; document websocket transport, reverse tool call policies (`allowAppToolCalls`), and tool visibility filtering; replace the hardcoded test count badge.

**Tech Stack:** TypeScript 5.8+, Node.js 22+, `tsdown` (Rolldown), `@deepseek-ai/schemastery`, GitHub Actions, Vitest 3.2+, pnpm 11+.

**Spec:** Area 5 (Packaging, dependencies and release) and Area 6 (Config and docs).

## Global Constraints

- `./client` export must not expose a `types` declaration and must be documented as DSH module loader only.
- `package.json` must not declare `react` in runtime `dependencies` or `@deepseek-ai/dsh-tools` in `peerDependencies`.
- `package.json` must declare `"packageManager": "pnpm@11.22.0"`.
- `.npmignore` must be deleted; tarball contents must be governed exclusively by `files` in `package.json`.
- Source maps must be shipped in the distributed package (`lib/**/*.map`).
- Zero hardcoded version strings in runtime server/client instantiations.
- GitHub Actions release workflow must use commit SHAs for actions and enforce `permissions: { contents: read, id-token: write }`.
- Tarball must be verified end-to-end against a clean synthetic consumer project.

## Review Focus

1. **Consumer Typecheck Failure**: A consumer project imports `dsh-mcp-apps` from the packed tarball. Expected: clean typechecking without missing DTS or missing peer warnings for backend plugins.
2. **Node Import of `./client`**: A Node environment attempts to import `dsh-mcp-apps/client`. Expected: `./client` is not typed for Node and docs explicitly warn against direct Node imports.
3. **Release Tag Mismatch**: A tag `v0.2.0` is pushed while `package.json` version is `0.1.0`, or tag is pushed from a non-main commit. Expected: release workflow fails early with explicit error.
4. **Invalid Schema Inputs**: A config payload contains `servers: { test: null }`, negative timeouts (`toolCallTimeoutMs: -5`), or malformed URLs (`url: "not-a-url"`). Expected: Schemastery throws validation error.
5. **Nested & Escaped Variable Interpolation**: Expression contains `$$100` and `${UNSET:-${FALLBACK:-default}}`. Expected: evaluates to `$100` and `default`.

---

### Task 1: Config Schema Hardening & Variable Expansion (Area 6)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/transports/subprocess.ts`
- Modify: `src/transports/remote.ts`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Produces: `expandEnvString` with support for `$$` escape and nested defaults `${A:-${B:-fallback}}`.
- Produces: `Config` schema rejecting `null` server definitions, negative `toolCallTimeoutMs`/`defaultTimeoutMs`, and invalid URLs.
- Consumes: `expandEnvString` in `subprocess.ts` (for `args` and `cwd`) and `remote.ts` (for `url`).

- [ ] **Step 1: Add tests for schema rejections and nested/escaped env expansions**

In `tests/config.spec.ts`:
```ts
  it('rejects servers map with null values', () => {
    expect(() => Config({
      servers: {
        broken: null,
      },
    } as any)).toThrow()
  })

  it('rejects negative timeout values', () => {
    expect(() => Config({
      defaultTimeoutMs: -1,
      servers: {},
    } as any)).toThrow()

    expect(() => Config({
      servers: {
        srv: {
          transport: 'stdio',
          command: 'node',
          toolCallTimeoutMs: -1000,
        },
      },
    } as any)).toThrow()
  })

  it('rejects invalid remote URLs', () => {
    expect(() => Config({
      servers: {
        invalidUrl: {
          transport: 'sse',
          url: 'not-a-valid-url',
        },
      },
    } as any)).toThrow()
  })

  it('supports $$ escaping and nested default expressions in expandEnvString', () => {
    const env = {
      SET_VAR: 'hello',
      EMPTY_VAR: '',
    }

    expect(expandEnvString('price is $$50 and $${SET_VAR}', env)).toBe('price is $50 and ${SET_VAR}')
    expect(expandEnvString('${UNSET:-${SET_VAR}}', env)).toBe('hello')
    expect(expandEnvString('${UNSET:-${EMPTY_VAR:-fallback}}', env)).toBe('fallback')
    expect(expandEnvString('${EMPTY_VAR:-${UNSET:-$$nested}}', env)).toBe('$nested')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: FAIL (missing validation and nested/escape expansion support).

- [ ] **Step 3: Implement schema validation and tokenizer-based `expandEnvString`**

In `src/config.ts`:
Update `StdioSchema`, `RemoteSchema`, `IpcSchema`, and `Config`:
```ts
const VALID_URL_REGEX = /^(https?|wss?):\/\/[^\s/$.?#].[^\s]*$/i

const StdioSchema: Schema<StdioServerConfig> = Schema.object({
  transport: Schema.const('stdio').default('stdio'),
  command: Schema.string().required(),
  args: Schema.array(String).default([]),
  env: Schema.dict(String).default({}),
  cwd: Schema.string(),
  toolCallTimeoutMs: Schema.number().min(0).default(30000),
  allowAppToolCalls: AppToolCallsSchema,
})

const RemoteSchema: Schema<RemoteServerConfig> = Schema.object({
  transport: Schema.union([
    Schema.const('sse'),
    Schema.const('streamable-http'),
    Schema.const('websocket'),
  ]).required(),
  url: Schema.string().pattern(VALID_URL_REGEX).required(),
  headers: Schema.dict(String).default({}),
  toolCallTimeoutMs: Schema.number().min(0).default(30000),
  reconnectOptions: ReconnectSchema.default({}),
  allowAppToolCalls: AppToolCallsSchema,
})

const IpcSchema: Schema<IpcServerConfig> = Schema.object({
  transport: Schema.const('ipc').required(),
  socketPath: Schema.string().required(),
  toolCallTimeoutMs: Schema.number().min(0).default(30000),
  allowAppToolCalls: AppToolCallsSchema,
})

const ServerDefinitionSchema = Schema.union([StdioSchema, RemoteSchema, IpcSchema]).required()

export const Config: Schema<Config> = Schema.object({
  servers: Schema.dict(ServerDefinitionSchema, ServerNameSchema).default({}),
  defaultTimeoutMs: Schema.number().min(0).default(30000),
})
```

Implement nested defaults and `$$` escaping in `expandEnvString`:
```ts
export function expandEnvString(
  value: string,
  env: Record<string, string | undefined> = process.env,
  allowedVars?: Set<string>
): string {
  let result = ''
  let i = 0
  while (i < value.length) {
    if (value[i] === '$' && value[i + 1] === '$') {
      result += '$'
      i += 2
      continue
    }
    if (value[i] === '$' && value[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      let colonDashIdx = -1
      while (j < value.length && depth > 0) {
        if (value[j] === '$' && value[j + 1] === '{') {
          depth++
          j += 2
          continue
        }
        if (value[j] === '}') {
          depth--
          if (depth === 0) break
          j++
          continue
        }
        if (depth === 1 && value[j] === ':' && value[j + 1] === '-' && colonDashIdx === -1) {
          colonDashIdx = j
          j += 2
          continue
        }
        j++
      }

      if (depth === 0) {
        const varName = colonDashIdx !== -1 ? value.slice(i + 2, colonDashIdx) : value.slice(i + 2, j)
        const defaultPart = colonDashIdx !== -1 ? value.slice(colonDashIdx + 2, j) : undefined

        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
          const isBlocked = (varName.startsWith(DSH_ENV_PREFIX) || SENSITIVE_ENV_PATTERN.test(varName)) && !allowedVars?.has(varName)
          const val = env[varName]
          if (!isBlocked && val !== undefined && val !== '') {
            result += val
          } else if (defaultPart !== undefined) {
            result += expandEnvString(defaultPart, env, allowedVars)
          }
          i = j + 1
          continue
        }
      }
    }
    result += value[i]
    i++
  }
  return result
}
```

In `src/transports/subprocess.ts`:
Expand `args` and `cwd`:
```ts
  const expandedArgs = (config.args ?? []).map(arg => expandEnvString(arg))
  const expandedCwd = config.cwd ? expandEnvString(config.cwd) : undefined
```

In `src/transports/remote.ts`:
Expand `url`:
```ts
  const expandedUrl = expandEnvString(config.url)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/transports/subprocess.ts src/transports/remote.ts tests/config.spec.ts
git commit -m "feat(config): harden schema validation and support nested and escaped env expansion"
```

---

### Task 2: Build-Time Version Injection & Dead Code Removal (Area 5 Items 3 & 6)

**Files:**
- Create: `src/version.ts`
- Modify: `tsdown.config.ts`
- Modify: `src/transports/server-pool.ts:75-85`
- Modify: `src/client/McpAppToolView.tsx:180-190`
- Delete: `src/client/transport.ts`
- Test: `tests/version.spec.ts`

**Interfaces:**
- Produces: `PACKAGE_VERSION` constant exported from `src/version.ts` replaced at build time with package version via `define`.
- Removes: `src/client/transport.ts` (`MessagePortTransport`).

- [ ] **Step 1: Write test for version exposure**

In `tests/version.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { PACKAGE_VERSION } from '../src/version'
import pkg from '../package.json'

describe('Version configuration', () => {
  it('exposes the current package version', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})
```

- [ ] **Step 2: Create `src/version.ts`**

In `src/version.ts`:
```ts
declare const __PACKAGE_VERSION__: string | undefined

export const PACKAGE_VERSION: string =
  typeof __PACKAGE_VERSION__ !== 'undefined'
    ? __PACKAGE_VERSION__
    : '0.1.0'
```

- [ ] **Step 3: Update `tsdown.config.ts` to define `__PACKAGE_VERSION__`**

In `tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'
import pkg from './package.json'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: true,
    outDir: 'lib',
    clean: true,
    define: {
      __PACKAGE_VERSION__: JSON.stringify(pkg.version),
    },
  },
  {
    entry: {
      client: 'src/client/index.tsx',
    },
    format: ['cjs'],
    target: 'es2022',
    dts: false,
    outDir: 'lib',
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
    },
    noExternal: [/@modelcontextprotocol\/.*/, /zod/],
    define: {
      __PACKAGE_VERSION__: JSON.stringify(pkg.version),
    },
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mcp-apps", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
```

- [ ] **Step 4: Use `PACKAGE_VERSION` in `server-pool.ts` and `McpAppToolView.tsx`**

In `src/transports/server-pool.ts`:
```ts
import { PACKAGE_VERSION } from '../version'

// In startServer:
    const client = new Client({
      name: 'dsh-mcp-apps',
      version: PACKAGE_VERSION,
    }, {
```

In `src/client/McpAppToolView.tsx`:
```ts
import { PACKAGE_VERSION } from '../version'

// In bridge initialization:
      bridge = new AppBridge(null, {
        name: 'DeepSeek Harness',
        version: PACKAGE_VERSION,
      }, {
```

- [ ] **Step 5: Delete `src/client/transport.ts` and clean up unused imports**

Run: `rm src/client/transport.ts`
Check for unused imports across `src/` and remove them.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run tests/version.spec.ts`
Run: `pnpm build`
Check `lib/index.js` and `lib/client.js` to verify `'0.1.0'` is substituted where `__PACKAGE_VERSION__` was used.

- [ ] **Step 7: Commit**

```bash
git add src/version.ts tsdown.config.ts src/transports/server-pool.ts src/client/McpAppToolView.tsx tests/version.spec.ts
git rm src/client/transport.ts
git commit -m "feat(build): inject package version at build time and remove dead MessagePortTransport"
```

---

### Task 3: Package Housekeeping & Dependency Alignment (Area 5 Items 1, 2 & 5)

**Files:**
- Modify: `package.json`
- Delete: `.npmignore`
- Modify: `tsdown.config.ts`

**Interfaces:**
- Produces: Correct `package.json` exports: `./` with types and ESM, `./client` with only default CJS, no client DTS.
- Produces: Proper peerDependencies (`react` optional peer, `zod` peer, `@deepseek-ai/cordis` ^4.0.4, removed `@deepseek-ai/dsh-tools`).
- Produces: `packageManager: pnpm@11.22.0`.
- Produces: Inclusion of source maps in `files`.

- [ ] **Step 1: Update `package.json`**

In `package.json`:
1. Add `"packageManager": "pnpm@11.22.0"`.
2. Update `"exports"`:
```json
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
```
3. Update `"files"` to include source maps and exclude non-existent files:
```json
  "files": [
    "lib/index.js",
    "lib/index.js.map",
    "lib/index.d.ts",
    "lib/index.d.ts.map",
    "lib/client.js",
    "lib/client.js.map",
    "README.md",
    "LICENSE"
  ],
```
4. Update `"scripts"` to streamline `prepublishOnly`:
```json
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm build"
  },
```
5. Move `react` from `dependencies` to `peerDependencies` (with optional metadata) and `devDependencies`.
6. Add `"zod": "^3.25 || ^4.0"` to `peerDependencies` and `"zod": "^3.24.2"` to `devDependencies`.
7. Update `@deepseek-ai/cordis` in `peerDependencies` from `^4.0.2` to `^4.0.4`.
8. Remove `@deepseek-ai/dsh-tools` from `peerDependencies`.
9. Ensure `peerDependenciesMeta` declares `react`, `@deepseek-ai/dsh-agent`, and `@deepseek-ai/dsh-user-approval` as optional.

- [ ] **Step 2: Delete `.npmignore`**

Run: `rm .npmignore`

- [ ] **Step 3: Update `tsdown.config.ts` for source maps and client DTS**

In `tsdown.config.ts`:
Ensure `sourcemap: true` is configured for both builds (or default verified) and `dts: false` for client:
```ts
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    outDir: 'lib',
    clean: true,
    define: {
      __PACKAGE_VERSION__: JSON.stringify(pkg.version),
    },
  },
  {
    entry: {
      client: 'src/client/index.tsx',
    },
    format: ['cjs'],
    target: 'es2022',
    dts: false,
    sourcemap: true,
    outDir: 'lib',
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
    },
    noExternal: [/@modelcontextprotocol\/.*/, /zod/],
    define: {
      __PACKAGE_VERSION__: JSON.stringify(pkg.version),
    },
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mcp-apps", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
```

- [ ] **Step 4: Run `pnpm install` and verify build**

Run: `pnpm install`
Run: `pnpm build`
Run: `pnpm pack --dry-run`
Verify output matches:
- `lib/index.js`
- `lib/index.js.map`
- `lib/index.d.ts`
- `lib/index.d.ts.map`
- `lib/client.js`
- `lib/client.js.map`
- `README.md`
- `LICENSE`
- `package.json`

- [ ] **Step 5: Commit**

```bash
git add package.json tsdown.config.ts pnpm-lock.yaml
git rm .npmignore
git commit -m "chore(pkg): align dependencies, drop client types, ship sourcemaps, and add packageManager"
```

---

### Task 4: Hardened GitHub Actions Release Workflow (Area 5 Item 4)

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: Tag-on-main verification, version check against `package.json`, pinned commit SHAs, `permissions: { contents: read, id-token: write }`, protected release environment, trusted publishing with `--provenance`.

- [ ] **Step 1: Update `.github/workflows/release.yml`**

Replace `.github/workflows/release.yml` with:
```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: Publish to NPM
    runs-on: ubuntu-latest
    environment:
      name: release
      url: https://www.npmjs.com/package/dsh-mcp-apps
    steps:
      - name: Checkout repository
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0

      - name: Verify tag is on main branch
        run: |
          git fetch origin main:refs/remotes/origin/main
          if ! git merge-base --is-ancestor HEAD origin/main; then
            echo "Error: Release tag is not an ancestor of origin/main branch"
            exit 1
          fi

      - name: Verify tag matches package version
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "Error: Tag version ($TAG_VERSION) does not match package.json version ($PKG_VERSION)"
            exit 1
          fi

      - name: Install pnpm
        uses: pnpm/action-setup@a3252b78c470c02df07e9d792dbb4e397187da6b # v3.0.0
        with:
          version: 11

      - name: Set up Node.js 22
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5a1 # v4.1.0
        with:
          node-version: 22
          registry-url: 'https://registry.npmjs.org'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck and test
        run: |
          pnpm typecheck
          pnpm test

      - name: Publish to NPM with provenance
        run: pnpm publish --provenance --access public --no-git-checks
```

- [ ] **Step 2: Validate yaml syntax**

Run: `node -e "const fs = require('fs'); const yaml = fs.readFileSync('.github/workflows/release.yml', 'utf8'); console.log('YAML length:', yaml.length);"`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): pin action SHAs, verify tag on main, enforce permissions, and use trusted provenance publishing"
```

---

### Task 5: Documentation Corrections & Updates (Area 6 README & Client Module Loader Docs)

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: Accurate documentation for CSP, sliding-window resize throttling, client module loader contract, websocket transport, and reverse tool policies. Replaces hardcoded test badge with CI status badge.

- [ ] **Step 1: Update README.md sections**

Update `README.md`:
1. **Badges:** Replace hardcoded `Tests-17%20passed` with GitHub Actions CI workflow badge:
   `[![CI](https://github.com/katticot/dsh-mcp-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/katticot/dsh-mcp-apps/actions/workflows/ci.yml)`
2. **CSP Section:** Fix RFC 3986 claim: clarify that CSP synthesis parses resource metadata, blocks private IP subnets (RFC 1918) and loopback addresses, strips HTML comment sequences, and injects `<meta>` at the top of `<head>` via `DOMParser`.
3. **Transport & Hooking:** Correct claims about "hooks window events synchronously"; describe `ResilientPostMessageTransport`'s layout-effect listener attachment and FIFO message buffer.
4. **Resize & Throttle:** Replace "10Hz throttle" / "30-event burst circuit breaker" with accurate sliding-window rate limit with deferred pending height flush.
5. **Auto-Reveal / Accordion:** Clarify that ancestor traversal is strictly confined to the component's enclosing hierarchy to prevent unintended clicks across other chat turns.
6. **New Transports & Authorization:** Document `websocket` transport (`wss://`) and `allowAppToolCalls` policy (`deny`, `approve`, `allow`, or boolean) and tool visibility filtering (`app` vs `model`).
7. **Client Export Documentation:** Add a dedicated section explaining that `dsh-mcp-apps/client` is packaged exclusively for the DSH client module loader (`window.__ModuleLoader__.load`) and must not be imported in Node or standard bundling pipelines.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: correct CSP/throttle descriptions, document websocket/client loader, and update CI badge"
```

---

### Task 6: Pack Verification & Synthetic Consumer Typecheck (Definition of Done)

**Files:**
- Test / Verify: `package.json`, `lib/*`, synthetic consumer project in scratch/tmp.

**Interfaces:**
- Produces: Successful `pnpm pack` tarball, clean `tsc --noEmit` in a fresh consumer project importing `dsh-mcp-apps`.

- [ ] **Step 1: Build and pack tarball**

Run: `pnpm build`
Run: `pnpm pack`
Expected: Produces `dsh-mcp-apps-0.1.0.tgz`.

- [ ] **Step 2: Verify tarball contents match exports**

Run: `tar -tf dsh-mcp-apps-0.1.0.tgz`
Verify that `package/lib/index.js`, `package/lib/index.d.ts`, `package/lib/index.js.map`, `package/lib/client.js`, and `package/lib/client.js.map` are present, and that `package/lib/client.d.ts` is absent.

- [ ] **Step 3: Setup synthetic consumer project in temporary directory**

Create a temporary project to verify consumer typechecking:
```bash
CONSUMER_DIR=$(mktemp -d)
cd "$CONSUMER_DIR"
cat << 'EOF' > package.json
{
  "name": "consumer-test",
  "private": true,
  "type": "module",
  "dependencies": {
    "dsh-mcp-apps": "file:/Users/keita/Developer/work/dsh-mcp-apps/dsh-mcp-apps-0.1.0.tgz"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "typescript": "^5.8.0"
  }
}
EOF

cat << 'EOF' > tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": false
  }
}
EOF

cat << 'EOF' > index.ts
import { apply, Config, name, inject } from 'dsh-mcp-apps'
import type { Context } from '@deepseek-ai/cordis'

console.log(name, inject)
EOF

pnpm install --no-lockfile
pnpm exec tsc --noEmit
cd /Users/keita/Developer/work/dsh-mcp-apps
rm -rf "$CONSUMER_DIR" dsh-mcp-apps-0.1.0.tgz
```
Expected: `pnpm exec tsc --noEmit` exits with 0 and zero type errors.

- [ ] **Step 4: Final verification of repository status**

Run: `pnpm typecheck`
Run: `pnpm test`
Expected: All suites PASS cleanly.
