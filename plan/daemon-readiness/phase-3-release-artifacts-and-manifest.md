# Phase 3: Release Artifacts And Manifest

## Objective

Create the artifact channel that `install.sh` can trust.

Users should not need Rust, Cargo, `protoc`, or the repo layout to install Bud.

## Supported Matrix

V1 required:

- `aarch64-apple-darwin`, tested on macOS 13+
- `x86_64-apple-darwin`, tested on macOS 13+
- `x86_64-unknown-linux-gnu`, built with a controlled glibc floor and tested on Ubuntu 22.04/24.04

Optional after the required matrix is stable:

- `aarch64-unknown-linux-gnu`
- `x86_64-unknown-linux-musl`
- `aarch64-unknown-linux-musl`

If the GNU Linux binary is built on Ubuntu 22.04, document glibc 2.35+ as the compatibility floor unless a lower controlled sysroot is introduced.

## Artifact Shape

Publish immutable versioned archives:

```text
https://get.bud.dev/releases/vX.Y.Z/bud-aarch64-apple-darwin.tar.gz
https://get.bud.dev/releases/vX.Y.Z/bud-x86_64-apple-darwin.tar.gz
https://get.bud.dev/releases/vX.Y.Z/bud-x86_64-unknown-linux-gnu.tar.gz
```

Each archive should include:

- `bud` executable
- `LICENSE` if available
- minimal `README` with version, platform, and support URL

Do not include tmux.

## Release Manifest

Publish a machine-readable manifest at a stable channel URL:

```text
https://get.bud.dev/releases/stable/manifest.json
```

Recommended fields:

```json
{
  "version": "vX.Y.Z",
  "channel": "stable",
  "published_at": "2026-05-30T00:00:00Z",
  "artifacts": [
    {
      "target": "aarch64-apple-darwin",
      "url": "https://get.bud.dev/releases/vX.Y.Z/bud-aarch64-apple-darwin.tar.gz",
      "sha256": "...",
      "min_os": "macOS 13",
      "size": 12345678
    }
  ]
}
```

The installer must verify the downloaded archive SHA-256 against this manifest before installation.

## CI Build Requirements

- CI owns `protoc`; end-user machines do not need it.
- Release builds are reproducible enough to trust CI outputs.
- Build logs record Rust version, target, OS image, and commit SHA.
- Release artifacts are generated only from tagged or explicitly approved commits.
- Checksums are generated in CI, not manually.
- Manifest is generated from the actual artifact outputs.

## Signing And Provenance

Minimum v1:

- TLS-hosted artifacts
- SHA-256 manifest verification
- immutable versioned artifact URLs

Preferred before broad launch:

- macOS code signing
- macOS notarization if distribution warnings become unacceptable
- artifact provenance, for example SLSA-style attestations or equivalent CI-signed metadata
- `cargo audit` / `cargo deny` in CI

Do not block internal validation on notarization, but do not ignore it before public launch.

## Source Package Concern

`bud/build.rs` currently compiles `../proto/bud/v1/bud.proto`, so a standalone daemon source package depends on monorepo layout and `protoc`.

For binary distribution this is acceptable because CI builds the artifact. For source distribution later, decide whether to:

- check in generated protobuf Rust code, or
- publish a source archive that includes `proto/`, or
- keep source builds documented as monorepo-only

## Expected Code And Infra Areas

- CI workflow files
- release artifact upload/publish scripts
- `bud/Cargo.toml`
- `bud/build.rs`
- artifact hosting config for `get.bud.dev`
- optional release metadata under `deploy/` or `docs/`

## Tests

- CI release dry run for every required target
- local install script fixture can parse manifest
- checksum mismatch fixture fails installation
- release artifact contains executable `bud`
- `bud --version` reports expected version/commit
- `bud --help` no longer describes itself as PoC after Phase 1

## Spec Files To Update

- `bud/bud.spec.md`
- `bud/src/src.spec.md` only if build/version code changes source layout
- `bud.spec.md`
- deployment/release docs if new files are added

## Exit Criteria

- [ ] stable manifest exists at the planned `get.bud.dev` path in the target environment
- [ ] required platform artifacts are published with SHA-256 hashes
- [ ] installer can select the correct artifact from OS/arch
- [ ] users do not need Rust, Cargo, `protoc`, or the repo to install
- [ ] artifact version and target are inspectable from the installed binary
