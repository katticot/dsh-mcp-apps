# Remaining tasks — dsh-mcp-apps

Verified against `origin/main` @ `1024b59` on 2026-09-27. Published: `dsh-mcp-apps@0.2.1` (OIDC, SLSA provenance).

Legend: **[code]** needs a PR · **[you: GitHub]** / **[you: npm]** manual setting · **[local]** local cleanup

## Security / correctness

- [x] **[code] Cap stdio message size (Medium).** `src/transports/subprocess.ts` has no size limit on messages coming *in* from a stdio server (`maxMessageBytes` is only applied in `remote.ts`). A buggy or malicious stdio server can exhaust host memory, and the SDK parses the whole message before any later check runs. Apply `maxMessageBytes` (bytes, per JSON-RPC line) at the transport, the same way `createByteCappedFetch` does for remote servers. Add a test with an oversized line and one with a normal line. **Done in 0.2.1** (PR #3): stdio uses the SDK's `maxBufferSize` = `maxMessageBytes` (bytes, per line).
- [x] **[code] Size-check `readResourceRaw` (Medium).** `server-pool.ts:185-206` returns `client.readResource(...)` unchecked, while `readResource` enforces `MAX_RESOURCE_SIZE_BYTES` (`:253`). The client's `onreadresource` uses the raw path. Reject results whose total content (text bytes + decoded blob bytes) exceeds the cap. **Done in 0.2.1** (PR #3): byte-based check summed across contents; blob size is computed without decoding.
- [x] **[code] Pin `ci.yml` actions to SHAs (Medium).** `actions/checkout@v4`, `pnpm/action-setup@v4` and `actions/setup-node@v4` are still tag references. Use the same SHAs as `release.yml`. **Done in 0.2.1** (PR #3).
- [x] **[you: GitHub] Delete the unused `NPM_TOKEN` repo secret.** Verified via `gh secret list --repo katticot/dsh-mcp-apps`: no secrets listed, so it's gone.
- [ ] **[you: npm] Revoke the leftover npm token** `2439da` ("tset", 2026-09-23). It can still publish.
  `npm token revoke 2439da`
- [ ] **[you: npm] Tighten package publishing access.** Go to https://www.npmjs.com/package/dsh-mcp-apps/access. Not verifiable from the CLI.
  - Set Publishing access to "Require two-factor authentication and disallow tokens".
  - On the Trusted Publisher, allow **publish only** and turn off staged publish, which the workflow never uses.
- [x] **[you: GitHub] Add a ruleset on `main`.** Verified via `gh api repos/katticot/dsh-mcp-apps/rulesets`: ruleset `protect-main` is active, requires the `Test & Build (22.x)` status check, blocks deletion and non-fast-forward pushes, and admins can bypass.

## Review

- [ ] **[code] Review the 3 commits that landed after the final review.** CI is green on all of them, but no one has reviewed them:
  - `902ab27` docs: rewrite README for installers and fix plugin config example
  - `5480540` fix(cordis): inject `webServer` for client-connection registration. This re-adds an `inject` entry that was removed earlier as unused, so confirm that it's really needed and that the plugin still loads without `webServer` if that matters.
  - `8fb5d7b` fix(client): define `process.env` / browser fallback in the client bundle (`tsdown.config.ts`)
  - Re-check that the README example still validates against the `Config` schema.

## Cleanup / quality

- [x] **[code] Remove unreachable server-name fallbacks (Low).** In `ServerPool.listResources()` (`server-pool.ts:167-183`) and `readResourceRaw` (URI lookup), the paths for a missing `serverName` can't be reached, because every caller passes `session.serverName`. Make `serverName` required. **Done in 0.2.1** (PR #3): `serverName` is now required.
- [x] ~~**[code] Replace the static test-count badge in the README (Info).**~~ Done in this PR: README now uses the live GitHub Actions CI badge (`ci.yml/badge.svg?branch=main`).
- [x] ~~**[code] Optional: remove `docs/superpowers/plans/*.md`**~~ Done in this PR: `docs/superpowers/` removed entirely (5 internal agent plan files, ~104KB). No references to it remained elsewhere in the repo.
- [x] ~~`tools/call` duplicates `requireSession`~~. Done on main: `src/index.ts` calls `requireSession` for every endpoint (`:94`, `:101`, `:109`).

## Release

- [ ] (draft ready) **[you: GitHub] Publish v0.2.0 release notes.** A **draft** exists with corrected notes; review it and publish (`gh release edit v0.2.0 --draft=false`).
- [x] **[code] Cut `0.2.1`** after the two Medium code fixes above. Bump the version, tag `v0.2.1`, and let `release.yml` publish it. **Released 2026-09-27**: `dsh-mcp-apps@0.2.1` via OIDC with SLSA provenance, tag `v0.2.1` → `1024b59`.

## Local cleanup

- [x] ~~**[local]** Remove the finished agent worktrees and merged branches.~~ Done as part of this cleanup pass: the 4 finished agent worktrees (`agent-a422dfd376e4b0116`, `agent-a87b423b4fcaecaea`, `agent-ab061e8a699b9d3da`, `agent-ad8cc1f3904ddc9b6`) were removed clean (no uncommitted changes), followed by `git worktree prune`. The 9 merged branches were all deleted with the safe `git branch -d` (none needed a force `-D`), and `fix/area5-6-packaging-docs` was force-deleted with `-D` as approved (superseded, never merged). `git fetch --prune` found no lingering remote-tracking refs. The worktrees/branches for the still-running agents (this one, and `fix/0.2.1-size-caps`) were left untouched.

## Leftovers from this round

- [ ] **[local]** Delete the two leftover agent branches, and the stray tarball in the main checkout:
  ```bash
  git branch -D worktree-agent-a2005b0f501d52c64 worktree-agent-a9d4e882b7a0cf5ac fix/0.2.1-size-caps
  rm dsh-mcp-apps-0.2.0.tgz   # or add *.tgz to .gitignore
  ```

## Already verified OK (no action needed)

- On main: typecheck clean, 114/114 tests, build and pack OK, `pnpm audit --prod` clean.
- The 0.2.0 tarball on npm is byte-identical to a build at the `v0.2.0` tag.
- Provenance: SLSA v1 records `katticot/dsh-mcp-apps`, `release.yml@refs/tags/v0.2.0`, and environment `release`.
- The `release` environment exists and has a tag-type `v*` policy.
- 2FA is enabled on the npm account (security key, auth and publishing).
- Mutation tests on the session check, the loopback check and the zombie-refresh guard were all caught.
