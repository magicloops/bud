# install-script

Implementation plan for the `https://get.bud.dev` installer path using GitHub
Releases as the canonical immutable release archive and a Cloudflare Worker as
the first-party install/manifest front door.

## Purpose

This folder scopes the first production installer implementation separately
from the broader daemon-readiness plan. It starts with the simplest reliable
release channel:

- GitHub Releases owns immutable versioned daemon artifacts.
- GitHub Actions builds, packages, uploads, and attests artifacts.
- `get.bud.dev` is a Cloudflare Worker custom domain.
- The Worker serves `install.sh` and the stable manifest.
- Versioned `get.bud.dev/releases/...` artifact URLs redirect to GitHub Release
  assets so the installer keeps a first-party manifest contract while avoiding
  Worker byte-proxying.

## Files

### `implementation-spec.md`

Parent implementation spec covering the product contract, target architecture,
non-goals, release/installer shape, risks, and phase overview.

### `phase-1-github-release-archive.md`

Phase for making GitHub Releases the canonical immutable artifact archive:
release creation, asset upload, checksums, attestations, and manifest source
metadata.

### `phase-2-get-bud-dev-worker.md`

Phase for adding the Cloudflare Worker front door for `get.bud.dev`, including
installer and manifest serving, first-party artifact URLs, redirects to GitHub
Release assets, and caching behavior.

### `phase-3-install-sh.md`

Phase for implementing `install.sh`: OS/arch detection, manifest selection,
download, checksum verification, install root, existing identity policy, and
daemon bootstrap handoff.

### `phase-4-ci-publish-and-promotion.md`

Phase for wiring CI release publication and promotion: GitHub Release asset
upload, manifest generation, Worker deployment, stable-channel promotion, and
rollback.

### `phase-5-validation-rollout-and-fallbacks.md`

Phase for validation, rollout, and fallback planning, including clean-machine
tests, GitHub availability failure modes, and the later R2/S3 mirror escape
hatch.

### `progress-checklist.md`

Running implementation checklist for this install-script plan.

### `validation-checklist.md`

Release-gate validation checklist focused on GitHub Release artifacts,
`get.bud.dev`, installer behavior, and failure handling.

## Dependencies

- [../daemon-readiness/implementation-spec.md](../daemon-readiness/implementation-spec.md)
- [../daemon-readiness/phase-3-release-artifacts-and-manifest.md](../daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../daemon-readiness/phase-4-installer-preflight-and-user-service.md](../daemon-readiness/phase-4-installer-preflight-and-user-service.md)
- [../../design/release-artifact-hosting-r2-vs-s3.md](../../design/release-artifact-hosting-r2-vs-s3.md)
- [../../deploy/get-bud-dev/release-hosting.md](../../deploy/get-bud-dev/release-hosting.md)
- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan deliberately starts with GitHub Releases as the only archive origin.
  If GitHub availability becomes an install blocker, add an R2 or S3 mirror and
  teach the manifest/installer to retry mirrors after checksum or transport
  failure.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
