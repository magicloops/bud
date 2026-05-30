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
- verify archive SHA-256 values for installer checksum tests

### `bud-release.test.mjs`

Node test coverage for artifact packaging, manifest generation, platform
selection, and checksum mismatch rejection.

## Subfolders

### `fixtures/bud-release/`

Release-manifest fixtures used by `bud-release.test.mjs`, including a deliberate
checksum mismatch fixture.

## Dependencies

- Node.js 20+
- host `tar` command for archive creation and archive-content tests

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
