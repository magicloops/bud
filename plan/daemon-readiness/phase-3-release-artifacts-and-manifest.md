# Phase 3: Release Artifacts And Manifest

## Objective

Create the artifact channel that `install.sh` can trust.

Users should not need Rust, Cargo, `protoc`, or the repo layout to install Bud.

Detailed implementation is now scoped in
[../install-script/implementation-spec.md](../install-script/implementation-spec.md).
This Phase 3 daemon-readiness document remains the release-artifact contract;
the install-script plan owns the concrete GitHub Release publication,
`get.bud.dev` Worker, installer script, promotion, validation, and fallback
phases.

Selected v1 distribution shape:

- GitHub Releases are the canonical immutable archive for versioned Bud daemon
  artifacts.
- `https://get.bud.dev` is a Cloudflare Worker custom domain and first-party
  installer/manifest origin.
- `https://get.bud.dev/releases/stable/manifest.json` is the stable channel
  manifest.
- Manifest artifact URLs stay first-party under `get.bud.dev`.
- Versioned `get.bud.dev/releases/vX.Y.Z/...` artifact URLs redirect to exact
  GitHub Release assets.
- R2/S3 mirror support is deferred until validation proves GitHub availability,
  corporate-network reachability, or first-party download control is a real
  blocker.

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

Publish immutable versioned archives through GitHub Releases, exposed through
first-party `get.bud.dev` URLs:

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

Implementation:

- `scripts/bud-release.mjs package` packages an already-built `bud` binary into
  the target archive and writes per-artifact metadata with SHA-256 and size.
- `.github/workflows/bud-release.yml` builds the required target matrix and
  uploads each archive plus metadata.
- `bud --version` reports package version, build commit, target triple, and
  build profile for installed-artifact inspection.
- [../install-script/phase-1-github-release-archive.md](../install-script/phase-1-github-release-archive.md)
  owns the remaining GitHub Release publication details: release creation,
  asset upload, checksums, attestations, and immutability policy.

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

The manifest should use first-party artifact URLs under `get.bud.dev`, not
GitHub `latest` URLs or raw GitHub asset URLs. The Worker maps those first-party
versioned paths to exact GitHub Release assets. This preserves a stable
installer contract and lets us later switch or add mirrors without changing the
install command or installer target-selection contract.

Implementation:

- `scripts/bud-release.mjs manifest` generates the manifest from actual
  per-artifact metadata emitted during packaging.
- `scripts/bud-release.mjs detect-target` and exported
  `targetForPlatform(...)`/`selectManifestArtifact(...)` define the supported
  OS/architecture selection table for the Phase 4 installer.
- `scripts/fixtures/bud-release/manifest-checksum-mismatch.json` and
  `scripts/bud-release.test.mjs` cover checksum mismatch behavior.
- [../install-script/phase-2-get-bud-dev-worker.md](../install-script/phase-2-get-bud-dev-worker.md)
  owns the Worker route behavior for stable manifest serving, versioned
  manifest serving, artifact redirects, cache headers, and method/path
  guardrails.

## CI Build Requirements

- CI owns `protoc`; end-user machines do not need it.
- Release builds are reproducible enough to trust CI outputs.
- Build logs record Rust version, target, OS image, and commit SHA.
- Release artifacts are generated only from tagged or explicitly approved commits.
- Checksums are generated in CI, not manually.
- Manifest is generated from the actual artifact outputs.

The initial workflow already builds and packages target archives. The
install-script plan extends that into a release/promotion pipeline:

- [../install-script/phase-1-github-release-archive.md](../install-script/phase-1-github-release-archive.md)
  publishes the immutable GitHub Release archive.
- [../install-script/phase-4-ci-publish-and-promotion.md](../install-script/phase-4-ci-publish-and-promotion.md)
  defines stable-channel promotion, Worker deployment, and rollback.
- [../../deploy/get-bud-dev/release-hosting.md](../../deploy/get-bud-dev/release-hosting.md)
  remains the deployment handoff for `get.bud.dev` hosting behavior.

## Signing And Provenance

Minimum v1:

- TLS-hosted artifacts
- SHA-256 manifest verification
- immutable versioned artifact URLs
- CI-generated checksums and manifest metadata
- GitHub Release assets as the canonical archive
- first-party `get.bud.dev` manifest and installer origin

Preferred before broad launch:

- macOS code signing
- macOS notarization if distribution warnings become unacceptable
- artifact provenance, for example SLSA-style attestations or equivalent CI-signed metadata
- `cargo audit` / `cargo deny` in CI
- R2/S3 mirror if GitHub availability or customer network policies materially
  affect install success

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
- GitHub Release publication/promotion workflow
- Cloudflare Worker for `get.bud.dev`
- `bud/Cargo.toml`
- `bud/build.rs`
- artifact hosting config for `get.bud.dev`
- optional release metadata under `deploy/` or `docs/`

## Tests

- CI release dry run for every required target
- GitHub Release asset upload dry run
- Worker route tests for `install.sh`, stable manifest, and versioned artifact redirects
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
- [../install-script/install-script.spec.md](../install-script/install-script.spec.md)
  and child phase docs for implementation-level changes

## Exit Criteria

- [ ] stable manifest exists at the planned `get.bud.dev` path in the target environment
- [ ] required platform artifacts are published with SHA-256 hashes
- [ ] required platform artifacts are present as immutable GitHub Release assets
- [ ] `get.bud.dev` versioned artifact URLs redirect to exact GitHub Release assets
- [ ] installer can select the correct artifact from OS/arch
- [ ] users do not need Rust, Cargo, `protoc`, or the repo to install
- [ ] artifact version and target are inspectable from the installed binary
