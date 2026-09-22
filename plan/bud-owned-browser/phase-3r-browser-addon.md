# Phase 3r: Browser support as a daemon add-on

Status: implemented locally (daemon, CLI, pins, embedded helper, docs); macOS system-Chrome and managed-download paths exercised; Ubuntu and release-build acceptance pending. Updated 2026-09-21.

## Context

- Design: [browser add-on](../../design/browser-addon.md).
- Review finding: [packaging gap](../../review/bud-owned-browser-branch-review.md)
  (no Chrome discovery, compile-time helper path, host Node requirement).
- Related plans: [Phase 1](phase-1-agent-browser.md),
  [Phase 3o Ubuntu](phase-3o-ubuntu-headed-browser.md),
  [Phase 4 release validation](phases.md#phase-4--release-validation-and-cleanup).
- Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
  [helper](../../bud/browser-helper/browser-helper.spec.md),
  [daemon source](../../bud/src/src.spec.md),
  [release workflow](../../.github/workflows/workflows.spec.md).

Today a released daemon cannot run the browser feature: it needs an env var
pointing at a browser, a Node 22 runtime on the host, an `npm ci` in a source
checkout, and a helper path that is baked in at compile time. The user
direction is: keep the daemon light by default, prefer an installed system
browser, install a dedicated browser only as plan B, CLI only for now, and keep
moving on Linux while tracking what is left.

## Objective

A user on a released daemon can run one command to prepare browser support,
see its status, and remove it. The daemon advertises the browser capability
only when preparation succeeded. A system Chrome, Chromium, Edge, or Brave is
used when present; a verified managed Chromium is installed only when nothing
suitable exists or the user asks. Nothing depends on a source checkout or the
host's Node.

Acceptance:

- Fresh macOS machine with Chrome installed: `bud browser prepare` → daemon
  advertises the browser, agent can open a page, no env vars set.
- Fresh macOS machine without Chrome: `prepare` reports nothing found, offers
  the managed download, installs and probes it, then the same as above.
- Ubuntu x64 without Chrome: `prepare --managed` installs, probes, and reports
  the secure-storage and sandbox caveats; `status` and `doctor` agree with what
  the daemon will actually do.
- `bud browser remove` leaves a light daemon with no browser capability and no
  downloaded runtime; profiles are untouched unless asked.
- A source checkout keeps working through `--helper-dir`/`--node` overrides.

## Design / Approach

See the design doc for the layout, manifest, detection table, and CLI. Work
items in order:

1. **Manifest and pinned-version table** (`bud/src/browser/addon.rs`).
   Types, atomic write, read with schema check, staleness detection against the
   running daemon version. Pinned Node version and SHA-256, helper version and
   SHA-256, managed browser build ids and SHA-256 per target.
2. **Daemon reads the manifest.** `BrowserManager::configured_for` resolves
   executable, Node, and helper from the manifest; env vars become logged
   development overrides. `semantic.rs` drops `CARGO_MANIFEST_DIR` and `PATH`
   lookup. Capability `hello` adds `browser.runtime`.
3. **Detection and probe.** Per-OS candidate list, snap exclusion, version
   floor, probe through the real launch path, structured failure reasons
   (present-but-unusable versus absent).
4. **Managed downloads.** Node tarball, helper tarball, managed Chromium from
   Playwright builds (default) or Chrome for Testing. HTTPS, pinned hashes,
   extract-then-probe, nothing left behind on failure.
5. **CLI.** `bud browser prepare|status|remove` in `bud/src/config.rs`
   (`BudCommand`) and a new `bud/src/browser_cli.rs`; `doctor.rs` reads the
   manifest and replaces the env-var advice.
6. **Release workflow.** `scripts/bud-release.mjs` packages
   `bud-browser-helper-<version>.tar.gz` with vendored `node_modules`; the
   release manifest and checksums list it; the daemon's pinned table is
   generated from the same build.
7. **Version drift.** Launch records the browser version; mismatch triggers a
   re-probe and manifest update; a persistent launch never carries the
   mock-keychain flags (test).
8. **Docs.** Specs listed below, `docs/proto.md` for the additive capability
   field, `DAEMON_INSTALLER_FOLLOW_UP_HANDOFF.md` or its successor for the
   installer story.

Risks and mitigations:

- System browser updates under a running daemon → existing exited-process
  recovery plus drift re-probe; documented as expected behaviour.
- Enterprise-managed Chrome refuses debugging → probe failure is reported as
  present-but-unusable with the error; managed download is offered.
- Download tampering → hashes pinned in the binary, no "latest" resolution.
- Linux sandbox and secure storage → not solved here; reported honestly and
  tracked below.

## Spec Files to Update

- [x] `bud/src/browser/browser.spec.md` (add `addon.rs`, manifest, version floor, drift)
- [x] `bud/src/src.spec.md` (new CLI module, doctor change)
- [x] `bud/browser-helper/browser-helper.spec.md` (embedded helper, no host npm)
- [x] `bud.spec.md` (add-on directory under base dir)
- [x] `.github/workflows/workflows.spec.md` and `scripts/scripts.spec.md` (helper vendoring step, pin generator)
- [x] `docs/proto.md` (`capabilities.browser.runtime`)
- [x] `plan/bud-owned-browser/phases.md` status row

## Impacted Contracts

- [x] WSS protocol: additive `capabilities.browser.runtime` only
- [ ] SSE events: none
- [ ] DB schema: none
- [ ] Agent tools: none (catalog gating unchanged)
- [ ] Web UI: none in this phase; hint is a follow-up

## Test Plan

- Unit: manifest round-trip and atomic write; staleness; detection candidate
  ordering with a fake filesystem; snap path rejection; version floor parsing;
  hash verification failure leaves no files; drift re-probe updates only the
  allowed fields; persistent launch flag set excludes mock keychain.
- Integration (env-gated, real browser): `prepare` with `--browser` pointing at
  system Chrome then daemon capability true; `prepare --managed` on macOS and
  Linux runners; `remove` then capability false.
- Doctor: JSON output includes the manifest summary and Linux caveats.
- Existing browser suites unchanged; `configured()` tests move to manifest
  fixtures.

## Rollout

- Daemon-only change with an additive capability field; service needs no
  coordinated deploy. Release the daemon and the helper tarball together.
- Existing developers: run `bud browser prepare --helper-dir bud/browser-helper
  --node $(which node)` once; `BUD_BROWSER_EXECUTABLE` keeps working as an
  override until the phase closes, then is removed.
- Docs: design, this plan, specs above, installer handoff.

## Implementation notes (2026-09-21)

- Code: `bud/src/browser/addon.rs` (manifest, resolution, detection, floor,
  downloads, extraction, embedded helper, probe, drift), generated
  `bud/src/browser/pins.rs`, `bud/src/browser_cli.rs`, `BrowserCommand` in
  `config.rs`, dispatch in `lib.rs`, manifest-based check in `doctor.rs`,
  `Runtime` threaded through `adapter.rs`/`semantic.rs`/`manager.rs`,
  `capabilities.browser.runtime`, helper embedding in `build.rs`, the release
  workflow vendoring step, and `scripts/browser-addon-pins.mjs`.
- Deviations from the design are recorded in the design doc: helper embedded
  rather than downloaded; one managed source (Chrome for Testing as pinned by
  playwright-core); env override requires both variables.
- Verified locally: 156 daemon lib tests (9 new add-on tests, no Chrome or
  network needed), clippy/fmt clean for new code, `bud browser prepare` with
  `--helper-dir`/`--node` against system Chrome 153.0.8010.53, `status`, and a
  full `prepare --managed` (Node 24.21.0, embedded helper, Chrome for Testing
  153.0.8010.12) into a scratch base dir.
- Also verified: `doctor --format json` browser check on a prepared and an
  unprepared base dir, `status --json`, `remove` leaving no add-on directory,
  and the env-gated live Chrome suites (36 tests, system Chrome 153) after the
  `Runtime` refactor.
- Not yet exercised: a release build (embedded helper from CI's `npm ci`),
  Ubuntu x64/arm64 managed install, and the interactive daemon restart prompt.

## Review fixes (2026-09-22)

Three findings from review of the implementation, all confirmed and fixed:

- **Release pin check compared text against a rustfmt-reflowed file** and
  failed on the committed `pins.rs`, which would have blocked every release
  build. `scripts/browser-addon-pins.mjs --check` now parses the values out of
  the committed file and compares them (versions, per-target URL and
  executable, well-formed hash and size) without downloading anything; the
  generator runs `rustfmt` on its output. `browser-addon-pins.test.mjs` covers
  the render/parse round trip including a rustfmt reflow.
- **`bud browser remove` could delete a profile Chrome was using.** `remove`
  now takes exclusive ownership of every profile (`addon::claim_profiles`)
  and holds it through the deletion. Claiming refuses when a daemon holds a
  profile's `bud.lock`, and, because a daemon crash releases that lock but not
  Chrome, also when the profile's `SingletonLock` points at a live process on
  this host (the same `singleton_stale` rule Reset uses). The claim is backed by
  a stable `browser-profiles.lock` in the base directory (outside every
  profile), which `Profile::acquire` holds shared for a profile's lifetime and
  removal holds exclusive for the whole deletion, so a daemon cannot re-create
  and lock a replacement profile while the old directory is being deleted, new
  profiles cannot appear after the scan, and two removals cannot run at once.
  Earlier versions probed only the per-profile `bud.lock` and released it at
  once (second review round), then held a lock that died with the deleted
  directory (third round); both are superseded by the stable lock. Unit test covers daemon lock, surviving
  Chrome, stale lock, new-profile blocking, concurrent-claim refusal, and that
  the claim survives deleting the profile tree; verified end to end with a
  simulated surviving browser process and a simulated daemon holding the
  shared lock.
- **Relative `--browser`/`--node`/`--helper-dir` were persisted as given** and
  broke daemon startup from another working directory. `prepare` now resolves
  them to canonical absolute paths before probing and saving
  (`addon::absolute_existing`), rejecting missing paths. Verified end to end
  with relative overrides from the repo root and `status` from `/tmp`.

## Left after this phase (tracked)

- Linux persistent profile remains gated on secure storage (Phase 3o).
- Linux headed mode needs display/session env passthrough (Phase 3o).
- Managed Chromium sandbox on user-namespace-restricted hosts (Phase 3o).
- Edge/Brave support; detected and reported as unsupported in the first cut.
- Web UI "prepare browser" hint; service-driven prepare is out of scope.

Decisions taken 2026-09-21: version floor follows Playwright's supported
Chromium for the pinned Playwright Core; Edge/Brave skipped; pinned checksum
table generated into Rust source at release time.
