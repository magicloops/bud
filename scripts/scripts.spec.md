# scripts

Repo-level automation scripts that do not belong to a single package.

## Purpose

This folder contains small Node.js utilities used by CI and release workflows.
Scripts should avoid package-local dependencies unless the owning package
explicitly provides them.

## Files

### `bud-release.mjs`

Bud daemon release artifact utility.

Responsibilities:

- map installer OS/architecture values to supported Rust target triples
- package a built `bud` binary into a versioned target archive
- write per-artifact metadata including SHA-256 and size
- generate the stable release manifest shape expected by the installer
- generate `checksums.txt` for release archive publication
- generate release notes from artifact metadata, including commit and target matrix
- generate the Worker release-map JSON that maps first-party versioned archive
  paths to exact GitHub Release asset URLs
- generate static promotion assets for the `get.bud.dev` Worker
- verify archive SHA-256 values for installer checksum tests

### `browser-addon-pins.mjs`

Generates `bud/src/browser/pins.rs` for the browser add-on (Phase 3r): the
pinned Node version (constant in the script), the playwright-core version from
`bud/browser-helper/package.json`, the Chrome for Testing build from that
package's `browsers.json`, the derived system-browser version floor, and
per-target URL/SHA-256/size/executable for every download. Streams and hashes
each artifact (Node cross-checked against nodejs.org `SHASUMS256.txt`);
`--check` verifies versions without downloading (run in the release workflow);
`--no-hash` scaffolds URLs without checksums for development.

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

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
