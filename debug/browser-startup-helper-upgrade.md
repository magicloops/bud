# Debug: Browser helper upgrades require manual preparation

## Environment

macOS arm64 development daemon; Phase 7d of the browser REPL plan.
No service, protocol or database changes are needed.

## Reproduction and observations

1. Enable browsing with `bud browser prepare`.
2. Rebuild Bud after changing a bundled helper source without preparing again.
3. Startup resolves the old manifest through `addon::resolve_manifest`, which
   rejects a different helper digest before the readiness probe runs.

The replacement archive is already embedded in the binary. The CLI installer
checks only `main.mjs` and Playwright's package file, missing absent REPL modules.
Startup and the CLI currently lack a shared installation lock. Doctor calls the
manager startup method, so adding mutation there also requires keeping doctor
on a read-only resolution/probe path.

## Expected / approach

An existing valid manifest is opt-in. Reconcile its helper against the embedded
archive under a stable base-directory lock, using existing Node and Chrome.
Probe the semantic helper and REPL in disposable processes, then atomically
commit. Missing/invalid manifests, failed probes and failed writes never enable
or replace the prior configuration. Keep old bundle directories untouched.
CLI prepare/remove use the same lock and release it before offering a restart.

## Validation

Implemented in `addon.rs`, manager startup, CLI locking and read-only doctor.
Validation uses temporary base directories and disposable Chrome profiles.

- `cargo test --lib browser::addon::tests -- --test-threads=1` from `bud/`:
  20 passing (one env-gated live fixture skipped in this invocation). Covers
  upgrades/reuse/repair/downgrade, failed prior probes, no manifest/corrupt manifest,
  dev selections, missing Node, permissions, incomplete/interrupted staging,
  content identity and lock contention/removal. Old cache files and profile
  sentinels survive; failed validation/commit preserves the old manifest.
- `cargo test --lib startup_failure_returns_an_unavailable_manager_without_aborting_daemon_setup`:
  passes; startup returns normally with browser unavailable, rather than aborting
  daemon initialization. Terminal code and transport initialization are unchanged.
- `cargo test --lib doctor::tests`: 11 passing.
- Real fixture: `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  BUD_BROWSER_NODE='/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node'
  cargo test --lib browser::addon::tests::live_startup_validates_packaged_semantic_and_repl_helpers_once -- --nocapture`:
  passes. It upgrades a managed manifest, probes the extracted semantic/REPL helper,
  executes a REPL cell, repeats startup and proves one retained cache directory
  and no persistent profile tree. Installed Chrome reports 153.0.8010.53.
- `cargo build`: passes. Changed Rust files formatted; `git diff --check` clean.

### Validation failures investigated

- Initial command accidentally ran `cargo test --lib browser::addon::tests -- --test-threads=1`
  at the repository root: `could not find Cargo.toml in /Users/adam/bud or any parent directory`.
  Corrected to the Rust package directory; no code issue.
- First live fixture selected cached Playwright Chromium 151.0.7922.34 and correctly
  failed `below the supported floor (Chromium 153 ... playwright-core 1.63.0)`.
  Retested using already-installed Chrome 153; no downloads or weakened floor.
- `cargo clippy --lib -- -D warnings` found the existing `clippy::question_mark`
  suggestion in `repl.rs:211`. Applied its equivalent `self.trace.take()?` form;
  rerun passed with warnings denied.

### Boundaries / remaining acceptance

No user daemon, service, manifest, Chrome profile, or sign-in was restarted or
modified. Linux, physical power-loss/disk-exhaustion and a full service/terminal
connection under failed preparation were not exercised. Permission/commit failure,
interrupted staging and manager initialization are covered locally. Phase 8 retains
cross-device/product acceptance. Startup waits at most 15 seconds for blocking
preparation and 30 seconds for probe I/O; a timed-out extraction task can finish
its cache but has no path to commit the manifest. No automatic cache GC.
