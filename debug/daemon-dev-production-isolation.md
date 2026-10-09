# Debug: Development and production daemon isolation

## Environment

October 8, 2026, macOS development checkout. Rust tests use temporary state and fake service managers; no installed service or account was modified. No DB, LLM or live backend is needed for these checks.

Related: [implementation plan](../plan/daemon-dev-production-isolation.md), [production takeover investigation](./render-browser-takeover-control-expiry.md).

## Repro Steps

1. Source legacy development settings with identity and terminal paths pointing at `~/.bud`.
2. Select a different base and run Cargo or browser/lifecycle commands.
3. Previously, explicit inherited paths could retain production state, while fixed service labels could target the installed production service.

## Observed

Configuration and lifecycle inspection confirmed both conflicts. Browser profile roots already derive from the selected base; the browser executable can be shared safely while user-data roots remain separate.

## Expected

Production uses `~/.bud`; checkout development uses `~/.bud-dev`, independently claimed. Commands for either instance must leave the other intact.

## Fix

Implemented sourceable `dev/daemon-env.sh` setup for direct Cargo execution, canonical instance/service identities, daemon/state-root singleton locks, backend-origin identity checks, explicit child base forwarding, managed environment isolation, scoped status and foreground restart guidance. Installer backend overrides use `BUD_INSTALL_SERVER_URL` rather than inheriting the development daemon's server setting. Updated daemon, developer tooling, installer and test specs.

No credentials or profiles are copied. Switching a claimed development base between HTTP and HTTPS origins requires a separate independently claimed base. Live coexistence and production takeover reproduction remain in Phase 3.

## Validation

- `node --test dev/daemon-env.test.mjs deploy/get-bud-dev/install-sh.test.mjs`: 25 passed, including Bash/Zsh sourcing and installer environment isolation.
- `cargo test --manifest-path bud/Cargo.toml --test instance --test doctor --test term_hold --test terminal_stem`: 35 passed. Covers real CLI configuration precedence, identity refusal, fake-manager lifecycle ownership boundaries and persistent terminals.
- `cargo test --manifest-path bud/Cargo.toml --lib -- --test-threads=1`: 226 passed, 11 ignored.
- `cargo clippy --manifest-path bud/Cargo.toml --all-targets`: completed; warning about a test mutex held across await in unchanged `browser/manager.rs`.

The first parallel `cargo test --manifest-path bud/Cargo.toml --lib` run reported `browser_profile_in_use` at `browser/addon.rs:1568` and `browser/profile.rs:345`; 223 passed, 2 failed, 11 ignored. Both failures occur in unchanged browser profile-lock tests and pass in the full serial run. Concurrent process spawning temporarily inheriting lock descriptors before exec is a hypothesis, not a confirmed cause. Browser runtime code was not changed to suppress these failures.

Remaining acceptance: actual installed production plus checkout development, distinct claims/sign-ins, restart/upgrade interactions, and Linux service execution. Automated service-manager fixtures do not prove those live scenarios.

## Authorized local migration — October 9, 2026

The user requested moving the previous development state into `~/.bud-dev`. Confirmed the source identity is `b_01KM54M7SYPC7GZX0SWBKFE5YP`, with local HTTP backend; the destination had a newly claimed development identity. There is no installed Bud launch agent on this machine.

Backed up both roots under `/Users/adam/.bud-migration-backup-20261009T071541Z` (private directory; socket endpoints excluded). Stopped only the destination foreground daemon after verifying its lock owner and exact process command. Migrated the original identity, installation ID, session journals, browser runtime/helper and browser profiles; rewrote the manifest's runtime/helper paths for the new root. Updated the identity and selected environment to local HTTPS: the checked-in Caddy `/ws` route forwards localhost:3443 to the same localhost:3000 service. Preserved the displaced identity separately in the backup.

The user explicitly approved closing the eight persistent terminal shells and migrating all saved state. Verified each holder process against its exact session directory, sent SIGTERM to those holders only, and confirmed all exited. Moved 70 terminal directories; SHA-256 checks confirmed all 70 output rings match the post-shutdown backup. Shell memory/jobs were intentionally ended; saved output remains backed up. Shim files contained no old terminal path requiring rewriting. The old root now contains only its binary, production-oriented environment file and inert browser lock files; no development credentials, profiles or terminal state remain there. Production installation and duplicate Bud record removal are not part of this operation.

The final terminal backup initially failed because old Unix sockets cannot be copied (`shutil.copytree`: `Errno 102 Operation not supported on socket`). Repeated with socket entries excluded, preserving all regular state files; the directory move and ring checks then succeeded. No daemon auto-restart was performed. `bud status` confirms the original identity under the new base and matching local HTTPS endpoint. Existing terminal sessions may open fresh shells after restart; the daemon may garbage-collect dead-holder directories, so the independent backup is the durable copy of their old local rings.

October 9 user acceptance: the user reports this works as expected after migration. Individual production claim/browser sign-in, lifecycle/upgrade and Linux scenarios were not separately reported, so those detailed checks remain open rather than inferred complete.
