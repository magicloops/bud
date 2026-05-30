# Phase 4: CI Publish And Promotion

## Objective

Make release publication repeatable: CI should build the daemon, publish GitHub
Release assets, generate the `get.bud.dev` manifest/redirect map, and promote a
stable channel intentionally.

## Workflow Shape

### Build

- Trigger on `v*` tags and manual dispatch.
- Build required target matrix.
- Install `protoc` in CI.
- Package archives and metadata.
- Run release-tooling tests.
- Verify `bud --version` for each built target.

### Publish GitHub Release

- Create GitHub Release for `vX.Y.Z`.
- Upload target archives.
- Upload `checksums.txt`.
- Upload `manifest.vX.Y.Z.json`.
- Generate attestations if enabled.
- Mark release immutable if available and compatible with the team's release
  process.

### Promote `get.bud.dev`

- Generate stable manifest with first-party URLs:
  `https://get.bud.dev/releases/vX.Y.Z/...`
- Generate Worker release map:
  first-party path -> exact GitHub Release asset URL.
- Deploy Worker/static assets through Wrangler.
- Smoke-test `get.bud.dev` after deploy.

## Manual vs Automatic Promotion

Recommended first pass:

- tags build and publish a GitHub Release
- stable `get.bud.dev` promotion is manual workflow dispatch with explicit
  `version`

Rationale:

- early releases need manual inspection
- stable manifest mistakes affect every installer
- rollback is simpler when promotion is a separate event

Later, after confidence:

- `v*` tag can auto-promote to stable
- `canary` can auto-promote from pre-release tags

## Rollback

Rollback should not mutate release assets.

Preferred rollback:

1. Pick the previous known-good version.
2. Re-run promotion workflow for that version.
3. Worker updates `/releases/stable/manifest.json` and redirect map.
4. Existing versioned URLs stay immutable.

If the Worker deploy itself is bad:

- redeploy previous Worker version from Cloudflare deployment history or CI
  artifact
- verify `/install.sh` and stable manifest before announcing recovery

Implemented workflow behavior:

- `.github/workflows/get-bud-dev-promote.yml` is manual-only.
- Re-running it with a previous immutable GitHub Release version repoints the
  stable manifest and Worker redirect map to that version.
- Versioned GitHub Release assets are never mutated during rollback.
- Cloudflare Worker deployment rollback remains available from Cloudflare's
  deployment history if the Worker script/config itself is bad.

## Required Secrets And Permissions

GitHub:

- `contents: write` for release creation/upload
- `attestations: write` and `id-token: write` if artifact attestations are
  generated

Cloudflare:

- scoped `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- Worker edit/deploy permission for the `get-bud-dev` script
- custom domain already bound or deploy permission to bind it

Do not store GitHub PATs or Cloudflare global API keys for this workflow.

## Implementation Areas

- `.github/workflows/bud-release.yml`
- `scripts/bud-release.mjs`
- Worker deploy scripts/config under `deploy/get-bud-dev/`
- generated release-map artifact
- promotion workflow inputs

## Test Plan

- Manual `canary` run publishes to a draft/pre-release or test tag.
- Promotion to a test channel deploys Worker assets.
- Smoke validates `install.sh`, stable manifest, and redirect map.
- Rollback promotion repoints stable manifest to previous version.
- CI refuses to promote when any required target artifact is missing.

## Exit Criteria

- [x] CI creates GitHub Release assets
- [x] CI generates checksums and per-version manifest
- [x] CI generates release-map for Worker redirects
- [x] stable promotion deploys Worker assets/config
- [x] promotion can be manual by version
- [x] rollback is documented
- [ ] rollback is validated against a deployed Worker
- [x] secrets are scoped and documented
