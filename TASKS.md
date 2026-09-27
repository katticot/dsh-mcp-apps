# Remaining tasks — dsh-mcp-apps

Verified against `origin/main` @ `3b04e22` (tag `v0.2.2`) on 2026-09-27. Published: `dsh-mcp-apps@0.2.2` (npm OIDC trusted publishing, SLSA provenance). `0.2.1` and `0.2.0` remain published as prior versions; `NPM_TOKEN` has been removed from repo secrets (`gh secret list` returns none); a branch ruleset (`protect-main`) is active on `main` requiring the `Test & Build (22.x)` check; CI actions are pinned to SHAs. Release notes for `v0.1.0`, `v0.2.0`, `v0.2.1`, and `v0.2.2` are all published (none are drafts).

Everything code-side and GitHub-side from the prior round of this list is done. Two items remain, and both require action on npmjs.com — they cannot be done from the CLI or this repo.

## Remaining — [you: npm]

- [ ] **Revoke the leftover npm token** `2439da` ("tset", created 2026-09-23). It can still publish packages.
  ```
  npm token revoke 2439da
  ```
- [ ] **Tighten package publishing access.** On https://www.npmjs.com/package/dsh-mcp-apps/access:
  - Set publishing access to "Require two-factor authentication and disallow tokens".
  - On the trusted publisher (GitHub Actions OIDC) configuration, restrict it to **publish only** and turn off staged publishing, which `release.yml` never uses.

Neither of these is verifiable from the CLI (`npm token revoke` needs an authenticated session; the access-control toggles have no `npm` CLI equivalent) — confirm both directly on npmjs.com.
