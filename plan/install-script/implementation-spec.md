# Implementation Spec: GitHub Releases + get.bud.dev Installer

**Status**: Draft
**Created**: 2026-05-30
**Parent Plan**: [install-script.spec.md](./install-script.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

Bud needs a one-command daemon install path:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

Landing-page copy can use the shorter root alias:

```bash
curl -fsSL https://get.bud.dev | sh
```

The broader daemon-readiness plan originally left artifact hosting open between
R2, S3, Render, and GitHub Releases. The current v1 decision is:

- GitHub Releases is the canonical immutable archive for versioned Bud daemon
  release assets.
- `https://get.bud.dev` remains the first-party product/install origin.
- A Cloudflare Worker on `get.bud.dev` serves `install.sh`, serves the stable
  manifest, and redirects versioned artifact URLs to GitHub Release asset URLs.
- The installer verifies SHA-256 from the stable manifest before installing.

This keeps the v1 implementation simple while preserving an escape hatch: the
manifest can later add R2/S3 mirror URLs or the Worker can switch
`get.bud.dev/releases/vX.Y.Z/...` from redirecting to GitHub to serving from a
first-party bucket without changing the install command.

## Objective

Ship the first production installer path for Bud without requiring Rust, Cargo,
`protoc`, or repo checkout on user machines.

The shipped path must:

- use immutable versioned GitHub Release assets as the artifact archive
- expose a stable first-party installer at `https://get.bud.dev/install.sh`
- expose the same installer at `https://get.bud.dev` for landing-page copy
- expose a stable manifest at `https://get.bud.dev/releases/stable/manifest.json`
- keep manifest artifact URLs first-party under `get.bud.dev`
- redirect first-party artifact URLs to exact versioned GitHub Release assets
- verify SHA-256 before installing
- preserve authenticated install claim propagation through `BUD_CLAIM_ID`
- avoid overwriting existing identities silently
- print local dependency remediation for missing `tmux`
- leave room for launchd/systemd service setup from the daemon-readiness plan

## Non-Goals

- R2/S3 artifact hosting in v1
- proxying release archive bytes through the Worker by default
- private GitHub Releases for public installer artifacts
- installing tmux automatically
- privileged/system-wide installation
- Homebrew formula
- notarization/code signing as a blocker for internal/beta validation

## Target Architecture

```text
GitHub Actions
  builds bud for target matrix
  packages archives + metadata
  creates immutable GitHub Release
  uploads:
    bud-aarch64-apple-darwin.tar.gz
    bud-x86_64-apple-darwin.tar.gz
    bud-x86_64-unknown-linux-gnu.tar.gz
    manifest.vX.Y.Z.json
    checksums.txt
  generates artifact attestations
  deploys/promotes get.bud.dev Worker config/assets

get.bud.dev Cloudflare Worker
  /
    -> static/generated installer shell script alias
  /install.sh
    -> static/generated installer shell script
  /releases/stable/manifest.json
    -> stable manifest pinned to promoted version
  /releases/vX.Y.Z/bud-*.tar.gz
    -> 302 to exact GitHub Release asset URL
  /releases/vX.Y.Z/manifest.json
    -> versioned manifest, optional redirect or Worker asset

install.sh
  detects OS/arch
  downloads manifest
  selects target artifact
  downloads first-party URL, following redirect to GitHub
  verifies SHA-256
  installs ~/.bud/bin/bud
  writes production config/env
  runs bud doctor
  starts foreground or user service depending phase support
```

## Manifest Contract

Stable manifest URL:

```text
https://get.bud.dev/releases/stable/manifest.json
```

Artifact URLs inside the manifest must be first-party and version-specific:

```json
{
  "version": "v0.1.0",
  "channel": "stable",
  "published_at": "2026-05-30T00:00:00Z",
  "artifacts": [
    {
      "target": "aarch64-apple-darwin",
      "url": "https://get.bud.dev/releases/v0.1.0/bud-aarch64-apple-darwin.tar.gz",
      "sha256": "...",
      "min_os": "macOS 13",
      "size": 12345678
    }
  ]
}
```

Do not put GitHub `latest` URLs in the manifest. The Worker can map first-party
versioned URLs to exact GitHub Release assets, but the installer should never
resolve "latest" while installing.

Future-compatible mirror shape:

```json
{
  "target": "x86_64-unknown-linux-gnu",
  "url": "https://get.bud.dev/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
  "sha256": "...",
  "mirrors": [
    "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz"
  ]
}
```

Mirrors are not required in v1; reserve the field only if we implement retry
semantics.

## GitHub Release Contract

Each released version must have a GitHub Release with:

- exact tag `vX.Y.Z`
- immutable release enabled where available
- all required target archives uploaded as release assets
- per-version manifest uploaded for audit/recovery
- checksums generated from uploaded artifacts
- artifact attestations generated in CI
- no asset overwrites after promotion

If a release is bad, publish `vX.Y.Z+1` or another semver-compatible follow-up
and repoint the stable manifest. Do not mutate versioned artifacts in place.

## Worker Contract

The Worker should be deliberately boring:

- `GET` / `HEAD` only
- no directory listing
- exact allowlist for known route families
- stable manifest response with short cache/revalidation
- mutable `/`, `/install.sh`, and stable manifest responses should run through
  the Worker before static assets and avoid edge/browser caching
- versioned artifact responses as 302 redirects to exact GitHub Release assets
- versioned artifact responses can use long browser/CDN cache headers because
  URLs are immutable
- `/` and `/install.sh` responses with
  `Content-Type: text/x-shellscript; charset=utf-8`
- no GitHub API call on normal installer requests
- optional operator-only endpoint or deploy-time asset for stable promotion

The first implementation can hard-code a generated release map into Worker
static assets/config at deploy time. Avoid fetching GitHub's API dynamically in
the install path because unauthenticated API requests are rate-limited and
because GitHub API availability should not affect manifest serving.

## Phase Overview

| Phase | Document | Outcome |
|-------|----------|---------|
| 1 | [phase-1-github-release-archive.md](./phase-1-github-release-archive.md) | GitHub Releases become the immutable artifact archive and CI uploads archives/checksums/attestations |
| 2 | [phase-2-get-bud-dev-worker.md](./phase-2-get-bud-dev-worker.md) | Cloudflare Worker serves installer/manifest and redirects versioned artifact URLs to GitHub |
| 3 | [phase-3-install-sh.md](./phase-3-install-sh.md) | `install.sh` installs verified target artifacts and hands off to daemon bootstrap |
| 4 | [phase-4-ci-publish-and-promotion.md](./phase-4-ci-publish-and-promotion.md) | CI publishes releases and promotes stable `get.bud.dev` assets predictably |
| 5 | [phase-5-validation-rollout-and-fallbacks.md](./phase-5-validation-rollout-and-fallbacks.md) | Clean-machine validation, rollback, GitHub-failure behavior, and future mirror plan are covered |
| 6 | [phase-6-root-installer-alias.md](./phase-6-root-installer-alias.md) | `https://get.bud.dev` serves the installer script directly for landing-page copy |

## Key Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub outage blocks new installs | High | `get.bud.dev` manifest stays up; add R2/S3 mirror if install availability matters more than v1 simplicity |
| GitHub asset URL changes after release | Medium | Worker maps first-party versioned URLs at promotion time; manifest uses first-party URLs only |
| `latest` race installs wrong artifact | High | Never use GitHub latest URLs in manifest or installer |
| GitHub API rate limits affect installs | Medium | Do not call GitHub API in normal Worker request path |
| Worker proxying archives gets expensive/slow | Medium | Redirect archive downloads by default |
| Corporate networks block GitHub downloads | Medium | Document this v1 limitation; add R2/S3 mirror if observed |
| Bad stable manifest published | High | Keep versioned manifests, validate before promotion, rollback by repointing stable |

## Sources Checked

- [GitHub immutable releases](https://docs.github.com/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub CLI `gh release upload`](https://cli.github.com/manual/gh_release_upload)
- [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains)
- [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers fetch/cache behavior](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
