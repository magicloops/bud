# Validation Checklist: GitHub Releases + get.bud.dev Installer

## Automated Gates

- [x] `pnpm test:bud-release`
- [x] `pnpm test:get-bud-dev`
- [x] `pnpm test:install-sh`
- [x] installer shell syntax tests
- [x] installer manifest fixture tests
- [x] installer checksum mismatch fixture test
- [x] installer artifact-download failure fixture test
- [x] `cargo test --manifest-path bud/Cargo.toml`
- [x] release workflow dry run for required target matrix

## GitHub Release Archive

- [x] release exists for test tag
- [x] all target archives are present
- [x] per-version manifest is present
- [x] `checksums.txt` is present
- [ ] downloaded archives match checksums
- [ ] release assets are not overwritten after promotion
- [ ] attestations exist or deferral is documented

## get.bud.dev Worker

- [x] `GET /install.sh` returns shell script
- [x] `HEAD /install.sh` returns expected headers
- [x] `GET /releases/stable/manifest.json` returns valid JSON
- [x] stable manifest artifact URLs use `get.bud.dev`
- [x] versioned artifact URL returns redirect to exact GitHub Release asset
- [x] unknown path returns `404`
- [x] unsupported method returns `405`
- [x] Worker does not require GitHub API access at runtime

## Installer

- [x] macOS arm64 target maps to `aarch64-apple-darwin`
- [x] macOS x86_64 target maps to `x86_64-apple-darwin`
- [x] Ubuntu x86_64 target maps to `x86_64-unknown-linux-gnu`
- [x] unsupported OS/arch fails before download
- [x] malformed manifest fails closed
- [x] missing target fails closed
- [x] checksum mismatch fails before extraction
- [x] install writes `~/.bud/bin/bud`
- [ ] `bud --version` works after install
- [x] existing identity is not overwritten
- [x] `BUD_CLAIM_ID` is passed to first bootstrap and not persisted
- [ ] tokenless install falls back to QR/link claim

## Clean-Machine Matrix

- [ ] macOS 13+ arm64 public install
- [ ] macOS 13+ arm64 authenticated claim install
- [ ] macOS 13+ x86_64 public install
- [ ] macOS 13+ x86_64 authenticated claim install
- [ ] Ubuntu 22.04 x86_64 public install
- [ ] Ubuntu 22.04 x86_64 authenticated claim install
- [ ] Ubuntu 24.04 x86_64 public install
- [ ] Ubuntu 24.04 x86_64 authenticated claim install

## Failure And Recovery

- [x] GitHub Release download failure leaves no partial current binary in installer fixture
- [ ] Cloudflare Worker rollback restores previous stable manifest
- [ ] stable promotion can repoint to previous known-good release
- [ ] missing tmux output gives OS-specific remediation
- [ ] support/debug output includes version, target, and failed URL family

## Documentation

- [ ] public install command matches `get.bud.dev/install.sh`
- [x] authenticated command shape matches service response
- [ ] supported target matrix documented
- [ ] GitHub Releases as canonical archive documented
- [ ] GitHub outage/mirror limitation documented
- [x] rollback procedure documented
