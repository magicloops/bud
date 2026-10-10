# scripts

Repo-level automation scripts that do not belong to a single package.

## Purpose

This folder contains small Node.js utilities used by CI and release workflows.
The release mirror has an isolated package in this folder; other utilities
continue to use Node built-ins unless documented below.

## Files

### `bud-release-mirror.mjs`

Mirror-only publisher for an explicit GitHub release to private R2. Downloads
the exact manifest and fixed four-target archive matrix through authenticated
`gh`; validates all source bytes before writes; conditionally creates immutable
objects with HTTP/SHA-256 metadata; verifies actual existing/uploaded bytes;
publishes the version manifest last. Matching reruns are read-only and partial
runs can resume. Conflicts fail without overwriting. Never deploys or promotes
stable. Configuration is supplied through account/bucket and R2 S3 credentials.

### `bud-release-mirror.test.mjs`

Integrity, source validation, interrupted/read-back failures, resumption,
idempotency and concurrent/conflicting writes, exact GitHub asset selection,
SDK request metadata, and real SDK HTTP transport against a local S3 fixture.

### `bud-release-promote.mjs` / `bud-release-promote.test.mjs`

Promotion preparation downloads exact assets once, verifies every source and R2
object using the mirror helper, then writes the stable static manifest from that
same source. Download, validation, upload or read-back failures prevent stable
asset changes/deployment. Tests cover failure ordering and retained history.
The helper does not itself deploy; the manual workflow deploys only after success.

### `bud-release-smoke.mjs` / `bud-release-smoke.test.mjs`

Mandatory deployed acceptance streams all four complete archives and hashes them
against the canonical manifest, requires R2/no redirects, verifies manifests,
installer/no-store, HEAD, ranges/416, ETag and a warm full cache hit. Read-only
polling handles propagation. Keeps only 1 KiB at each archive end for range
comparison. Reports hashes/sizes/timing/cache/CF-Ray; `--benchmark` records three
additional serial Apple Silicon transfers, and `--historical` validates retained
versioned resources independently of mutable stable. Fixture tests use the real
Worker module and inject corrupt responses, redirects and cache failures.

### `package.json` / `package-lock.json`

Isolated release-tool dependency and reproducible npm lockfile. Install with
`npm ci --ignore-scripts --prefix scripts`; run release/mirror tests with
`npm test --prefix scripts`.

### `bud-release.mjs`

Bud daemon release artifact utility.

Responsibilities:

- map installer OS/architecture values to supported Rust target triples
- package a built `bud` binary into a versioned target archive
- write per-artifact metadata including SHA-256 and size
- generate the stable release manifest shape expected by the installer
- generate `checksums.txt` for release archive publication
- generate release notes from artifact metadata, including commit and target matrix
- generate only the mutable static stable manifest for the `get.bud.dev` Worker;
  versioned manifests/archives are served from R2, without redirect maps
- verify archive SHA-256 values for installer checksum tests

### `browser-addon-pins.mjs`

Generates `bud/src/browser/pins.rs` for the browser add-on (Phase 3r): the
pinned Node version (constant in the script), the playwright-core version from
`bud/browser-helper/package.json`, the Chrome for Testing build from that
package's `browsers.json`, the derived system-browser version floor, and
per-target URL/SHA-256/size/executable for every download. Streams and hashes
each artifact (Node cross-checked against nodejs.org `SHASUMS256.txt`);
`--check` parses the committed `pins.rs` and compares values (versions,
per-target URL/executable, well-formed hash and size) without downloading, so
rustfmt reflow cannot fail it (run in the release workflow); the generator runs
`rustfmt` on its output; `--no-hash` scaffolds URLs without checksums for
development. `browser-addon-pins.test.mjs` covers the render/parse round trip.

### `browser-addon-pins.test.mjs`

Node tests for the pin generator: rendered pins parse back to the same values
(also after `rustfmt` reflows the file when rustfmt is installed), and drift
reports changed versions, URLs, executables and missing hashes.

### `bud-release.test.mjs`

Node test coverage for artifact packaging, manifest generation, platform
selection, checksum generation, release notes, Worker promotion asset
generation, and checksum mismatch rejection.

## Subfolders

### `fixtures/bud-release/`

Release-manifest fixtures used by `bud-release.test.mjs`, including a deliberate
checksum mismatch fixture.

## Dependencies

- Node.js 20+
- host `tar` command for archive creation and archive-content tests
- `@aws-sdk/client-s3` for the R2 S3 mirror (locked in this folder's npm package)
- authenticated GitHub CLI for downloading exact release assets

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
