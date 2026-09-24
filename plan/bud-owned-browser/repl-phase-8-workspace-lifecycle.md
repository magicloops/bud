# Phase 8: Workspace admission, cleanup and final merge acceptance

Status: lifecycle implementation and automated validation complete; physical and
matching-stack merge acceptance remains pending. Final pre-merge phase of the
[REPL implementation plan](repl-implementation.md). 2026-09-24.

## Policy and objective

The user rejected manual capacity management. The fixed ten-workspace limit is
removed. Browser tabs/helpers and REPL heaps/artifacts expire automatically after
24 hours without use, checked every minute locally by the daemon. This replaces
the earlier retention-until-explicit-close policy. No LRU eviction, new database
model or web polling is introduced.

Admitted page/cell operations, active cell/media holders and live private control
are use. Checkpoint events, metadata reads and background service traffic are not.
Active work is protected; after its last use another full idle period applies.
Expiry saves eligible public URL checkpoints before closing owned tabs, preserving
queries/fragments, profile/sign-ins and unrelated threads. Paused private content
retains its earlier disclosed URLs; expiry never saves private addresses or returns
control automatically. Normal ensure restores public pages and the next cell gets
a fresh runtime. REPL bindings and temporary artifacts are intentionally ephemeral.

Explicit Close browser workspace remains an optional discard action that also
forgets saved URLs. It is no longer required for normal resource management or
access to an eleventh conversation. Current per-operation deadlines, serialized
page access and per-worker memory/output bounds remain.

## Implementation

- [x] Remove the resident-count cap and manual capacity-recovery guidance.
- [x] Add one daemon-local minute sweep with a monotonic 24-hour idle clock;
  no strong manager lifetime cycle or task surviving explicit daemon shutdown.
- [x] Protect in-flight operations, media, cells and live private control.
- [x] Expire owned targets/helpers/workers/artifacts; retain public URL checkpoints
  across partial cleanup failures and retry cleanup without replaying cells.
- [x] Keep logical sessions reusable through existing agent/viewer ensure.
- [x] Preserve immutable scope and admitted-request fences; expose fresh runtime
  creation/generation (idle_expired reason while the worker record is retained).
- [x] Keep explicit close/deletion cleanup distinct from automatic expiry.

## Ownership and contracts

The authenticated owner owns the Bud; each thread owns its workspace, targets and
REPL state. Service admission resolves owner/Bud/thread/invocation, and the daemon
checks immutable bindings and current authority. Cleanup cannot cross these
boundaries. Private control remains Bud-wide, and another thread's admission
must not release it. Chrome's persistent profile and sign-ins are not disposable
workspace resources.

No new route, table or migration is presumed. If existing surfaces need changes,
identify viewer resolution, authorization before reads/writes/streams and owner
stamping before implementation. Resource inventory must be owner-scoped in SQL;
never expose another user's workspaces as cleanup candidates. Extend the
[auth checklist](../init-auth/validation-checklist.md) for any new browser-facing
read/write surface. Update wire documentation for changed capabilities, payloads
or errors; do not silently change the meaning of `max_sessions`.

## 3. Validate behavior

- [x] More than ten threads, including concurrent new admissions, remain usable.
- [x] Before/at the 24-hour boundary: heap preserved then released; next cell has
  a new runtime and old bindings are absent; duplicate sequence remains rejected.
- [x] Active holders keep resources and refresh their idle period.
- [x] Live Chrome expiry/ensure restores complete public URLs and preserves frozen
  public checkpoints during private expiry, without returning private authority.
- [ ] Real-agent and physical web/iPhone long-idle return: no manual workspace
  release, fresh usable view, other-thread/sign-in continuity.

Record actual results in [the debug note](../../debug/browser-workspace-lifecycle.md).
Deterministic clock-based fixtures replace waiting a full day during automated tests;
physical/matching-stack acceptance remains separate.

## 4. Final merge gate

- [ ] Complete [Phase 7g REPL-only cutover](repl-phase-7g-repl-only-cutover.md):
  verify implemented removal of legacy execution, mode selection and historical adapters,
  and verify fresh/existing-thread operation with the supported catalog.


- [ ] Complete [Phase 7f event-driven browser state](repl-phase-7f-event-driven-browser-state.md):
  zero healthy idle status polling, reliable state-change/reconnect reconciliation,
  preserved private control, scoped event delivery and measured access-log cleanup.

- [ ] Complete [Phase 7e client recovery cleanup](repl-phase-7e-client-recovery-cleanup.md):
  bounded outage traffic, coordinated terminal recovery, retained output and
  actionable diagnostics. Record unresolved network/script causes separately.

- [ ] Complete [Phase 7d startup helper upgrades](repl-phase-7d-startup-helper-upgrade.md):
  existing opt-in upgrades automatically; disabled installations stay disabled;
  failed upgrades cannot advertise stale APIs or prevent terminal service.

- [ ] Complete [Phase 7c scrolling and observation use](repl-phase-7c-observation-use.md)
  with a reproduced stale-scroll decision and measured guidance results.

- [ ] Complete [Phase 7b output compaction](repl-phase-7b-output-compaction.md),
  including fidelity/overflow validation and the explicit post-compaction
  decision on the 8 KiB default. Do not infer acceptance from smaller byte counts.

- [ ] Reconcile the parent plan's open Phase 3 physical lifecycle, Phase 4 catalog
  cutover and Phase 6 efficiency acceptance with recorded evidence. Any proposed
  deferral must be explicit and agreed; a larger workspace cap is not acceptance.
- [ ] Complete Phase 7 supplementary interaction validation. The
  [1575 review](../../review/browser-repl-1575-review.md) confirms pointer hints
  but contains no clicks, so it is not native-click acceptance.
- [ ] Run affected builds/tests and the final supported-catalog smoke test after
  cleanup. Historical pre-REPL results have no compatibility requirement.
- [ ] Update daemon/helper/service/agent/viewer specs as affected, protocol and
  setup docs, this phase, and the parent plan. Record remaining work separately
  without hiding unresolved merge blockers.
- [ ] Record coordinated service/daemon/prepared-helper versions and upgrade order;
  native mobile needs a build only if its bridge changes. Include migrations only
  if the final implementation introduces schema changes.

The phase is complete when workspace lifecycle acceptance and the earlier merge
gates above are satisfied. Linux support, WebRTC, expanded keyboard/clipboard/file
APIs, context thinning and unrelated performance work remain separate plans.
Implementation does not authorize commit, push, merge, deployment or restart.

### Phase 7f acceptance handoff

Automated idle/recovery/security coverage passes; see the Phase 7f debug record.
Before closing its physical gate, apply migration 0042 before the updated service,
reload web/hosted viewers, and record 60-second web and physical iPhone traffic.
Count metadata/inventory/resource GETs (zero after healthy settlement), transport
heartbeats separately, media captures, and private renewals (five seconds).
Exercise two threads, another viewer's takeover/Return, hidden/resume, daemon
replacement and service/network interruption. Confirm retained passive images,
revocation clearing, no orphan subscriptions and no duplicate input/cell replay.
These physical checks remain pending; synthetic passes do not close them.

### Scrolling checkpoint (2026-09-24)

User accepts current desktop takeover scrolling and agent scrolling for exercised
Nth-item browsing. No further scroll optimization is required for this cutover.
Mobile scrolling is explicitly deferred until the mobile track resumes; retain
its device checklist without treating that deferral as a passed device test.
Other privacy/recovery/device checks retain their separately documented status.

## Evidence and remaining acceptance

The earlier manual-capacity implementation's results remain historical in the
[debug note](../../debug/browser-workspace-lifecycle.md). The revised expiry checks
and exact validation commands are recorded there separately. Physical final-stack
checks remain open; desktop/agent scrolling acceptance and the mobile-scrolling
deferral above are unchanged.

### Earlier-gate reconciliation

- Phase 7g removal and automated catalog coverage pass; fresh/existing-thread
  smoke on the final matching stack remains pending.
- Phase 7f automated idle/recovery/scoped-notification tests pass; the physical
  60-second traffic and interruption checklist above remains pending.
- Phase 7e automated recovery coverage passes; physical outage acceptance remains.
- Phase 7d local macOS upgrade/opt-in/failure checks are recorded in its phase doc.
- Phase 7c desktop/agent scrolling has the user acceptance recorded above; mobile
  scrolling is explicitly deferred. Broader observation-use evidence remains in 7c.
- Phase 7b retains the 8 KiB default following the controlled comparison and the
  user-directed reversal of the recent 16 KiB experiment; expansion stays explicit.
- Earlier Phase 3 lifecycle/device, Phase 6 efficiency and Phase 7 supplementary
  native-interaction checks retain their documented status. No synthetic test is
  represented as a physical or real-agent acceptance run.

### Coordinated upgrade

Phase 8 replaces max_sessions with workspace_idle_timeout_sec in the daemon
capability; it adds no migration, helper API or native bridge. Use the daemon,
service and hosted web from this implementation together; the daemon performs the
existing opt-in bundled-helper upgrade at startup. For the full branch, apply
Phase 7f migration 0042 before starting the matching service, then restart the
matching daemon and reload web/hosted viewers. Older service/daemon combinations
are not the acceptance target. Record exact deployed build revisions and physical
results before merge; no restart, deployment or merge was performed for this phase.
