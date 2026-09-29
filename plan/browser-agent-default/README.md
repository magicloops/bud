# Plan: Agent-default browser control

Status: implementation committed and PRs open; automated validation passed and user reports the flow works well. Remaining physical failure-matrix checks and coordinated deployment pending. Updated 2026-09-28.

## Product contract

The browser belongs to the agent unless the user explicitly takes control.
Human control is a temporary override, not a persistent private-browsing mode.
Closing, leaving or backgrounding the controlling view ends that override;
disconnection and missing renewal end it promptly. Reopening/reconnecting always
starts view-only and never automatically reacquires human control.

There are only two authority owners: agent and human. An internal drain or
reconciliation can temporarily make execution unavailable, but it is not a third
ownership mode and never requires a user to clear a lingering lock.
After human control ends the agent may observe the resulting page. No previous
private-content flag may keep it blocked indefinitely.

This supersedes the **recommendations** in
[the lifecycle review](../browser-streaming/control-lifecycle-review.md), including
persistent pause on background/disconnect, automatic recovery of human control,
and waiting for a successful return before allowing the viewer to close. Its code
findings remain useful. Existing specs describe current implementation until the
corresponding phase changes them.

## Scope and phases

| Phase | Scope | Dependency |
|---|---|---|
| [1 — Contract and DB](phase-1-contract-and-db.md) | Authority/lease contract, schema replacement, migration and fixtures | First |
| [2 — Daemon](phase-2-daemon.md) | Deadline-enforced override, drain/fence, automatic return, reconnect reconciliation | Phase 1 contract |
| [3 — Service and agent](phase-3-service-and-agent.md) | Lease coordination, expiration, admission, task continuation, canonical status | Phases 1–2 |
| [4 — Web and mobile](phase-4-web-and-mobile.md) | Quick close/background release, no reacquire, native disposal and shared UI | Phase 3 API |
| [5 — Validation and cutover](phase-5-validation-and-cutover.md) | Cross-tier failure matrix, old-state migration, removal and coordinated deployment | All |

These are implementation slices, not independently deployable mixed-version
releases. Implementation and automated evidence are recorded below; physical and deployment gates remain open.

## Behavior

| Event | Authority and behavior |
|---|---|
| Open, reopen, foreground or reconnect | Agent viewing; no takeover request |
| Explicit Take control | Fence agent work, drain, admit one human override |
| Explicit Return | End this override; viewer remains view-only |
| Close pane/sheet, leave its thread/tab | End this override; dismiss immediately |
| App background/lock or controlling web document hidden | End this override; clear local input/pixels |
| Media/status transport failure | Invalidate that viewer's override and stop renewal; no automatic reacquire |
| No end request delivered / process killed | Short lease expires and returns to agent |
| Passive viewer closes/disconnects | No change to another viewer's override |
| Uncertain human input | Never replay; fence remaining input, settle/recover execution, return to agent |
| Service/daemon transport loss | Human override cannot revive; agent authority is default, device work waits for connectivity |
| Ownership revoked / workspace deleted / explicit Stop | Reject access or stop resource; never resume unauthorized/canceled work |

A visible foreground human may read without touching the page; presence renewal,
not gesture frequency, maintains the override. A passive socket cannot renew it.
Do not yield merely because the controls menu receives focus or an OS keyboard is
shown. Use actual view/scene/document lifecycle and supported channel health.

## Lease and reconciliation defaults

Implemented constants: 6-second maximum lease, renew every 2 seconds while
foreground, visible, authorized and connected. Explicit end starts immediately;
unreachable cleanup falls back to expiry. These are testable defaults, not a
promise that an offline agent executes within six seconds.

Every takeover has a unique override ID bound to resource, workspace, owner,
authenticated viewer and carrier/lifetime fence. Renew, input and end refer to
that ID. End/expiry permanently retires it. A delayed renewal/end/input cannot
resurrect it or affect a later takeover. Renew is not an acquire operation.

The daemon enforces a local monotonic deadline even when the service is gone.
The service stops admitting old input immediately and resolves eligible agent
waits only after daemon reconciliation proves old input can no longer run.
Remaining-duration and delivery-deadline rules must prevent a delayed renewal
from extending the maximum lease from its late arrival time.

## Keep versus remove

Keep owner isolation, one active human per Bud, workspace target isolation,
epoch/generation fences, bounded input queues, current frame/focus evidence,
no replay of ambiguous input, and acknowledged execution transitions.
Keep Bud-wide scope: this plan does not isolate profiles or permit concurrent
agent work against a shared profile during human override.

Remove persistent private pause, proof-based automatic takeover recovery,
reacquire-to-return, the normal Pause button, and user-facing return gates caused
only by an expired controller. Authentication grants and input/frame tokens still
exist; they serve different purposes and are not legacy recovery machinery.
Saved agent images may remain a read-only loading/offline fallback, never a reason
to keep authority paused or present historical pixels as live.

## Task waiting is not browser ownership

`browser_request_handoff` may ask for help and park that invocation, but must not
lock the browser before the user takes control. A pending human task is separate
from a live override. After an associated override ends, resume with an honest
reason (explicit return, background, expiry, failure); do not claim the requested
login/task was completed. The agent inspects the page and decides its next step.
A request never taken up remains a task prompt with a Take control button on web
and mobile, not a hidden Bud-wide browser lock. The user can instead reply with
different instructions, skip or cancel. Alternative instructions redirect the
waiting agent without requiring takeover or return; they must not be recorded as
completion of the originally requested human task. Unrelated eligible browser
work can proceed.

## Ownership and documentation

Resource root: owner-bound Bud/browser resource. Workspaces inherit thread/Bud
owner. Resolve live web auth or the exact scoped mobile visit before reads/writes;
authenticated viewer plus override ID is required for client renewal/end/input.
Internal expiry is a service/daemon lifecycle action, not a forged human request.
Automatic returns must not stamp a fictitious `returned_by_user_id`.

Specs affected: [daemon](../../bud/src/browser/browser.spec.md),
[service](../../service/src/browser/browser.spec.md),
[DB](../../service/src/db/db.spec.md),
[migrations](../../service/drizzle/migrations/migrations.spec.md),
[web](../../web/src/features/browser/browser.spec.md),
[protocol](../../docs/proto.md), [mobile contract](../bud-owned-browser/mobile-viewer-contract.md),
[auth checklist](../init-auth/validation-checklist.md),
and companion mobile design/phase docs and PROGRESS.md.

## Non-goals

No TURN/WebRTC change, new media transport, per-thread profile isolation, gesture
retuning, browser tab destruction on viewer close, or generic workflow scheduler.
No background mobile networking guarantee. No compatibility framework for old
pre-launch clients: matching controlled upgrades are required.

## Implementation record

Service/DB, daemon and hosted web changes are in [Bud PR #134](https://github.com/magicloops/bud/pull/134)
(`52f73dc`); companion mobile changes are in [mobile PR #50](https://github.com/magicloops/bud-mobile/pull/50)
(`f78fec1`). These commits identify the implementation; acceptance runs must also
record the actual installed build and environment.
Recovery tickets, automatic reacquisition and prepare/finish-return are removed.
Help requests do not acquire authority; chat redirection cancels the obsolete wait.

One deliberate storage choice: retain existing paused/resume_pending/private_content
fields solely as execution/disclosure fences until daemon cleanup is acknowledged.
They are not authority sources. Public authority derives only from the live override;
background reconciliation clears these fences without a user Return action.

See Phase 5 for exact migration/build evidence and the remaining physical checks.
Commits and PR creation are complete. Merge and deployment remain pending. Streaming
is a default-off experiment in the same Bud PR; this authority change is ungated.
Formal streaming performance measurements may follow merge, but the focused
lifecycle checks and coordinated migration/build cutover must not be deferred.
