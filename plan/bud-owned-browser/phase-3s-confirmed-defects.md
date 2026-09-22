# Phase 3s: Confirmed defects from the branch review

Status: implemented locally with regression tests (D1–D4); env-gated live confirmations for D1/D2/D3 not yet run. Updated 2026-09-21.

## Context

- Source: [merge-readiness review](../../review/bud-owned-browser-branch-review.md),
  daemon H1/H2/M1 and service M1, each marked CONFIRMED by tracing the code path.
- Related plans: [Phase 3l recovery](phase-3l-tab-and-history-recovery.md),
  [Phase 3k persistent browser](phase-3k-shared-persistent-browser.md),
  [Phase 3p empty workspace recovery](phase-3p-empty-workspace-recovery.md),
  [provider-anchored context accounting](../provider-anchored-context-accounting.md).
- Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
  [service agent](../../service/src/agent/agent.spec.md),
  [service browser](../../service/src/browser/browser.spec.md).

Four defects were confirmed in code but not yet observed in use. Three turn a
routine failure into a manual repair on the Bud host; one makes the context
meter wrong whenever screenshots are in play. None affects ownership or data
integrity, which is why they were not merge blockers, but each is small enough
to fix before real use.

## Objective

- Close and Reset always work as recovery actions, even after a crash or
  corrupt on-disk state, without ever adopting a Chrome process Bud does not own.
- A long-lived workspace never exhausts its CDP session table.
- The context meter and compaction trigger account for every image the
  provider actually receives.

Acceptance: each defect has a regression test that fails on the current code,
and the daemon/service specs describe the corrected behaviour.

## Defects and fixes

### D1. Corrupt recovery hints make workspace Close impossible (daemon H1)

`Browser::close` (`adapter.rs`, the non-root branch) calls
`recovery.save(workspace, None)?` before closing any tab. When `bud-pages.json`
failed validation at load, `Recovery::load` sets `writable=false` for the
process lifetime, `save` bails `browser_recovery_unavailable`, and that code is
in the manager's `REJECTED` list, so `closed_at` is never set and every Close
fails until the daemon restarts with a repaired file.

Fix: hint removal on close is best-effort. `close` calls
`recovery.available()` first; when unavailable it logs at warn and continues to
close tabs. Saving hints after successful operations (`manager.rs`,
`save_pages`) keeps its current fail-closed behaviour, since that path must
never write over corrupt evidence. Add a recovery-store method
`forget(workspace)` that is a no-op when not writable, and use it from close.

Test: `recovery.rs` unit test that a store loaded from a corrupt file reports
`available() == false` and `forget` returns `Ok`; an `adapter.rs` env-gated
test that closes a workspace after a corrupt hints file and asserts the owned
targets are gone.

### D2. A stale `SingletonLock` blocks Reset (daemon H2)

`Profile::acquire` and `ensure_not_running` (`profile.rs`) refuse whenever
`SingletonLock` exists, by design, to never launch against a Chrome Bud does
not own. Chrome removes the symlink only on clean exit. `Browser::close`
escalates to SIGKILL after its grace period and a daemon crash leaves the lock
too, so `lifecycle(reset)` goes through `Profile::acquire`, fails with
`browser_profile_recovery_required`, and the documented recovery action is
blocked by exactly the state it should recover from.

Fix, keeping the ownership guarantee: Chrome writes the symlink target as
`<hostname>-<pid>`. Add `Profile::singleton_owner()` that reads the link and
returns `(hostname, pid)`. Treat the lock as stale only when all of the
following hold: the hostname matches this machine, the pid is not alive
(`kill(pid, 0)` fails with ESRCH), or it is alive but is not a Chrome process
whose `--user-data-dir` equals this profile (read `/proc/<pid>/cmdline` on
Linux, `ps -o command= -p <pid>` on macOS). A stale lock is removed before
`acquire` proceeds; a live matching Chrome still fails
`browser_profile_recovery_required` with the pid in the log. `Browser::close`
additionally removes the lock itself after it has confirmed its own child
exited by SIGKILL, since at that point ownership is certain.

Test: `profile.rs` unit tests with a fake symlink pointing at a dead pid (stale,
removed), at the test's own pid (live, refused), and at a foreign hostname
(refused). Env-gated test: launch, SIGKILL the child, assert Reset succeeds.

### D3. CDP session caches never evict (daemon M1)

`session()` and the screenshot session map (`adapter.rs`) cap at 32 entries but
only clear on `recover_channel`. Closed targets are never pruned and
`Target.detachFromTarget` is never sent, so a workspace that cycles through
more than 32 targets (native tab closes, `ensure_page`, `reopen_pages`,
popups) gets `browser_target_limit` on every call until a channel repair.

Fix: `targets()` already refreshes the inventory; after each refresh, drop
session entries whose target is no longer listed and send
`Target.detachFromTarget` for them best-effort. Do the same for the screenshot
session map. Keep the cap as a hard backstop.

Test: unit test against a fake CDP that answers `Target.getTargets` with a
shrinking list and asserts the session maps shrink and detach calls are sent;
env-gated test that opens and closes 40 targets and still observes.

### D4. Hydrated screenshots bypass context accounting (service M1)

`hydrateBrowserImages` runs in `model-runner.ts` after the budget decision, and
`context-accounting.ts` abandons the provider usage anchor whenever an
`image_artifact` reference exists (`fallback("image_hydration")`), so the
heuristic counts only the small JSON reference. Up to eight images reach a
vision provider with zero tokens counted.

Fix: move hydration ahead of the budget decision so the accounted conversation
is the one sent, and give the estimator a per-image cost. The provider adapters
already know the model; add `estimateImageTokens(width, height)` to the
capability surface with the provider's published formula (OpenAI tiles,
Anthropic pixel area) and a conservative constant for unknown providers. Keep
the anchor invalidation only when hydration actually changed which images are
present relative to the anchored request (compare the hydrated image id set in
the baseline), rather than whenever any reference exists.

Test: `context-accounting.test.ts` cases where a conversation with two hydrated
images accounts for image tokens and keeps the anchor when the image set is
unchanged; `model-runner` test that the messages passed to the estimator equal
the messages passed to the provider.

## Implementation notes (2026-09-21)

- D1: `Recovery::forget` (best-effort, no-op with a warning when the store is
  not writable); `Browser::close` uses it and logs instead of failing.
  `recovery.rs` test asserts a corrupt store is unavailable, `forget` succeeds,
  and the corrupt file is untouched.
- D2: `profile.rs` reads the `SingletonLock` symlink target (`<hostname>-<pid>`)
  and treats it as stale only for the local hostname when the pid is gone or is
  not a process whose command line carries this profile's `--user-data-dir`
  (`/proc/<pid>/cmdline` on Linux, `ps -o command=` elsewhere). Stale locks are
  removed (with `SingletonSocket`/`SingletonCookie`) before acquisition; live
  matching Chrome still refuses. `Browser::close` clears the files after its own
  child was SIGKILLed. Test covers foreign host (refused), live process using the
  profile (refused), dead pid (cleared), and pid reuse (stale).
- D3: `targets()` prunes command and screenshot sessions whose target vanished
  and sends `Target.detachFromTarget` best-effort; `prune_sessions` is
  unit-tested. The 32-entry caps remain as backstops.
- D4: `service/src/browser/image-references.ts` is the single selector for which
  screenshots hydrate (newest eight successful `browser_observe` references);
  hydration and the estimator both use it. The estimator charges
  `IMAGE_TOKEN_ESTIMATE` (1,600, conservative) per hydrated reference and per
  real image block instead of base64 length. The request baseline records the
  hydrated image ids of the measured prefix; the provider anchor stands while
  that set is unchanged, new suffix references are estimated, and drop-outs
  (or anchors without an image record that measured screenshots) fall back.
  Hydration stays in the model runner. Tests: `image-references.test.ts`,
  extended `context-accounting.test.ts`.
- Deviation from the fix sketch: no per-provider image formula on the
  capability surface; one conservative constant keeps the estimator pure and
  errs toward earlier compaction.

## Spec Files to Update

- [x] `bud/src/browser/browser.spec.md` (close is best-effort on hints; stale lock rule; session eviction)
- [x] `service/src/agent/agent.spec.md` (image accounting)
- [ ] `docs/proto.md` only if the `browser_profile_recovery_required` reason text changes

## Impacted Contracts

- [ ] WSS protocol: none
- [ ] SSE events: none
- [ ] DB schema: none
- [ ] Agent tools: none
- [ ] Web UI: none

## Test Plan

Unit tests listed per defect, all runnable without Chrome or network except
the env-gated confirmations. Existing browser suites must stay green.

## Rollout

Daemon and service changes are independent and additive. Deploy the service
change with `main`; the daemon change ships with the next release. No
migration, no coordinated restart, no mixed-version concern.
