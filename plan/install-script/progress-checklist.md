# Progress Checklist: GitHub Releases + get.bud.dev Installer

## Phase 1: GitHub Release Archive

- [x] GitHub Release publication workflow added
- [x] required target archives upload as release assets
- [x] `checksums.txt` generated and uploaded
- [x] per-version manifest generated and uploaded
- [x] artifact attestations generated or explicitly deferred
- [x] release immutability policy configured
- [x] release notes include target matrix and commit SHA

## Phase 2: get.bud.dev Worker

- [x] Worker source added
- [x] Worker config added
- [x] `get.bud.dev` custom domain attached
- [x] `/install.sh` served
- [x] `/releases/stable/manifest.json` served
- [x] versioned artifact URLs redirect to GitHub Release assets
- [x] method/path guardrails implemented
- [x] Worker tests added

## Phase 3: install.sh

- [x] installer source added
- [x] OS/arch target detection added
- [x] stable manifest download added
- [x] target artifact selection added
- [x] archive download follows first-party redirect
- [x] SHA-256 verification added
- [x] `~/.bud/bin/bud` install path added
- [x] existing identity preservation added
- [x] `BUD_CLAIM_ID` one-time bootstrap handling added
- [x] `bud doctor` preflight/remediation integrated
- [x] installer fixture tests added

## Phase 4: CI Publish And Promotion

- [x] CI creates GitHub Releases from tags or manual dispatch
- [x] CI uploads assets/checksums/manifests
- [x] CI generates Worker release map
- [x] stable promotion workflow added
- [x] Worker deploy step added
- [x] post-deploy smoke checks added
- [x] rollback promotion path documented
- [ ] rollback promotion validated against deployed Worker
- [x] required secrets and permissions documented

## Phase 5: Validation, Rollout, And Fallbacks

- [ ] macOS arm64 clean-machine install passes
- [ ] macOS x86_64 clean-machine install passes
- [ ] Ubuntu 22.04 x86_64 clean-machine install passes
- [ ] Ubuntu 24.04 x86_64 clean-machine install passes
- [ ] public tokenless install passes
- [ ] authenticated claim install passes
- [ ] GitHub unavailable failure mode validated
- [ ] checksum mismatch failure mode validated
- [ ] bad manifest failure mode validated
- [ ] stable rollback validated
- [ ] mirror decision made before public launch

## Phase 6: Root Installer Alias

- [x] Worker serves `/` as installer alias
- [x] Worker tests cover `GET /`
- [x] Worker tests cover `HEAD /`
- [x] `/install.sh` remains supported
- [x] service-generated commands remain on `/install.sh`
- [ ] live promoted Worker validates root alias behavior
