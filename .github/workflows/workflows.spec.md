# workflows

GitHub Actions workflows for CI and release automation.

## Files

### `bud-release.yml`

Builds Bud daemon release artifacts for the required Phase 3 platform matrix:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu` (native `ubuntu-22.04-arm` runner)

The workflow:

- runs on release tags and manual `workflow_dispatch`
- uses Node.js 24-compatible official GitHub actions where available
  (`actions/checkout@v5`, `actions/upload-artifact@v7`, and
  `actions/download-artifact@v7`)
- installs Rust stable plus the target triple
- bakes `BUD_BUILD_VERSION` (the release tag) into the binary for `bud upgrade`'s self-comparison
- installs `protoc` in CI so end-user machines do not need protobuf tooling
- records Rust, target, runner, and commit metadata in logs
- vendors the browser helper (`npm ci --ignore-scripts --prefix bud/browser-helper`) so `bud/build.rs` embeds it, and verifies `bud/src/browser/pins.rs` is current (`scripts/browser-addon-pins.mjs --check`)
- builds release binaries with `BUD_BUILD_COMMIT` and `BUD_BUILD_TARGET`
- packages archives through [../../scripts/bud-release.mjs](../../scripts/bud-release.mjs)
- optionally generates GitHub artifact attestations when
  `ENABLE_RELEASE_ATTESTATIONS=true` or manual workflow input requests it
- uploads per-target tarballs and per-target metadata as workflow artifacts
- generates a per-version manifest, `checksums.txt`, and release notes
- publishes the target archives, manifest, and checksums to a GitHub Release
  without overwriting an existing release
- checks out the repository in the publish job so `gh release create
  --verify-tag` has a Git repository available for tag verification

### `get-bud-dev-promote.yml`

Manual promotion workflow for `https://get.bud.dev`.

The workflow:

- accepts an immutable GitHub Release version
- shares a non-canceling `bud-release-publication` concurrency group with
  mirror-only runs
- uses `actions/checkout@v5` for Node.js 24-compatible checkout
- installs Node.js 22 with `actions/setup-node@v6` and runs the Worker fixture
  and workerd runtime tests before any deployment
- downloads `manifest.<version>.json` from that GitHub Release
- generates Worker static assets through [../../scripts/bud-release.mjs](../../scripts/bud-release.mjs)
- deploys [../../deploy/get-bud-dev/worker.js](../../deploy/get-bud-dev/worker.js) with
  `cloudflare/wrangler-action@v4` and explicitly requests Wrangler v4
- optionally smoke-tests `/`, `/install.sh`, the stable manifest and Linux
  artifact availability, polling routes for edge propagation
- Phase 7c still needs the verified mirror gate and full deployed checksum/range
  checks; until then, mirror a selected version before invoking promotion

### `bud-release-mirror.yml`

Manually dispatched, mirror-only workflow for one exact existing release tag.
Uses `actions/setup-node@v6` (Node.js 24 action runtime) to install Node.js 22
for the scripts, with explicit npm lockfile caching. Installs the isolated
release-tool package, runs its tests, downloads through
the read-only GitHub token and uploads/verifies R2 objects using bucket-scoped
S3 credentials. Shares promotion's concurrency group; never deploys the Worker
or changes stable. Manual bucket/credential setup and acceptance are described
in [Phase 7a](../../plan/install-script/phase-7a-cloudflare-setup.md).

## Dependencies

- `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` GitHub secrets
- Private R2 bucket `bud-releases-prod`

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../../plan/install-script/phase-1-github-release-archive.md](../../plan/install-script/phase-1-github-release-archive.md)
- [../../plan/install-script/phase-4-ci-publish-and-promotion.md](../../plan/install-script/phase-4-ci-publish-and-promotion.md)

---

*Parent spec: [../github.spec.md](../github.spec.md)*
