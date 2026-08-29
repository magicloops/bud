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
- uses `actions/checkout@v5` for Node.js 24-compatible checkout
- downloads `manifest.<version>.json` from that GitHub Release
- generates Worker static assets through [../../scripts/bud-release.mjs](../../scripts/bud-release.mjs)
- deploys [../../deploy/get-bud-dev/worker.js](../../deploy/get-bud-dev/worker.js) with
  `cloudflare/wrangler-action@v4` and explicitly requests Wrangler v4
- optionally smoke-tests `/`, `/install.sh`, the stable manifest (polling up Both the stable manifest AND the versioned Linux artifact routes are polled (up to 3 minutes) — Worker propagation is eventually consistent per route, and the v0.1.15 promote saw the manifest converge while an artifact HEAD 404'd a second later.
  to 3 minutes for edge propagation of the new Worker version — single-shot
  checks repeatedly raced it and read the previous release), and a
  versioned artifact redirect

## Dependencies

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../../plan/install-script/phase-1-github-release-archive.md](../../plan/install-script/phase-1-github-release-archive.md)
- [../../plan/install-script/phase-4-ci-publish-and-promotion.md](../../plan/install-script/phase-4-ci-publish-and-promotion.md)

---

*Parent spec: [../github.spec.md](../github.spec.md)*
