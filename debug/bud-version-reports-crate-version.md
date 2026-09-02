# Debug: Bud settings modal shows daemon version `0.1.0` for a v0.1.18 daemon

## Environment
- Daemon: release build v0.1.18 (`bud upgrade` → "Bud is up to date (v0.1.18)")
- Service/web: `main` (Bud settings modal, Device tab)

## Repro Steps
1. Open the Bud settings modal → Device tab for any connected bud.
2. "Daemon version" reads `0.1.0` regardless of the installed release.

## Observed
- The modal renders `bud.version` from `GET /api/buds`, which the service
  refreshes on every `hello` (`service/src/ws/bud-connection.ts:549`,
  `grpc/control-gateway.ts:450`) and sets at claim (`routes/device-auth.ts`).
  The service side is faithful to what the daemon sends.
- The daemon sends `env!("CARGO_PKG_VERSION")` in both places it identifies
  itself: the `hello` frame (`bud/src/app.rs`, `build_hello_frame`) and the
  device-claim request (`bud/src/claim.rs`). `bud/Cargo.toml` is `0.1.0` and
  is not bumped per release, so every daemon reports `0.1.0`.
- The release identity lives in `bud/src/version.rs::release_version()`
  (`BUD_BUILD_VERSION` baked by the release pipeline → `v0.1.18`, or a
  `git describe` for dev builds). `bud --version` and `bud upgrade` use it;
  the wire frames did not.

## Expected
- `bud.version` (and the modal) match `bud --version` on the box.

## Hypotheses
- Root cause (confirmed by code read): wrong version source in the two wire
  frames; no staleness or caching involved.

## Proposed Fix
- Send `crate::version::release_version()` in `build_hello_frame` and the
  claim request. Plain string in an existing optional field → deploy-order
  independent; takes effect per box after a daemon release + `bud upgrade`.
- Dev builds then report their `git describe` (e.g. `v0.1.9-14-g1845b9b-dirty`)
  instead of `0.1.0`, which is more useful in the UI.

## Resolution (2026-09-02)
Applied as proposed. `cargo build`, `cargo test` (all suites), and
`cargo clippy --all-targets` clean. `docs/proto.md` hello examples and the
`version` field note updated; `bud/src/src.spec.md` (`claim.rs`,
`version.rs`) updated.

## Spec files affected
- `bud/src/src.spec.md`
- `docs/proto.md`
