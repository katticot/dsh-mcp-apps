# Task 6 runtime report

## Tested artifact and environment

- DSH: `0.1.5-rc.3`, web profile; other DSH and Cordis releases remain unverified.
- Plugin: `dsh-mcp-apps@0.2.0`, installed from the pnpm tarball into a temporary `DSH_HOME` profile. The smoke runner verifies the profile dependency points to that tarball and compares the installed package, host bundle, and client bundle bytes with the archive.
- Tarball SHA-256: `b035b45f47009cd3e424c0372e94124205572a40f0bc0d7bb99a21e99a93d946`.
- Browser: Playwright Chromium, headless. All profile files, fixture processes, and mock LLM traffic are isolated under a temporary directory; the fixture logs evidence outside that directory so cleanup does not erase it.

## Runtime evidence

The local stdio MCP fixture delays readiness for 25 seconds, past the plugin's initial 15-second synchronization window. DSH later discovers its weather tool through the normal tool registry. The mock model selects that tool through DSH, and the fixture returns `Nairobi` input/result values that render inside the sandboxed iframe.

The runner captures the app session token from real resource traffic and sends a cross-server resource request through the authenticated shared `/api` route. The request returns `forbidden` and the fixture confirms it never read the private resource. A trusted Playwright click on the iframe's Refresh button exercises the bridge and actual host policy:

- `allow`: callback tool executes and the fixture records `refreshCount: 1`.
- `deny`: callback returns the denied policy error and the fixture records no refresh.
- `approve`: DSH displays its real `Reject` / `Allow once` prompt while the agent is running. Clicking `Allow once` executes the callback and the fixture records `refreshCount: 1`.

After each policy case, the runner stops and restarts the same isolated DSH profile, verifies the old fixture records shutdown, waits for a new delayed fixture process, and confirms exactly one weather tool route is advertised. The approve case additionally submits a second prompt and checks the new fixture PID receives a second model-selected weather call with one app iframe. On final shutdown the runner terminates and checks every fixture PID recorded by the test.

Screenshots are saved outside the automatically removed smoke profile under the operating system temporary directory. The allow and approve evidence from the current run are:

- `/var/folders/xw/km0hx5hx69s66w3pd7jsl0c00000gn/T/dsh-mcp-apps-smoke-33738-allow.png`
- `/var/folders/xw/km0hx5hx69s66w3pd7jsl0c00000gn/T/dsh-mcp-apps-smoke-42064-approve.png`

## Validation

The final source validation sequence is:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:artifact
pnpm pack --pack-destination /tmp/dsh-mcp-apps-task6-artifacts
pnpm test:smoke /tmp/dsh-mcp-apps-task6-artifacts/dsh-mcp-apps-0.2.0.tgz --policy=allow
pnpm test:smoke /tmp/dsh-mcp-apps-task6-artifacts/dsh-mcp-apps-0.2.0.tgz --policy=deny
pnpm test:smoke /tmp/dsh-mcp-apps-task6-artifacts/dsh-mcp-apps-0.2.0.tgz --policy=approve
```

The type check passed, the source suite passed 123 tests across 13 files, the browser artifact suite passed 2 tests, and the package build completed. The focused host-contract suite passed 4 tests after adding runtime validation with `clientRequestSchema`. The approve policy passed with a real DSH prompt and a profile restart that launched a new fixture process and served a second model-selected call.

Allow and deny callback behavior passed in the real profile before the restart extension. A later attempt to perform a second model call after restart in the same browser context failed because DSH replayed the mock's fixed `mock-call-1` trajectory ID. The runner now starts a fresh browser context and only the approve case performs that second model call; the allow/deny route-after-restart branch has not been rerun since this adjustment. Treat those two restart cases as pending runtime confirmation.

The smoke fixture exercises stdio. The existing transport, auth, CSP, session isolation, reconnect, and bridge tests remain part of `pnpm test`. CI and release validation run the same build, artifact test, pack, and all three policy smoke cases; the release job publishes the tarball it tested without rebuilding it.
