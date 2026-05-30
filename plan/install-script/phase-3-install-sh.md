# Phase 3: install.sh

## Objective

Implement the public installer script served at:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

and the authenticated variant returned by the service:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

## Installer Responsibilities

1. Detect OS and architecture.
2. Map the host to a supported Bud release target.
3. Download `https://get.bud.dev/releases/stable/manifest.json`.
4. Select the matching target artifact.
5. Download the archive from the manifest URL, following the Worker redirect to
   GitHub Releases.
6. Verify SHA-256 before extraction.
7. Install `bud` to `~/.bud/bin/bud`.
8. Preserve existing identity/config unless the user explicitly opts into a
   future reclaim/overwrite flow.
9. Write production daemon config/env:
   - `BUD_SERVER_URL=wss://api.bud.dev/ws`
   - `BUD_TERMINAL_ENABLED=true`
   - optional `BUD_CLAIM_ID` propagation only for the first bootstrap run
10. Run `bud doctor` and print missing dependency remediation.
11. Start foreground or delegate to user-service setup depending available
    Phase 4 daemon-readiness work.

## Supported Target Mapping

| OS | Arch | Target |
|----|------|--------|
| macOS 13+ | arm64 | `aarch64-apple-darwin` |
| macOS 13+ | x86_64 | `x86_64-apple-darwin` |
| Linux glibc 2.35+ | x86_64 | `x86_64-unknown-linux-gnu` |

Unsupported hosts should fail before downloading archives and print the
supported matrix.

## Dependency Policy

The installer does not install tmux. It should:

- run `bud doctor` after installing the binary
- surface OS-specific tmux remediation text from the daemon
- avoid reporting a fully healthy terminal setup while tmux is missing
- allow users to rerun the installer after installing tmux

## Existing Identity Policy

If `~/.bud/identity.json` exists:

- do not overwrite it
- do not redeem a new `BUD_CLAIM_ID` over it silently
- explain that Bud is already installed/claimed
- proceed with binary upgrade only if config/identity policy is compatible

If only `~/.bud/installation-id` exists:

- preserve it
- allow normal device claim/bootstrap to reuse the installation id

## Service Bootstrap Policy

If `BUD_CLAIM_ID` is present:

- pass it only to the first `bud` bootstrap invocation
- do not persist the claim id in long-lived config
- after successful claim, future service starts should rely on persisted
  identity

If no `BUD_CLAIM_ID` is present:

- use normal QR/link browser claim fallback

## Implementation Areas

- `deploy/get-bud-dev/assets/install.sh` or equivalent Worker static asset
- installer fixture tests under `scripts/` or `deploy/get-bud-dev/`
- update `deploy/get-bud-dev/release-hosting.md`
- update daemon-readiness Phase 4 checklist as installer pieces land

## Test Plan

- Shell syntax check (`bash -n`, `sh -n`, and shellcheck if available).
- Unit/fixture tests for OS/arch mapping.
- Manifest fixture selects correct artifact.
- Checksum mismatch fixture aborts before install.
- Existing identity fixture refuses destructive claim overwrite.
- Missing tmux fixture prints remediation after installing binary.
- Authenticated install fixture passes `BUD_CLAIM_ID` to bootstrap without
  persisting it.

## Exit Criteria

- [x] `install.sh` source exists
- [x] OS/arch detection implemented
- [x] manifest target selection implemented
- [x] archive download follows first-party URL redirect
- [x] SHA-256 verification implemented
- [x] `~/.bud/bin/bud` install path implemented
- [x] existing identity is preserved
- [x] claim id is not persisted after bootstrap
- [x] missing tmux output is clear
- [x] installer fixture tests pass
