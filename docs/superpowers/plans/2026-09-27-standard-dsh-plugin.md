# Standard DSH MCP Apps Plugin Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task after implementation is requested. Steps use checkboxes for tracking. No subagents are required by this plan.

**Goal:** Make dsh-mcp-apps a reliably installable DSH web plugin that renders MCP Apps as sandboxed, interactive iframes inside chat and supports policy-controlled calls back to MCP tools.

**Architecture:** Keep the existing host/client split, MCP server pool, session store, and iframe bridge. Replace speculative DSH compatibility paths with the public contracts of one explicitly tested release. Verify the packed package inside DSH, in addition to testing source code.

**Tech Stack:** TypeScript, Cordis 4, DSH, React 18, MCP SDK/ext-apps, tsdown, Vitest.

**Spec:** The design brief and constraints below define the proposed scope. This document is a plan for review, not evidence that compatibility or runtime tests have passed.

## Design brief

The plugin exists to turn MCP tool results containing ui:// resources into usable apps in DSH chat. Standardization must preserve that outcome: successful installation alone is insufficient. A user must be able to invoke an MCP tool, see its app with the correct input/result, interact with it, and have further tool requests obey the configured policy.

Recommended approach: target one published DSH release first and use its public contracts throughout. The installed connection package is 0.1.5-rc.3; use that as the initial compatibility candidate, not as a proven supported release. Verify the complete DSH runtime and peer package set before declaring support. Upstream master is reference material, not a substitute for the release actually tested.

Alternatives considered:
- Keep broad compatibility through runtime method probing: smaller initial change, but preserves untested branches and inaccurate types.
- Rewrite around current upstream master: potentially larger API migration and no guarantee of compatibility with users' installed release.

## Global constraints

- Preserve stdio, SSE, and Streamable HTTP server support, reconnect behavior, tool naming, and existing configuration.
- Preserve the sandboxed iframe, generated CSP, bridge initialization, resource loading, and input/result delivery.
- Preserve per-session and per-server isolation; reverse calls stay denied by default and respect deny/approve/allow.
- Preserve the Interactive App presentation and intended disclosure behavior during and after streaming.
- Keep web as the supported UI profile. Do not add desktop, TUI, or headless support in this cleanup.
- Keep Node.js >=22 as the plugin floor unless the selected DSH release requires a higher minimum; document and test any required increase.
- Do not remove webServer merely to shorten inject: the installed connection implementation accesses it even through rpc.handle.
- No production configuration changes, publication, or implementation are part of writing this plan.
- Avoid unrelated transport or bridge rewrites. Fix changes required by public API compatibility or the acceptance scenarios below.

## Evidence and references

Local findings:
- src/index.ts declares a custom Context.connection shape, probes register and its prototype, then falls back to rpc.handle with the same argument list.
- Installed public HostConnectionRpc.handle accepts (channel, handler), not (ctx, channel, handler, options). Its disposer returns a Promise.
- Installed connection.rpc.handle delegates to registration that calls owner.webServer.register. Keep that dependency for this baseline.
- The current lifecycle calls unregisterRpc() without awaiting it.
- Optional approval/agents access uses ctx.approval/ctx.agents before ctx.get; a throwing direct lookup would prevent the fallback.
- tests/rpc-auth.spec.ts mocks connection.register, so it cannot detect mismatch with the public rpc.handle contract.
- src/client/index.tsx relies on a locally defined context, optional broadcast-related events, and two delayed discovery retries.
- tsdown.config.ts already produces a ModuleLoader factory, but also provides a synthetic process object and replaces all of process.env.
- CI checks source tests and builds; it does not currently prove installation or app rendering from a tarball.

Upstream references checked on 2026-09-27 (master may move):
- [Connection public RPC contracts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/src/rpc.ts): handle(channel, handler) and the client call contract.
- [DSH client bundling preset](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/tsdown.client.ts): ModuleLoader factory and loader-supplied externals. Reproduce the external package contract; do not import this monorepo-only helper blindly.
- [Built-in tool UI bundle configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-tool/tsdown.config.ts).

## Review focus

1. A packed install must render an actual app, without relying on this repository's devDependencies (Task 6).
2. Approval services absent or removed during use must deny/unavailable safely, without a Cordis access error or unauthorized tool execution (Task 3).
3. An MCP server that becomes ready after eight seconds must still acquire its app view (Task 4).
4. Unload during an RPC or pending discovery must not leave routes, subprocesses, timers, or views behind (Tasks 2 and 4).
5. A second app/session must not read another server's resources or execute its tools (Tasks 3 and 6).

## Task 1: Establish the release and package contract

**Files:** package.json, pnpm-lock.yaml, README.md; create docs/dsh-compatibility.md.

**Deliverable:** One reproducible DSH baseline and a table connecting each service/client module to its provider and public type.

- [ ] Record the installed DSH package versions using `pnpm list --depth 0`; inspect the published exports and declarations for connection, tools, slots, subprocess, agent, and approval.
- [ ] Verify that a published DSH runtime matches the candidate peer set. Record its exact version and corresponding source tag/commit in docs/dsh-compatibility.md.
- [ ] Map host inject services separately from package.json dsh.client.inject module identifiers. Check that slots and tool UI providers are loaded through supported dependencies.
- [ ] Set peer/dev dependency constraints to the baseline actually tested. Do not retain a broad range as an implied compatibility promise. Regenerate the lockfile using the repository's pinned pnpm version.
- [ ] Confirm runtime imports are dependencies/peers, and host-provided browser modules follow the selected loader contract. Decide React externalization from that contract, including react/jsx-runtime; avoid a second React runtime.
- [ ] Run `pnpm install --frozen-lockfile` and `pnpm typecheck`; record any existing failures separately from migration failures.

## Task 2: Adopt public host registration and lifecycle contracts

**Files:** src/index.ts, src/tool-manager.ts, tests/rpc-auth.spec.ts; create tests/dsh-host-contract.spec.ts.

**Interfaces:** Use the selected release's exported ConnectionRpcHandler/HostConnectionRpc and tools service types. Preserve the /mcp-apps channel and current endpoint payloads.

- [ ] Add a regression test whose connection exposes only rpc.handle. Assert it receives exactly the channel and handler; invoke the captured handler to check tools/list-ui. This must fail against the current registration fallback.
- [ ] Add a real Cordis fixture with provider services and load the plugin through Cordis, not apply(mockCtx). Assert activation, route registration, unload, and reload. Use the selected connection implementation to exercise actual service access rules.
- [ ] Replace register/prototype probing and the fabricated connection augmentation with public types and this registration shape:

```ts
const unregisterRpc = ctx.connection.rpc.handle('/mcp-apps', handler)
```

- [ ] Type the existing handler against the exported contract; adjust result envelopes only where required by that release. Remove the extra authority option unless a documented public API supports it.
- [ ] Keep tools, connection, and webServer in required inject for the installed baseline. Add explicit provider types/dependencies where needed rather than weakening types.
- [ ] Await asynchronous route disposal and preserve bounded in-flight draining and server/session cleanup. Test rejection during teardown so one failing disposer cannot skip remaining cleanup; follow Cordis ownership rules to avoid double disposal.
- [ ] Run `pnpm exec vitest run tests/dsh-host-contract.spec.ts tests/rpc-auth.spec.ts tests/tool-manager.spec.ts` and `pnpm typecheck`.

## Task 3: Make optional services work within Cordis scopes

**Files:** src/index.ts, tests/rpc-auth.spec.ts, tests/dsh-host-contract.spec.ts.

**Deliverable:** Approval works when providers exist; absence does not break ordinary MCP app use or permit execution.

- [ ] Add real-Cordis cases for missing providers, providers appearing after load, provider removal, idle agent, and approval cancellation. Assert no tool execution unless approval returns the permitted outcome.
- [ ] Use the release's supported scoped injection mechanism for approval and agents. A small scoped callback can retain available service references and clear them on disposal; core plugin activation must not require optional providers.
- [ ] Remove direct undeclared ctx.approval/ctx.agents access and reflective fallback behavior that merely accommodates loose mocks.
- [ ] Keep session ownership, reverse-tool allowlists, and approve/deny/allow behavior intact. Reuse existing authorization tests and add a case for a valid token from the wrong server.
- [ ] Run `pnpm exec vitest run tests/rpc-auth.spec.ts tests/dsh-host-contract.spec.ts tests/session-store.spec.ts`.

## Task 4: Align client integration and reliable app discovery

**Files:** src/client/index.tsx, src/client/McpAppToolView.tsx, src/tool-manager.ts; create tests/client-plugin.spec.ts; retain tests/client-bridge.spec.ts and tests/bridge-lifecycle.spec.ts.

**Interfaces:** Use public client connection and tool-view slot contracts, with narrow adapters only for plugin-owned data such as UiToolInfo.

- [ ] Test tool-view registration with real slot props: a completed MCP result supplies the expected resource, input, result, and session token to the bridge. Check the Interactive App/disclosure behavior.
- [ ] Replace invented host/client service signatures with exported types where available. Ensure types for host and browser contexts do not conflict; split TypeScript configurations only if required by the release's separate context declarations.
- [ ] Verify which documented transport delivers tool-list changes and reconnect notifications. Do not assume a host ctx.emit reaches the browser or that connection.broadcast exists.
- [ ] Use a documented notification path if the selected release provides one. Otherwise use a single bounded-frequency discovery loop while the plugin is active (five-second interval, at most one request in flight), plus immediate initial discovery. Cancel it on disposal.
- [ ] Add delayed discovery (>8 seconds), reconnect, tool removal/replacement, overlapping response, and unload-before-response tests. Stale responses must not recreate disposed views.
- [ ] Run `pnpm exec vitest run tests/client-plugin.spec.ts tests/client-bridge.spec.ts tests/bridge-lifecycle.spec.ts` and `pnpm typecheck`.

## Task 5: Produce a browser-safe DSH artifact

**Files:** tsdown.config.ts, package.json; create tests/client-bundle.spec.ts and a separate vitest.artifact.config.ts if necessary to require a completed build.

**Deliverable:** The built client factory executes with DSH's supported externals and no Node process shim.

- [ ] Test lib/client.js in a browser-like realm with process absent and an instrumented window.__ModuleLoader__.load. Execute the captured factory using only the baseline's documented module table; verify the exported plugin loads and can render a tool view.
- [ ] Match the selected release's factory/exports contract and external module names. Keep the factory wrapper: it is part of DSH integration.
- [ ] Keep platform: 'browser' and precise compile-time NODE_ENV replacement. Remove the process banner and broad process.env replacement once the artifact test proves neither is required. If another dependency accesses Node globals, identify and correct that import/build boundary before proceeding.
- [ ] Reject unexpected Node built-ins and missing external modules in the artifact test. Verify exports and all referenced chunks are included in the package; avoid snapshotting an entire minified bundle.
- [ ] Add a `test:artifact` script, run after build. Validate using `pnpm build` followed by `pnpm test:artifact`.

## Task 6: Prove installation and the complete MCP app workflow

**Files:** README.md, docs/dsh-compatibility.md, package.json, .github/workflows/ci.yml, .github/workflows/release.yml; create tests/fixtures/mcp-app-server.ts and scripts/smoke-dsh.mjs.

**Deliverable:** Reproducible evidence that the tarball works inside the supported DSH web profile.

- [ ] Build a deterministic local MCP fixture with a ui:// app resource and a Refresh button that calls a second tool. Serve identifiable input/result values so assertions prove the correct data reached the app. Use the existing MCP SDK; no paid service or credentials.
- [ ] Create a temporary DSH home/profile, install the exact DSH baseline, and install the packed plugin through its supported plugin installation mechanism. Confirm the actual installed package path points to the tarball, not the checkout. Do not touch the user's normal DSH profile.
- [ ] Start the profile with the fixture configured. In a real browser, invoke the fixture tool through DSH's tool path, assert the iframe renders its input/result, click Refresh, and verify updated content. A stubbed response may make model invocation deterministic, but must not bypass tool registration, session creation, resource RPC, or the bridge.
- [ ] Exercise deny, approve, and allow with the actual runtime. Verify a cross-session/resource request is rejected; run existing transport tests for all three transports and include the stdio fixture in the packaged smoke test.
- [ ] Verify delayed server readiness, plugin reload, and shutdown do not duplicate views/routes or leave the fixture process alive. Clean up only the temporary profile/processes owned by the test.
- [ ] Run the final sequence: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:artifact`, `pnpm pack --pack-destination <temporary-directory>`, then the packaged DSH smoke runner against that tarball.
- [ ] Add these gates to CI and before release publication. Ensure release validation tests the artifact being published, with no unverified rebuild changing its contents.
- [ ] Update installation/configuration instructions using commands verified against the chosen release. Document the tested DSH version, required web profile, activation/restart steps, and an example that renders an app. State other releases as unverified until tested.

## Runtime correction discovered during Task 6

The packed plugin failed in the real DSH rc.3 profile even after Task 2: public `connection.rpc.handle` accesses `webServer` through the connection provider's Cordis shadow scope, whose declared dependency is only `credentials`. The initial real-Cordis test put connection and webServer in one provider fiber and therefore concealed this boundary.

This evidence supersedes Task 2's choice of `rpc.handle` and the internal `/mcp-apps` channel. Use the public `connection.fetch.register` API for exact POST routes at `/api/mcp-apps/<endpoint>`, with client `rpc.call('/api', 'mcp-apps/<endpoint>', payload)`. A small host adapter must validate the exported `clientRequestSchema`, enforce agreement between the request method and route, preserve cancellation, and return the public server-response envelope. Keep existing endpoint payloads, session authorization, and approval policies. DSH's shared `/api` transport continues to own authentication, origin checks, and request limits.

Do not use the private registration method, change another plugin's injection declaration, or take over the singleton `/api` interceptor. Add a regression with separate provider fibers, update host/client contract tests to exercise the final route API, and rerun the packed profile test. The tradeoff is maintaining a small wire adapter and changing the internal host/client URL together; user configuration and MCP app behavior stay the same.

## Completion criteria

The change is ready for release review only when a clean profile installed from the package renders the fixture MCP app, delivers its tool data, executes an allowed callback, rejects denied callbacks, survives reload/reconnect, and passes the existing isolation/CSP/transport tests. Confirm the package being offered includes the fixes. Source typechecks and a successful build alone do not satisfy this goal.

## Execution order

Perform Tasks 1–6 in order. Public contracts from Task 1 guide both host and client work. Record focused test results after each task; run the complete suite at the end. Review the final diff against the preserved product goal before considering a version bump or publication.
