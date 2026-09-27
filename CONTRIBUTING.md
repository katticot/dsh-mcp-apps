# Contributing

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm test:artifact   # builds first, then checks the packaged client bundle
```

## Releasing

Releases are tag-triggered: pushing a `v*` tag to `main` runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes to npm via OIDC trusted publishing. There is no `NPM_TOKEN` secret — the `release` environment authenticates purely through GitHub's OIDC identity.

1. **Bump the version in a PR.** Update `version` in `package.json`, update `CHANGELOG.md`, and merge the PR into `main` through the normal review/CI process. `main` has a ruleset requiring the `Test & Build (22.x)` check to pass (repo admins can bypass it, but shouldn't for a release bump).
2. **Tag the merged commit on `main`**: `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`.
3. **The workflow takes over**: it verifies the tag matches `package.json#version` and that the tagged commit is reachable from `origin/main`, runs `pnpm typecheck`, `pnpm test`, and `pnpm test:artifact`, packs the tarball, runs the headless DSH smoke test (`pnpm test:smoke`) against it for the `allow`/`deny`/`approve` policies, pins `npm@11.20.0` (OIDC trusted publishing requires npm `>= 11.5.1`; the npm bundled with `actions/setup-node`'s Node 22 is older), and publishes that exact tarball with `npm publish --provenance`.
4. **Publish the GitHub release notes** for the tag (a draft may already exist from an earlier step — review and publish it, or write new notes) once the workflow succeeds.

### Gotchas

- **Never re-tag a version that published successfully.** npm rejects republishing an already-published version, and moving a tag that already succeeded just to "fix" something is a footgun — cut a new patch version instead.
- **A failed publish can only be retried by moving the tag**, and only if nothing was actually published to npm for that version. Check `npm view dsh-mcp-apps dist-tags` (or the specific version) before retrying — if the tarball never reached the registry, delete and re-push the tag (`git tag -d vX.Y.Z && git push origin :vX.Y.Z`, fix the issue, then re-tag) to re-run the workflow. If it did publish, bump to a new version instead.
- The release job pins action versions to commit SHAs (not tags) and pins the npm CLI version explicitly — both were previously the source of publish failures (see the `v0.2.2` release notes for the two pipeline bugs that blocked its first two publish attempts).
