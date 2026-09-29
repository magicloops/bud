# Phase 3: Service coordination and agent continuation

Status: implemented locally; automated checks passed; remaining acceptance below. Requires Phases 1–2.

## Objective

Agent admission is blocked only by a live human override or unavailable execution,
not by a forgotten viewer. One end path serves release, expiry and failure.

## Work

- [x] Replace `release -> pause` and `expireControllers -> pauseAfterFailure` with
  a conditional end of the specific override. End is idempotent and does not
  require an active input lease, pending handoff or temporary reacquisition.
- [x] Persist/fence agent-default intent before completion; reconcile with daemon
  readiness before waking blocked browser operations. Offline intent waits on
  connectivity, not on a human Return button.
- [x] Reuse bounded reconciliation infrastructure; service startup invalidates
  earlier overrides and reconciles them. Do not mint recovery tickets or restore
  a previous human lease from a proof after restart/disconnection.
- [x] Shorten lease/renew timing to the shared constants. Renewal must validate live
  auth, exact viewer, unchanged override, current carrier and a nonexpired deadline.
  It cannot revive a missed deadline even if an expiry sweep has not run yet.
- [x] Media and status-channel loss invalidate the controlling viewer's override;
  passive losses have no authority effect. Fence delayed callbacks by override ID.
  Revoked mobile visits end their own override; expiry covers missing notifications.
- [x] Return, explicit Close, hidden view, auth loss and uncertain-input failure
  converge on the same service/daemon end implementation with a bounded reason code.
  A foreign client cannot use this path to end another viewer's override.
- [x] Adapt any retained explicit account-owner override action separately; never
  call it as a generic passive viewer disposal fallback.
- [x] Publish a single authoritative metadata projection used by web/mobile/chat:
  agent/human owner, this-viewer ownership, appropriate action availability, and
  runtime readiness. Remove combinations that imply persistent human ownership
  after the lease is gone. Do not expose another viewer's credentials.
- [x] Change `browser_request_handoff` so its task wait does not pause the whole
  browser before takeover. Associate the request with an actual override when
  taken up. A skipped/unanswered task cannot be reported as completed.
- [x] Accept alternative user instructions while a help request waits. Resolve or
  supersede that task wait using the existing turn/invocation model, then continue
  with the new instruction without acquiring human authority. Preserve message
  ordering and cancellation; do not both resume the old wait and start duplicate
  work. A later click on a superseded help prompt must refresh current state.
- [x] Resume eligible override-blocked invocations once when authority returns and
  readiness is confirmed. Propagate release reason so the agent checks the page
  rather than assuming successful login/input. Preserve invocation/call identity,
  cancellation, owner stamps and cross-thread wakeup rules.
- [x] Remove proof recovery, pause/acquire-to-return and sticky failure handlers;
  update routes, agent tool descriptions and prompt guidance.

## Validation

- [ ] SQL/HTTP: anonymous401, foreign404, scoped mobile session mismatch, Origin
  checks, expired auth, concurrent acquisition and old-end/new-acquire races.
- [ ] Expiry while input is busy cannot be postponed indefinitely by `exclusive`.
- [ ] Lost end ACK and repeated cleanup converge without replay or double continuation.
- [ ] Service crash before/after persisted intent or daemon ACK reconciles on startup.
- [ ] Handoff never taken up does not block unrelated threads; canceled/completed
  turns do not restart on automatic release. Timings exclude genuine task waits.
- [ ] Alternative instructions supersede a pending help request once, with no
  control mutation or false human-completion result. Concurrent takeover/reply
  respects any actually active override before admitting agent browser work.
- [ ] No frame, typed text, focus token or credential appears in diagnostics.
- [ ] Service compile and focused controller/repository/continuation/relay tests.

Update service/agent specs, auth checklist and protocol. DB schema and migration
changes remain owned by Phase 1; no second controller store or scheduler.

## Recorded evidence

See [Phase 5 implementation record](phase-5-validation-and-cutover.md#implementation-record) for commands/results and outstanding physical checks. Broader acceptance boxes above remain open where the full scenario has not been run.
