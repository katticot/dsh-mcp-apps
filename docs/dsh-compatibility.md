# DSH compatibility baseline

## Candidate release

The compatibility candidate for this plugin is DSH `0.1.7-rc.2` with Cordis `~4.0.4`, matching the peer contract declared by `@deepseek-ai/dsh-app-boot@0.1.7-rc.2` (the package that ships DSH's compatibility checker) and the other `@deepseek-ai/dsh-*` service packages this plugin depends on. All of `dsh-agent`, `dsh-client-connection`, `dsh-client-ui-slots`, `dsh-client-ui-tool`, `dsh-subprocess`, and `dsh-user-approval` publish `0.1.7-rc.2` under npm's `next` dist-tag, alongside `@deepseek-ai/dsh` itself.

DSH's own compatibility check lives in `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility` (`lib/index.js`, exported from the package root): it reads a plugin's `peerDependencies`, keeps only the keys named `@deepseek-ai/dsh` or prefixed `@deepseek-ai/dsh-`, and rejects a peer unless `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`. `peerDependenciesMeta`'s `optional` flag is not consulted by this function, so optional peers are checked exactly like required ones. The `dsh` field in `package.json` (used elsewhere for client injection) plays no role in this check. `workspace:^`, `workspace:~`, and `workspace:*` are special-cased to mean "this exact runtime version"; anything else is an ordinary semver range evaluated with prereleases included.

Because of `includePrerelease: true`, a caret range such as `^0.1.7-rc.2` is satisfied by any `0.1.7-rc.2 <= version < 0.2.0`, prereleases included — this plugin's peers use exactly that form (see below) instead of pinning an exact version, so the next `0.1.7-rc.N` or a `0.1.8` no longer requires a plugin release. An *exact* version string (no range operator, e.g. a bare `0.1.7-rc.2`) is instead treated by `semver.satisfies` as "equal to that version only," which is why a prior baseline pinned to `0.1.5-rc.3` failed outright against `0.1.7-rc.2` — it wasn't a range at all.

Cordis is not part of this check (`@deepseek-ai/cordis` does not start with `@deepseek-ai/dsh-`), but DSH `0.1.7-rc.2` itself depends on `@deepseek-ai/cordis: ~4.0.4`, so the development dependency here is pinned to the exact `4.0.4` the runtime ships, while the peer range (`^4.0.2`) stays permissive since it is not gated by the DSH checker.

The exact packed `dsh-mcp-apps@0.2.0` artifact was previously installed into a temporary DSH web profile and exercised with a local stdio MCP fixture in a headless browser against the `0.1.5-rc.3` baseline (see the Task 6 report for that run). The `0.2.2` candidate carries the same packaged-runtime smoke test (`scripts/smoke-dsh.mjs`, `pnpm test:smoke`) forward, now pointed at `@deepseek-ai/dsh@0.1.7-rc.2`. Other DSH/Cordis releases remain unverified.

## Host services and public types

These Cordis services are host-side dependencies declared by `src/index.ts`'s `inject`. Their names are service keys; they are not browser module-loader identifiers.

| Service key | Provider package | Public contract used by this plugin | Status |
| --- | --- | --- | --- |
| `tools` | DSH host tool registry | Host-provided service; this plugin uses the existing structural `ToolsService` contract in `src/tool-manager.ts` | Host service required |
| `connection` | `@deepseek-ai/dsh-client-connection` | `HostConnectionService` exposes `fetch.register` for the `/api/mcp-apps/<endpoint>` host routes; the browser uses `rpc.call('/api', 'mcp-apps/<endpoint>', payload)` | Required peer; provider package `0.1.7-rc.2` |
| `subprocess` | `@deepseek-ai/dsh-subprocess` | `SubprocessRuntime`, including `scrubbedParentEnv()` used by the stdio transport | Required peer; provider package `0.1.7-rc.2` |
| `agents` | `@deepseek-ai/dsh-agent` | `AgentRegistry`, `Agent`, and `ctx.agents.get(id)` | Optional peer; provider package `0.1.7-rc.2` |
| `approval` | `@deepseek-ai/dsh-user-approval` | `ApprovalService.request(req)` and `ApprovalOutcome` | Optional peer; provider package `0.1.7-rc.2` |

`agents` and `approval` are only needed for reverse tool calls configured with `allowAppToolCalls: approve`. If those services are unavailable, the request fails closed. Cordis itself is pinned in devDependencies to `4.0.4`, the exact peer declared by `@deepseek-ai/dsh-app-boot@0.1.7-rc.2` and depended on by `@deepseek-ai/dsh@0.1.7-rc.2` directly.

**`webServer` is deliberately not injected.** `src/index.ts` registers its host routes through `ctx.connection.fetch.register(route)` (`HostConnectionFetch`), which `@deepseek-ai/dsh-client-connection`'s `registerFetchRoute` stores in an in-memory route map with no reference to `ctx.webServer` — only the separate `ctx.connection.rpc.handle` path (`HostConnectionService#register`) touches `owner.webServer.register(...)`, and this plugin does not use `rpc.handle`. In Cordis 4.x every entry in a plugin's `inject` array is a hard requirement (there is no optional-vs-required split at that level), so listing `webServer` there would keep this plugin's fiber `PENDING` forever on a headless DSH host that never provides a web server — meaning none of its host-side MCP tools would register, even though nothing here needs a browser. `tests/dsh-host-contract.spec.ts`'s "registers tools on a headless host that never provides webServer" test is a regression guard for this.

`@deepseek-ai/dsh-client-ui-slots` supplies the browser slot registry contract used by the DSH tool UI provider. Its published package has no Cordis host `inject` declaration; the UI tool package depends on it and supplies the `slots` client context service.

## Browser module-loader identifiers

`package.json#dsh.client.inject` contains package module identifiers loaded into the browser's `window.__ModuleLoader__`; these are distinct from Cordis service keys above. `src/client/index.tsx` receives the `connection` and `slots` context services from DSH's client plugin composition.

| Module-loader identifier | Published package / entry | Role |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-connection` | `@deepseek-ai/dsh-client-connection` client entry, `0.1.7-rc.2` | Provides browser connection RPC used by the client plugin |
| `@deepseek-ai/dsh-client-ui-tool` | `@deepseek-ai/dsh-client-ui-tool` client entry, `0.1.7-rc.2` | Provides tool-call UI and the `slots` context used to register `tool.call.toolview` |

The UI tool package's published client entry injects its own connection, locale, conversation, and workspace-controller dependencies. The slots registry is a dependency of that package. React is supplied by the host's module loader: its published browser bundle requests `react` and `react/jsx-runtime` through the loader-provided `require`. The `test:artifact` check verifies this plugin requests those two external IDs, executes with `window.process` access rejected, and renders its registered view through the host React runtime. The packaged DSH smoke test additionally installs the exact tarball, starts the web profile, and runs the MCP app workflow in a browser. CI and the release workflow run this smoke test against the tarball they validate; the release workflow publishes that same tarball without rebuilding it.

## Version constraints

The `@deepseek-ai/dsh-*` peers are semver ranges of the form `^0.1.7-rc.2` (i.e. `>=0.1.7-rc.2 <0.2.0`, prereleases included), chosen to satisfy DSH's own `evaluatePluginCompatibility` checker (see above) for `0.1.7-rc.2` and any later `0.1.x` release, rather than exact-pinning a single runtime build. The corresponding devDependencies are exact-pinned to `0.1.7-rc.2` so CI builds and tests against the same runtime version the peer range is validated against. `@deepseek-ai/cordis` is pinned in devDependencies to the exact `4.0.4` DSH `0.1.7-rc.2` ships, with a permissive `^4.0.2` peer range (cordis is not covered by the DSH compatibility checker). The MCP SDK, ext-apps, schemastery, and zod are ordinary runtime dependencies because the host bundle imports them directly. `@deepseek-ai/dsh-subprocess` is a required peer because the host uses its runtime helper; the service provider remains host-owned.
