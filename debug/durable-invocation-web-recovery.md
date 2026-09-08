# Debug: Web recovery of durable invocations

## Environment and reproduction

Development web client against the conditional durable-admission service. Park a question, restart the service, then reload the thread; alternatively queue a turn while its selected model is offline.

## Observed

The browser only projects process-local `active`/`pending_tool`. It ignores persisted `pending_questions` and `invocations`, and its response union omits `durable_invocation`. Queued admissions can remain visually dispatching without a worker SSE event.

## Proposed fix

Restore canonical pending questions independently of process liveness, refresh after durable answers, and show persisted invocation status separately from live token activity. Reconcile visible durable threads periodically through existing owner-authorized APIs, with non-overlapping requests and stale-thread guards. Preserve legacy-service behavior when additive fields are absent. No new reads or writes bypass server thread authorization.

## Validation

Web production build passed and 23 focused question/reconciliation/status tests passed. An edit helper initially used `web/src/...` while running in `web/`, producing `FileNotFoundError`; rerunning that edit with an absolute path corrected the tooling error. No source change occurred during the failed edit. Final validation after additional stale-runtime guards is recorded in the plan.
