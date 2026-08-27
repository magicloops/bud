# Plan: dev-build upgrade guard + git-describe dev version string

## Context
- From [design/dev-install-parity-and-multi-instance.md](../design/dev-install-parity-and-multi-instance.md)
  §2.3 (hazards 1–2) and the v0.1.9 tagging follow-up discussion.
- Related specs: `bud/src/src.spec.md` (version.rs / upgrade.rs / lifecycle.rs
  entries), `bud/bud.spec.md` if it mentions upgrade behavior.
- Today: any non-CI binary reports `v0.1.0` (crate version fallback);
  "update available" means *differs from stable*, so `bud upgrade` on a dev
  build replaces it with the stable release, and `bud status` on a dev build
  permanently nags "update available". Dev builds also print
  `commit unknown … profile unknown` — everything but the commit, which
  `build.rs` already recovers via `git rev-parse`.

## Objective
1. **Guard**: `bud upgrade` refuses to overwrite a non-release binary.
   Acceptance: on a dev build, `bud upgrade` exits non-zero with a message
   naming the build string and the stable version it refused, and suggests
   `--force`; `bud upgrade --force` proceeds; release binaries (baked
   `BUD_BUILD_VERSION`) behave exactly as today, including
   rollback-as-update.
2. **Version string**: dev builds identify themselves precisely.
   Acceptance: a local build prints
   `bud v0.1.9-14-g1845b9b-dirty (commit …, target …, profile debug)`
   (from `git describe --tags --dirty`); a build outside a git checkout
   (vendored source, tarball) still compiles and falls back to
   `v<crate>-dev`; release binaries are byte-identical in behavior (CI env
   vars still win).

## Design

### A. Version string (build.rs — extend, don't replace)
`bud/build.rs` already emits `BUD_BUILD_COMMIT`/`TARGET`/`PROFILE` with a
`git rev-parse` fallback and `rerun-if-changed=../.git/HEAD`. Add:
- `git_describe()` → `git describe --tags --always --dirty` (same
  Command/error-tolerant shape as `git_commit()`).
- Emit `cargo:rustc-env=BUD_BUILD_DESCRIBE=<describe>` only when git
  succeeds; also `rerun-if-env-changed=BUD_BUILD_VERSION` and
  `rerun-if-changed=../.git/refs/tags` (best-effort freshness; a stale
  describe after tagging without rebuilding is acceptable and documented).
- `version.rs`:
  - new `is_release_build() -> bool` = `option_env!("BUD_BUILD_VERSION").is_some()`.
  - `release_version()` unchanged for release builds; the **fallback**
    becomes `BUD_BUILD_DESCRIBE` when present, else
    `concat!("v", crate_version, "-dev")`. NOTE: `upgrade::update_available`
    compares normalized strings, so a dev build now *always* differs from
    stable — harmless because the guard (B) gates the destructive path, and
    `bud status` (C) stops nagging.
  - `build_profile()` already reports `debug`/`release` via build.rs PROFILE.

### B. Upgrade guard (upgrade.rs + config.rs)
- `UpgradeArgs` gains `#[arg(long)] force: bool` ("Replace a non-release
  (dev) build with the stable release").
- `run_upgrade(paths, check_only, force)`: after fetching the manifest,
  when `!version::is_release_build()`:
  - `--check`: print "dev build (<version line>); stable is <v>. Dev builds
    are not auto-upgraded." and return Ok.
  - without `--force`: bail with the same explanation + the `--force` hint
    (exit non-zero via anyhow error — consistent with other failures).
  - with `--force`: proceed (log that a dev build is being replaced).
- The daemon-side auto paths (none exist — upgrade is CLI-only) need no
  change; `lifecycle.rs` `status()` is the only other caller of
  `update_available`.

### C. `bud status` on dev builds (lifecycle.rs)
Replace the unconditional update check with:
- release build: exactly today's behavior.
- dev build: `version: <describe string> (dev build; upgrades disabled — use
  bud upgrade --force to replace with stable)` and **skip** the manifest
  fetch (no network nag from dev builds).

## Impacted Contracts
- None on the wire. CLI-only behavior; release binaries unchanged.
- Installer unaffected (always installs CI artifacts).

## Test Plan
- `version.rs`: fallback shape when `BUD_BUILD_VERSION` absent
  (compile-time env makes direct unit-testing awkward — test the pure
  helpers: `is_release_build` gets a test only via cfg; prefer testing
  guard logic through a `run_upgrade`-level seam that takes
  `is_release: bool`).
- `upgrade.rs`: factor the decision into
  `upgrade_gate(is_release, check_only, force) -> Gate` (pure) with unit
  tests: dev+no-force → refuse, dev+force → proceed, dev+check → report,
  release → proceed; existing `update_available` tests unchanged.
- Manual: `cargo build` → `bud --version` shows describe string;
  `bud upgrade` refuses; `--force` overwrites into the dev base dir;
  `bud status` shows the dev line without a manifest fetch.
- Build hermeticity: `cargo build` in a source tree with `.git` removed
  (or `GIT_DIR` unset) still succeeds and yields `v0.1.0-dev`.

## Rollout / Notes
- Ship in the next daemon release; no ordering constraints.
- The "bump Cargo.toml at tag time" idea is explicitly NOT adopted
  (protection lapses after every release; misleading version claims) —
  recorded here so it stays decided.
- Docs: `design/dev-install-parity-and-multi-instance.md` §2.3 gets a
  "shipped" note when this lands; `bud/src/src.spec.md` entries for
  `version.rs`/`upgrade.rs`/`lifecycle.rs`/`build.rs`.

## Estimate
~2–3 hours including tests and a manual drill.

## Status
Implemented 2026-08-27. Drill results: dev build reports
`v0.1.9-0-g1845b9b-dirty` (describe switched to `--long` so an on-tag dev
build can never display as a bare release tag); `bud upgrade` refuses with
exit 1; `--check` reports; `--force` replaces (verified live — it replaced
the drill binary with stable v0.1.9, which is precisely the hazard the
guard closes); `bud status` prints the dev line with no manifest fetch.
