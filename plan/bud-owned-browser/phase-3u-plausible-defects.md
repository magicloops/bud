# Phase 3u: Plausible defects to confirm and fix

Status: implemented locally. Eight of nine items reproduced and are fixed with regression tests; P5 did not reproduce and keeps its test as a guard; P7 was decided with no code change. Updated 2026-09-21.

## Context

- Source: [merge-readiness review](../../review/bud-owned-browser-branch-review.md),
  items marked PLAUSIBLE (reasoned from the code, not traced end to end) and
  the low-severity confirmed items filed as follow-ups.
- Related plans: [Phase 3s confirmed defects](phase-3s-confirmed-defects.md),
  [Phase 3e inline waits](phase-3e-inline-browser-waits.md),
  [browser keyboard, files and clipboard](../../design/browser-keyboard-files-and-clipboard.md).
- Related specs: [web browser](../../web/src/features/browser/browser.spec.md),
  [daemon browser](../../bud/src/browser/browser.spec.md),
  [service browser](../../service/src/browser/browser.spec.md),
  [service agent](../../service/src/agent/agent.spec.md).

Each item below starts with a reproduction step. If the reproduction does not
fail, record that in this document and close the item; do not fix what cannot
be shown broken.

## Objective

Every plausible defect is either reproduced and fixed with a regression test,
or shown not to reproduce and closed with the evidence recorded here.

## Items

### P1. Web: `resizeBlocked` sticks and swallows input (medium)

`viewer.tsx` sets `resizeBlocked` when a fit starts and clears it only on a
matching frame, the passive path, passive failure, a media `empty`, or the
"Reconnect view" button. If a media drop aborts a fit and the user re-takes
control with Fit off (or `can_resize_viewport` false), no fitter runs, `send()`
returns early with no error, canvas clicks do nothing, and the chat Return
action no-ops, while the textarea still looks enabled.

Reproduce: mounted test that starts a private fit, closes the media socket
before the matching frame, re-acquires with fit disabled, then sends a click
and asserts it is dispatched.

Fix: clear `resizeBlocked` in `control()` on every non-renew transition
(acquire, release, return, recover) and whenever the media client reports a
disconnect; surface the blocked state in the textarea `disabled` prop and the
canvas cursor so it can never look live while blocked.

### P2. Daemon: private typing fails on `type=email|number|date` inputs (medium)

The injected functions in `adapter.rs` (text insert and key handling) return
`false` when `this.selectionStart === null`. Chrome returns `null` for input
types that do not support selection APIs (`email`, `number`, `date`, `time`,
and others), so private handoff typing into a login form's email field reports
`browser_stale_or_unsupported_focus`.

Reproduce: env-gated test page with `<input type=email>`; focus it, send
private text, assert the value changed.

Fix: when `selectionStart` is `null` but the element is a writable
`HTMLInputElement`, fall back to `this.value += text` (or replace the whole
value for keys) and dispatch the same `InputEvent`. Keep the selection-based
path for types that support it.

### P3. Service: heartbeat during the raw park window aborts the worker (low)

`repository.ts` commits `fence+1, worker_id=null` and throws `BrowserToolWait`;
`browserWaitParked()` in `invocation-worker.ts` marks the worker ended only
after the throw propagates through broker, executor and agent service. A 15 s
heartbeat firing in that window fails `lockedLease` and calls
`controller.abort(error)`. Other park paths renew and mark ended before the DB
write.

Reproduce: unit test with a fake clock that fires the heartbeat between the
repository commit and `browserWaitParked`, asserting the controller is not
aborted after a committed park.

Fix: have the repository park path call a `beforePark` hook (or set a flag on
the invocation context) before committing, so the worker cancels the heartbeat
first, matching the other park paths.

### P4. Service: commit-then-rollback and a false dispatched receipt (low)

`repository.ts` commits and throws `browser_interrupted_reopen_required`, and
the catch then issues `rollback` on a connection with no open transaction
(Postgres warns). The action receipt was stamped `browser_dispatched:true`
although nothing was dispatched.

Reproduce: isolated-schema test that triggers the interrupted-reopen path and
asserts no "no transaction in progress" warning and a receipt with
`browser_dispatched:false`.

Fix: track whether the transaction is still open and only roll back when it
is; stamp the receipt after dispatch is decided, not tentatively.

### P5. Web: stale `session` closure on the first poll (low)

`control` closes over `session` and bails when it is null; the first poll can
invoke a pre-session closure via `latestControl.current`, delaying recovery by
one 3 s tick.

Reproduce: mounted test that mounts without a session, receives the first
session from the poll, and asserts recovery is attempted on the same tick.

Fix: read `session` through a ref inside `control`, or pass the freshly polled
session into the recover call.

### P6. Service: `renew` checks the controller before ownership (low)

`control.renew()` consults the in-memory controller before
`repository.get(owner, id)`, so a foreign session id yields
`409 browser_control_expired` rather than 404. No existence disclosure, but
inconsistent with `resizeViewport`'s ordering and AGENTS.md §4.6.

Fix: reorder to resolve ownership first; add the foreign-session case to the
route tests written in Phase 3v (HTTP-level authorization tests) or here if
that phase is not scheduled.

### P7. Daemon: close does not pause authority (low)

`browser.spec.md` says an admitted close pauses authority before closing
Chrome; `manager.rs` does not transition authority on close, so pause happens
indirectly when the media task ends or the lease expires. Decide whether the
spec or the code is right (Phase 3t removes the sentence if the code is
right); if the spec is right, add the transition and a `control.rs` test.

### P8. Daemon: media busy flag survives a task panic (low)

`slot.media` is reset only when the media task ends normally; a panic leaves
the slot `browser_media_busy` until daemon restart. Wrap the task body so the
flag is cleared on every exit path, and add a test that panics the task and
then re-attaches.

### P9. Service: early viewer message dropped (low)

`routes.ts` awaits `once("message")` and attaches the viewer afterwards;
anything the client sends between its first message and the listener
registration is dropped. Buffer messages from the socket until `attachViewer`
has registered, or attach the listener before awaiting the first message.

## Outcomes (2026-09-21)

- **P2 (daemon): reproduced, fixed.** New env-gated fixture
  `live_private_typing_into_email_input` failed with
  `browser_stale_or_unsupported_focus` on unpatched code; both injected input
  functions now handle a null selection by appending/trimming `value`
  (`adapter.rs`). Passes against Chrome 153.
- **P7 (daemon): decided, no code change.** Authority is Bud-wide; closing one
  thread's tabs must not pause a private session elsewhere; input is already
  fenced by document/frame/focus tokens; the media task that ends with the
  workspace pauses authority when its controller held it. Spec updated.
- **P8 (daemon): fixed.** `OnDrop` guard in `media.rs` clears the busy flag on
  every task exit; unit test panics the task and asserts the flag is clear.
- **P1 (web): reproduced, fixed.** `viewer.test.tsx` "aborted private fit cannot
  leave input silently blocked after re-taking control without fitting" failed
  on unchanged code (textarea enabled, click never dispatched). `viewer.tsx` now
  clears the fence at the start of every non-renew control transition and on
  media loss, and mirrors it into the textarea `disabled` prop and a waiting
  cursor on the owned canvas; the ref stays the synchronous gate in `send()`.
- **P5 (web): did not reproduce.** "recovery is attempted on the first poll
  that reports the browser available, not one tick later" passed on unchanged
  code and is kept as a guard. A recovery ticket only arrives in a control
  response, which needs a non-null session; `session` never reverts to null;
  the latest control callback is refreshed by effect before a poll tick can
  run; and `recoverViewer` on the service does not check `revision`.
- **P3 (service): reproduced, fixed differently than sketched.** Test "a
  heartbeat blocked behind a browser park commit cannot abort the parked
  worker" (`invocation-worker.test.ts`) showed a heartbeat rejecting with
  `lease_lost` after `browserWaitParked()`, aborting the controller. The
  proposed `beforePark` hook would deadlock: `prepare()` holds the invocation
  row `for update` until commit and `heartbeat()` locks the same row. Fix:
  `renew()` ignores lease loss once `parked` is set (the commit response and the
  wait propagation are microtasks, so `parked` always precedes the rejection).
- **P4 (service): reproduced, fixed.** A proxied client counted one `rollback`
  after `commit`; `repository.ts` now tracks whether the transaction is open and
  stamps `browser_dispatched:true` only after the interrupted-reopen branch.
  The test also asserts the receipt is not `true` and the call id can reopen.
- **P6 (service): reproduced, fixed.** "renew resolves ownership before
  consulting controller state" (`control.test.ts`): a foreign owner got
  `browser_control_expired`; `renew()` now resolves ownership first and the
  independent-renewal path reuses that read.
- **P9 (service): reproduced, fixed.** "a message sent right behind the viewer
  hello reaches the media listener" (`media.test.ts`): an ack sent behind the
  hello was dropped. `routes.ts` extracts `viewerHandshake`, which buffers up to
  16 messages after the hello and replays them once `attachViewer` returns.
- Also found while reproducing P2: `forget_workspace` (no-handle close) still
  used the fail-closed hint save; routed through the best-effort `forget` from
  Phase 3s D1.

## Spec Files to Update

- [x] `web/src/features/browser/browser.spec.md` (P1, P5)
- [x] `bud/src/browser/browser.spec.md` (P2, P7, P8)
- [x] `service/src/browser/browser.spec.md` (P3, P4, P6, P9)

## Impacted Contracts

- [ ] WSS protocol: none
- [ ] SSE events: none
- [ ] DB schema: none
- [ ] Agent tools: none
- [ ] Web UI: P1 makes the blocked state visible

## Test Plan

Each item carries its own reproduction. Items whose reproduction passes on
current code are closed with the test kept as a guard and a note here.

## Rollout

Independent small fixes across daemon, service and web. None needs a
coordinated deploy or migration; the daemon items ship with the next release.
