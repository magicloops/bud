# workflows

GitHub Actions workflows for CI and release automation.

## Files

### `bud-release.yml`

Builds Bud daemon release artifacts for the required Phase 3 platform matrix:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-unknown-linux-gnu`

The workflow:

- runs on release tags and manual `workflow_dispatch`
- installs Rust stable plus the target triple
- installs `protoc` in CI so end-user machines do not need protobuf tooling
- records Rust, target, runner, and commit metadata in logs
- builds release binaries with `BUD_BUILD_COMMIT` and `BUD_BUILD_TARGET`
- packages archives through [../../scripts/bud-release.mjs](../../scripts/bud-release.mjs)
- optionally generates GitHub artifact attestations when
  `ENABLE_RELEASE_ATTESTATIONS=true` or manual workflow input requests it
- uploads per-target tarballs and per-target metadata as workflow artifacts
- generates a per-version manifest, `checksums.txt`, and release notes
- publishes the target archives, manifest, and checksums to a GitHub Release
  without overwriting an existing release

### `get-bud-dev-promote.yml`

Manual promotion workflow for `https://get.bud.dev`.

The workflow:

- accepts an immutable GitHub Release version
- downloads `manifest.<version>.json` from that GitHub Release
- generates Worker static assets through [../../scripts/bud-release.mjs](../../scripts/bud-release.mjs)
- deploys [../../deploy/get-bud-dev/worker.js](../../deploy/get-bud-dev/worker.js) with Wrangler
- optionally smoke-tests `/install.sh`, the stable manifest, and a versioned
  artifact redirect

## Dependencies

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../../plan/install-script/phase-1-github-release-archive.md](../../plan/install-script/phase-1-github-release-archive.md)
- [../../plan/install-script/phase-4-ci-publish-and-promotion.md](../../plan/install-script/phase-4-ci-publish-and-promotion.md)

---

*Parent spec: [../github.spec.md](../github.spec.md)*
