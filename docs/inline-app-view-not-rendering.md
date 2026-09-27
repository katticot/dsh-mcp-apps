# Historical report — inline MCP App view did not mount in DSH

**Subject:** Historical `dsh-mcp-apps@0.2.0` inline app rendering failure (`tool.call.toolview`)
**First investigated:** 2026-09-27
**Status at current HEAD:** The duplicate-React rendering blocker is fixed and covered by the artifact render check. Client discovery now uses the host `/api` RPC, retries after connection generation changes, and polls every five seconds; the exact packed package passed the DSH browser smoke test with a local MCP fixture. Live Powerhive behavior has not been rechecked.
**Evidence boundary:** The old artifact's hook failure was reproduced against host React. That establishes a rendering blocker in that artifact. It does not establish that the React error caused the separately observed plain `GenericToolCard` symptom.

---

## 1. Symptom

The original report observed that calls carrying `_meta.ui.resourceUri` (including `powerhive_dashboard` and `powerhive_map`) returned normally, while the app did not appear and the row looked like a plain card. Server logs showed no corresponding error. This was an observation from the original environment, not a current reproduction. The old client artifact had a confirmed React rendering failure; the available evidence does not show whether that failure specifically caused DSH to display `GenericToolCard`.

---

## 2. Checks reported from the original environment

The following observations were recorded during the original investigation; they have not all been revalidated at current HEAD. Static registration and matching key names support the slot wiring, but cannot prove that the host dispatched or rendered the view at runtime.

| Layer | Evidence |
|---|---|
| Profile | `dsh --profile web --dump-config` composes `mcp-apps-universal → dsh-mcp-apps` with the `powerhive` stdio server |
| Host half | 44 of the upstream server's 46 tools are registered; the 2 app-only tools (`powerhive_live_stats`, `powerhive_map_data`) are correctly withheld from the model |
| Tool metadata | Session store records carry `data.meta.mcpApp = {rawToolName, resourceUri, result, serverName, sessionToken}` for `ui://powerhive/dashboard.html` and `ui://powerhive/map.html` |
| Slot wiring | The plugin registered `{name: 'tool.call.toolview', key: tool.publicName}` and the inspected harness used that slot with tool-name keys — consistent names, but static evidence alone does not prove runtime dispatch or fallback behavior |
| Server | Health endpoint, systemd unit, SigNoz traces/logs all healthy; 0 ERROR logs in 24h |

The original records showed that tool metadata existed, and the inspected slot names and keys had the expected shape. Those observations do not prove runtime dispatch, so the point at which the view failed after metadata discovery remained unresolved.

---

## 3. Root cause

**Confirmed blocker in the historical artifact:** the client bundle shipped its own copy of React 18.3.1 instead of importing the host's React.

Evidence in the built artifact (`lib/client.js`, 329,563 bytes; byte-identical to the copy installed in `~/.dsh/profiles/web/node_modules/dsh-mcp-apps` — md5 `7711848b9f24b0bbe95ff897d4dcdbab`):

```
lib/client.js:1      window.__ModuleLoader__.load({ id: "dsh-mcp-apps", factory: (require) => {
lib/client.js:6083   var import_react = /* @__PURE__ */ __toESM(require_react());
lib/client.js:9002   var f = require_react(), ...
                       f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner
loader-style require("react...") calls: 0
local react shim (require_react):      7
in-bundle marker:                      version = "18.3.1"
```

`require_react()` was a local CJS shim for a *bundled* module, not the loader's `require("react")`. The old bundle vendored React (and zod) and did not request React from the loader. A later review reproduced a `TypeError` from `useState` when that artifact was rendered with host React; a temporary externalized bundle rendered successfully.

### Why it was bundled in the historical build

`tsdown` externalizes exactly the packages in `dependencies` ∪ `peerDependencies`:

```js
// node_modules/tsdown/dist/src-Cy1Bj4rU.mjs:834
function getProductionDeps(pkg) {
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})]);
}
```

At that time, the client build did not list React under `external`, so rolldown inlined it. The current client entry explicitly externalizes `react` and `react/jsx-runtime` (see §6).

### Why that breaks rendering

- The harness renders slot entries with the React instance the module loader provides — its own bundles obtain it the same way (`@deepseek-ai/dsh-client-ui-tool/lib/client.js:1` requires `react/jsx-runtime`).
- `McpAppToolView` calls hooks from the vendored copy (`lib/client.js:9151` for the component; `useState`/`useMemo`/`useRef`/`useEffect` from line 9153).
- Hooks read `ReactCurrentDispatcher` from the copy that defined them. The host renderer installs the dispatcher only on *its* copy, leaving the vendored dispatcher `null`; the reproduced failure was a `TypeError` from `useState`.
- The duplicate dispatcher explains why rendering the registered view failed in the old artifact. The evidence does not establish whether DSH then fell back to `GenericToolCard` or whether another UI path produced the plain-card observation. Treat that symptom's cause as unconfirmed.

React is the one vendored duplicate that cannot work: a second zod copy is harmless (no shared runtime state), a second React copy is not.

---

## 4. Coverage added since the original report

`tests/client-bundle.spec.ts` executes the built browser artifact in a browser-like VM, asserts that it requests `react` and `react/jsx-runtime` from the module loader, and renders the registered tool view using host React and ReactDOM. `pnpm test:artifact` builds before running that spec, so direct invocations cannot validate stale `lib/client.js`. CI, release, and `prepublishOnly` use this script; `prepublishOnly` runs typecheck and unit tests before the artifact build and check.

---

## 5. Why the fix is safe — the host provides React

The web shell hands the module loader a static-module registry (`@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`):

```js
return {
  react: ec, "react/jsx-runtime": ic, "react-dom": cc, "react-dom/client": fc,
  "@deepseek-ai/cordis": Ha,
  "@deepseek-ai/dsh-client-store": Hc,
  "@deepseek-ai/dsh-client-ui-slots": Ac,
  "@deepseek-ai/dsh-client-ui-primitives": Zg,
  "@deepseek-ai/dsh-client-ui-dockkit": Ey,
}
```

passed as `staticModules` into `__ModuleLoader__.create({...})`. Externalizing React resolves to the host instance.

`@deepseek-ai/dsh-client-ui-slots@0.1.5-rc.3` is an installable package and is present in the local development dependencies. Its appearance in the static module registry describes a host loader identifier; it does not mean the npm package is unavailable. The peer dependency is valid for the pinned DSH compatibility candidate.

---

## 6. Fix applied

The client build explicitly externalizes the host React runtime and the client now calls DSH's `/api` RPC endpoints for discovery, tool calls, and resource access. Discovery runs on initial readiness, after connection generation changes, and on a bounded five-second poll to find server additions and removals.

```ts
// tsdown.config.ts, second defineConfig entry (client)
external: ['react', 'react/jsx-runtime'],
```

The artifact render test covers the host-React path, and the DSH compatibility smoke test exercises the exact packed package in a browser with a local MCP fixture. The artifact test builds first in its script, and CI, release, and `prepublishOnly` all use that script.

---

## 7. Acceptance checks

```sh
# after build
grep -c 'require("react'      lib/client.js   # >= 1
grep -c  require_react        lib/client.js   # 0
grep -c '18.3.1'              lib/client.js   # 0
grep -c  ReactCurrentDispatcher lib/client.js # 0
wc -c lib/client.js                            # should be smaller than the historical 329,563-byte bundle
```

Deployment sequence (a rebuilt client module is not picked up by an open tab):

1. rebuild → 2. reinstall into `~/.dsh/profiles/web` → 3. `systemctl --user restart`/`dsh web` restart → 4. hard-reload the page.

**Still outstanding:** a live check with the Powerhive server in its deployment environment. The packaged browser smoke test verifies the DSH workflow using a local fixture; it does not verify Powerhive-specific deployment behavior or its browser console.

---

## 8. Secondary findings

1. **Coverage scope.** The artifact render check verifies that the registered view mounts with host React. The packaged browser smoke test verifies delivery of fixture tool input and result into an iframe. These checks do not cover every branch of `McpAppToolView` or live Powerhive behavior.
2. **Vendored MCP SDK + zod is intentional and fine.** `noExternal: [/@modelcontextprotocol\/.*/, /zod/]` keeps genuine dependencies in the bundle; only host-provided runtimes must be externalized. Worth stating explicitly in the build config so the next edit doesn't generalize the wrong way.
3. **`dsh.client.inject` vs. runtime `inject` are different mechanisms.** `package.json#dsh.client.inject` names browser module dependencies. The client module exports `inject = ["connection", "slots"]`, which names context services provided at runtime. Both are correct; the distinction is easy to misread when debugging.
4. **The client uses the host module loader wrapper.** The current `banner`/`footer` wrap the CJS output in a `window.__ModuleLoader__.load` factory. The bundle has no Node-global fallback; the artifact test rejects access to `window.process` and verifies dependencies resolve through the loader.

---

## 9. Evidence index

Historical artifact evidence (these paths, line numbers, and hash refer to the pre-fix installed bundle):

| Claim | Historical reference |
|---|---|
| Installed copy matched the local pre-fix build | md5 `7711848b9f24b0bbe95ff897d4dcdbab` |
| Bundle vendored React | Old `lib/client.js`: `require_react` shim and React `18.3.1` marker; old references at lines 6083, 9002, 9151, and 9153 |
| Host React came from the module loader | Historical `@deepseek-ai/dsh-client-ui-tool` browser bundle entry |
| Host's static registry included React and the slots identifier | Historical `@deepseek-ai/dsh-web-frontend` browser bundle (`staticModules`) |

Current source and regression coverage:

| Claim | Stable reference |
|---|---|
| Plugin registers keyed tool views and injects context services | `src/client/index.tsx`, `apply` |
| View calls use host `/api` RPC | `src/client/McpAppToolView.tsx`, `createBridgeLifecycle` |
| Discovery runs on readiness, reconnect, and five-second polling | `src/client/index.tsx`, `DISCOVERY_INTERVAL_MS` and `connection.generation.subscribe` |
| Client build externalizes host React | `tsdown.config.ts`, client entry `external` |
| Artifact test renders with host React and checks loader dependencies | `tests/client-bundle.spec.ts` |
| Artifact test builds before reading `lib` output | `package.json`, `test:artifact` script |
| DSH compatibility evidence for exact packed artifact | `docs/dsh-compatibility.md` and `scripts/smoke-dsh.mjs` |
