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
- uploads per-target tarballs, per-target metadata, and the generated manifest

## Dependencies

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)

---

*Parent spec: [../github.spec.md](../github.spec.md)*
