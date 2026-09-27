# DSH compatibility baseline

## Candidate release

The compatibility candidate for this plugin is DSH `0.1.5-rc.3` with Cordis `4.0.2`, matching the published peer contract of the DSH service packages used here. The source release is tagged [`dsh-v0.1.5-rc.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.3), commit `a4c74a91e06b00fe0b0937bde982170c526cc842`. The package tarballs are published on npm at the exact versions recorded in `package.json` and `pnpm-lock.yaml`.

This is a pinned compatibility candidate, not a claim that every supported DSH deployment has been runtime-tested. Source tests and typechecking cover the repository contract; installation and app rendering from a packed plugin remain a separate runtime smoke test.

## Host services and public types

These Cordis services are host-side dependencies declared by `src/index.ts`'s `inject`. Their names are service keys; they are not browser module-loader identifiers.

| Service key | Provider package | Public contract used by this plugin | Status |
| --- | --- | --- | --- |
| `tools` | DSH host tool registry | Host-provided service; this plugin uses the existing structural `ToolsService` contract in `src/tool-manager.ts` | Host service required |
| `connection` | `@deepseek-ai/dsh-client-connection` | `HostConnectionService` exposes `rpc: HostConnectionRpc`; the public RPC registration method is `rpc.handle(channel, handler)` | Required peer; provider package `0.1.5-rc.3` |
| `webServer` | DSH web host | Web server service consumed internally by the connection provider for browser transport setup | Required peer service; keep injected |
| `subprocess` | `@deepseek-ai/dsh-subprocess` | `SubprocessRuntime`, including `scrubbedParentEnv()` used by the stdio transport | Required peer; provider package `0.1.5-rc.3` |
| `agents` | `@deepseek-ai/dsh-agent` | `AgentRegistry`, `Agent`, and `ctx.agents.get(id)` | Optional peer; provider package `0.1.5-rc.3` |
| `approval` | `@deepseek-ai/dsh-user-approval` | `ApprovalService.request(req)` and `ApprovalOutcome` | Optional peer; provider package `0.1.5-rc.3` |

`agents` and `approval` are only needed for reverse tool calls configured with `allowAppToolCalls: approve`. If those services are unavailable, the request fails closed. Cordis itself is pinned to `4.0.2`, as that exact peer is declared by the published DSH service packages.

`@deepseek-ai/dsh-client-ui-slots` supplies the browser slot registry contract used by the DSH tool UI provider. Its published package has no Cordis host `inject` declaration; the UI tool package depends on it and supplies the `slots` client context service.

## Browser module-loader identifiers

`package.json#dsh.client.inject` contains package module identifiers loaded into the browser's `window.__ModuleLoader__`; these are distinct from Cordis service keys above. `src/client/index.tsx` receives the `connection` and `slots` context services from DSH's client plugin composition.

| Module-loader identifier | Published package / entry | Role |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-connection` | `@deepseek-ai/dsh-client-connection` client entry, `0.1.5-rc.3` | Provides browser connection RPC used by the client plugin |
| `@deepseek-ai/dsh-client-ui-tool` | `@deepseek-ai/dsh-client-ui-tool` client entry, `0.1.5-rc.3` | Provides tool-call UI and the `slots` context used to register `tool.call.toolview` |

The UI tool package's published client entry injects its own connection, locale, conversation, and workspace-controller dependencies. The slots registry is a dependency of that package. React is supplied by the host's module loader: its published browser bundle requests `react` and `react/jsx-runtime` through the loader-provided `require`. The `test:artifact` check verifies this plugin requests those two external IDs, executes with `window.process` access rejected, and renders its registered view through the host React runtime. It also verifies the built public exports and client chunks appear in the npm package dry run. This artifact check does not replace installing the package in a full DSH runtime.

## Version constraints

The DSH and Cordis peers and corresponding development dependencies are exact-pinned to this candidate. This avoids presenting a broad semver range as tested compatibility. The MCP SDK, ext-apps, schemastery, and zod are ordinary runtime dependencies because the host bundle imports them directly. `@deepseek-ai/dsh-subprocess` is a required peer because the host uses its runtime helper; the service provider remains host-owned.
