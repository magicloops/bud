# Phase 7d: Automatic bundled-helper upgrades on daemon startup

Status: implemented; local macOS validation passed. 2026-09-24.
Results: [startup helper upgrade](../../debug/browser-startup-helper-upgrade.md).
Parent: [REPL implementation](repl-implementation.md).
Runs before [Phase 8 final acceptance](repl-phase-8-workspace-lifecycle.md).
Related: [add-on design](../../design/browser-addon.md),
[helper cache identity](../../debug/browser-helper-cache-identity.md),
[daemon browser spec](../../bud/src/browser/browser.spec.md),
[helper spec](../../bud/browser-helper/browser-helper.spec.md).

## Objective

Once a user enables browsing with `bud browser prepare`, restarting an updated
Bud should automatically use that binary's bundled helper. Routine helper changes
must not require another manual preparation. Browser support remains opt-in.

This phase installs bundled JavaScript and its vendored dependencies. It does not
compile on the user's machine or download a helper. Automatic Node/Chrome downloads
and browser switching are outside this phase; missing/incompatible dependencies
still receive actionable `browser prepare` guidance.

## Previous behavior

`bud/build.rs` packs the helper and vendored Playwright into the daemon.
`addon.rs` identifies the archive by SHA-256, extracts it through a staging
directory into `browser/helper/sha256-<digest>/`, and writes the manifest atomically.
Before this phase, startup rejected a managed manifest whose helper digest differs from
the current binary, even though that binary already contains the replacement.
This prevents stale APIs but unnecessarily makes the user repair routine upgrades.

Reuse archive identity, extraction, runtime validation and manifest persistence.
Keep exact helper matching; replace manual repair with startup reconciliation.
Do not add an updater service, version negotiation, legacy fallback or new flag.

## Enablement and scope

| State at startup | Required behavior |
| --- | --- |
| No manifest, even if old helper/profile directories exist | Browser disabled; no extraction, probe, download or manifest creation |
| Valid managed manifest, matching complete helper | Reuse installed bundle and normal readiness path |
| Valid managed manifest, different/missing/incomplete helper | Stage this binary's bundle, validate candidate runtime, commit manifest on success |
| Invalid/unreadable/unsupported-schema manifest | Preserve it; report unavailable with repair guidance |
| Explicit environment override or `dev:true` manifest | Preserve the selected development runtime; no automatic replacement |
| Bundled helper incomplete or selected Node/browser unusable | Browser unavailable with a specific reason; preserve previous manifest/profile |

A supported manifest is the existing persistent enablement record, including
when a previous readiness check failed. A failed probe is not user opt-out:
validation may recover it, but availability requires a new successful readiness
check. `bud browser remove` removes enablement; startup must not recreate it.
No separate `browser_enabled` setting or manifest schema migration is needed.

## Startup flow

- [x] Read startup/CLI/add-on code and relevant specs in full; write a debug note
  with the current stale-helper reproduction before changing behavior.
- [x] Resolve explicit development overrides first. For managed operation, read
  the existing manifest under the installation coordination described below.
- [x] Reuse the exact bundled helper when complete, or stage/extract it using
  the existing content-addressed installer. Check all required entrypoints and
  vendored dependencies, including REPL modules; `main.mjs` alone is insufficient.
- [x] Build a candidate runtime using the manifest's existing Node and browser
  choice. Apply current runtime requirements/readiness checks. An incompatible
  dependency is a preparation failure, not permission to download, switch browser
  or silently use an older helper. Cosmetic recorded-version drift alone need
  not trigger a reinstall when existing supported-runtime policy allows it.
- [x] Validate through the existing headless disposable readiness probe, including
  the helper/REPL entrypoints. Consolidate with startup probing rather than
  launching two probes. Never open the persistent profile to install the helper.
- [x] On success atomically write the updated helper record and truthful
  `prepared_by`, `prepared_at` and probe metadata. Preserve browser/Node selection
  and unrelated manifest fields; observed browser version may follow existing
  recording rules. Only then expose the candidate runtime to the browser manager.
- [x] Complete this before browser capability advertisement or accepting browser
  work. Use existing bounded startup readiness handling; filesystem/probe failure
  must leave browser unavailable without making terminal service unusable. No
  periodic updater, hot worker replacement or installation inside agent calls.

The initial `prepare` CLI remains the enable/install path and explicit dependency
repair command. `status`/`doctor` report state; inspecting status must not install
or enable the add-on. Diagnostics distinguish disabled, upgraded, reused and
failed preparation using bounded operational metadata, never page content.

## Atomicity, failures and lifecycle

- [x] Serialize startup reconciliation with `prepare` and `remove` for the same
  base directory. Reuse a suitable existing lock, or add one stable add-on lock
  outside directories removed by the CLI. Re-read enablement after acquisition.
  Use bounded acquisition; do not hold a global page/profile lock for installation.
- [x] Do not resurrect a manifest after removal or overwrite a concurrent CLI
  selection. Keep the existing CLI restart/removal semantics; if removal follows
  successful startup, its normal daemon restart still applies.
- [x] Extract to staging and publish complete bundles only. Never edit a bundle
  used by an existing worker in place. Detect incomplete cached bundles before
  reuse. Retain older content-addressed bundles for now; no cache-GC subsystem.
- [x] Failed extraction, validation or manifest persistence leaves the old
  manifest intact and this startup's browser unavailable. Never run a mismatched
  helper as fallback. A later restart retries from the same enablement record.
- [x] Handle interrupted staging/commit idempotently. A completed bundle left
  without a committed manifest may be reused after validation on the next start.
  Downgrading Bud selects its own embedded digest by the same rule.

This is runtime installation only. It must not delete/change browser profiles,
checkpoints, sign-ins, tabs, private-control authority or action receipts. Normal
daemon restart/managed-process recovery still determines which live state
survives. No pending cell is replayed, and retained REPL memory is not migrated.

## Ownership and affected contracts

The installation belongs to the local daemon base directory and OS user. Existing
local CLI access controls apply. No service/model command may enable or upgrade
it; no new HTTP route, database table, owner stamping or service permission.
Browser ownership, invocation and Bud-wide private-control checks remain unchanged.
Capability availability is advertised only after successful runtime validation.

Read/update these specs during implementation:

- [x] `bud/src/browser/browser.spec.md`: add-on resolution and manager startup.
- [x] `bud/src/src.spec.md`: CLI/startup responsibilities if changed.
- [x] `bud/bud.spec.md`: build/startup packaging contract as affected.
- [x] `bud/browser-helper/browser-helper.spec.md` and `README.md`: setup and upgrade instructions.
- [x] Add-on design, this phase and parent plan: implementation/results and limits.

No wire/schema change is planned. Update `docs/proto.md` only if implementation
changes an advertised contract; no new capability bit is needed for local extraction.

## Validation

- [x] Unprepared/removed base stays disabled despite cached files/profiles.
- [x] Old managed helper upgrades on one daemon start with no manual `prepare`;
  matching restart reuses it; content changes under the same Git label upgrade.
- [x] Missing required helper/REPL files are repaired; incomplete embedded builds
  fail clearly without overwriting the old manifest.
- [x] Probe failure, permission-denied commit, interrupted staging, shared-lock
  contention/removal and downgrade preserve atomicity and opt-in. Physical
  disk exhaustion/power loss remain outside local validation.
- [x] Explicit development overrides remain unchanged; invalid manifests are
  preserved; missing/incompatible Node or Chrome never trigger network access.
- [x] Real disposable runtime: seed an old-helper manifest, call the production
  startup reconciliation/probe path, execute an extracted-helper REPL cell, then
  repeat startup and verify cache reuse and no persistent-profile writes.
  Startup has one browser probe call; no duplicate manager probe remains.
- [x] Failed browser preparation returns normally from manager initialization,
  with unavailable capability and actionable diagnostics. Terminal startup remains
  unchanged; a full service/terminal end-to-end failure run remains Phase 8 acceptance.
- [x] Run focused add-on/CLI/startup tests, affected build and packaged-bundle
  validation; record actual commands/results and untested platforms in the note.

## Rollout and completion

Rebuild/install the updated daemon, then restart normally. Users who already
prepared browsing need no helper-only command; first-time users still run
`bud browser prepare`. A source build still needs vendored helper dependencies
at build time. Existing service/daemon contract coordination remains required
when an API changes; automatic extraction does not upgrade the service.

No service/web/mobile release, dependency download or migration is introduced by
this phase alone. Complete when opt-in, startup upgrade, failure and concurrency
acceptance are recorded. Phase 8 remains the final merge gate. No user daemon/service was restarted and no commits or deployment were performed.

Implementation uses a fail-fast stable `browser-addon.lock`, a 15-second wait on
blocking extraction, and a 30-second readiness deadline. Readiness validates
Node >=22, a disposable REPL cell, and one headless browser/semantic launch.
Incomplete caches get a new sibling path, preserving potentially in-use files.
All packaged regular files are checked for presence and size before reuse.
Dev manifests and environment selections are probed without mutation. Doctor
uses read-only resolution/probing, not the mutating manager startup path.

Validation is local macOS arm64. Failure tests simulate permission denial,
interrupted staging and contention; actual power loss/disk exhaustion, Linux and
full service connectivity under preparation failure remain untested. See the
linked debug note for exact commands, failures investigated and rollout limits.
