# Phase 1: GitHub Release Archive

## Objective

Make GitHub Releases the canonical immutable archive for versioned Bud daemon
artifacts.

## Scope

- Extend the existing daemon release workflow to create/update a GitHub Release.
- Upload all target archives as release assets.
- Upload a per-version manifest and checksum file.
- Generate artifact attestations from CI outputs.
- Keep GitHub Release assets immutable after promotion.

## Required Assets

For tag `vX.Y.Z`:

```text
bud-aarch64-apple-darwin.tar.gz
bud-x86_64-apple-darwin.tar.gz
bud-x86_64-unknown-linux-gnu.tar.gz
manifest.vX.Y.Z.json
checksums.txt
```

Optional after first pass:

```text
bud-aarch64-apple-darwin.tar.gz.intoto.jsonl
bud-x86_64-apple-darwin.tar.gz.intoto.jsonl
bud-x86_64-unknown-linux-gnu.tar.gz.intoto.jsonl
```

Use GitHub artifact attestations if available in the repo plan. Do not block
internal validation on attestation verification in the installer; installer v1
trust is TLS + SHA-256 from the stable manifest.

## Implementation Notes

- Build artifacts through the existing `bud-release.yml` target matrix.
- Keep `BUD_BUILD_COMMIT` and `BUD_BUILD_TARGET` in release builds so
  `bud --version` is inspectable after install.
- Generate checksums from final `.tar.gz` files after packaging.
- Create the GitHub Release only from tags or explicit manual workflow dispatch.
- Use `gh release create` for new releases and `gh release upload` for assets.
- Required GitHub Actions permission: `contents: write` for release asset upload.
- Required GitHub Actions permission for attestations, if enabled:
  `attestations: write` and `id-token: write`.
- Attestations are opt-in for now through the manual workflow input or
  `ENABLE_RELEASE_ATTESTATIONS=true`, because GitHub's current availability
  rules depend on repository visibility/plan. This is an explicit deferral, not
  part of installer trust in v1.
- Keep release notes minimal for v1, but include target matrix and commit SHA.

## Guardrails

- Do not reference GitHub `latest` release URLs in generated manifests.
- Do not overwrite assets in a promoted release.
- Do not publish from an unclean manual local machine.
- If a published asset is wrong, publish a new version and repoint stable.
- If immutable releases are available for the repo, enable them before public
  launch.
- The workflow refuses to publish over an existing release; repository-level
  immutable releases must still be enabled in GitHub settings before broad
  public launch.

## Spec Files To Update

- [../../.github/workflows/workflows.spec.md](../../.github/workflows/workflows.spec.md)
- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../daemon-readiness/phase-3-release-artifacts-and-manifest.md)

## Test Plan

- Dry-run workflow on a non-stable tag or manual `canary` channel.
- Confirm every required asset exists in the GitHub Release.
- Download each asset from GitHub and verify `checksums.txt`.
- Confirm `bud --version` reports tag version, commit, target, and release
  profile.
- Confirm manifest artifact URLs are first-party `get.bud.dev` URLs, not GitHub
  latest URLs.

## Exit Criteria

- [ ] GitHub Release is created from CI for a test tag
- [ ] required target archives upload as release assets
- [ ] per-version manifest uploads as release asset
- [ ] checksums upload as release asset
- [ ] artifact attestations are generated or explicitly deferred
- [ ] assets are immutable after promotion
- [ ] release notes include commit and target matrix
