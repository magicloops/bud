# Mobile handoff: shared client state follow-ups

Implementation date: 2026-10-05; revised 2026-10-06 ([Phase 6](phase-6-review-hardening.md)).
Service and web implementation exists. Mobile is not live: build against this
contract directly; there is no older behavior to remain compatible with.
Native adoption and physical acceptance are outstanding. This supplements the
earlier backend/mobile handoff.

## Upgrade together

Run service `pnpm db:migrate` through `0050_pending_request_notifications.sql`
before starting this service. Startup verifies the triggers. Web deploys with
the service. No daemon change and no mobile step gates the merge; record the
first adopting mobile build in validation-and-rollout.md when it exists.

## Exact history boundaries (F3)

Message cursors are opaque, thread-bound v2 strings with PostgreSQL microsecond
precision. Do not derive cursors from a displayed timestamp. Old, malformed and
wrong-thread cursors return `400 {"error":"invalid_message_cursor"}`.
Reset the history window once with `/api/threads/:thread_id/open?limit=100`, keep
separately tracked optimistic/live messages, and paginate using the new response.
A reset is not end-of-history and must not loop on the rejected cursor. Normal
network failures still allow retry. An anchor deletion does not invalidate v2.

## Cheap state and optional budget (F2)

`/open` and `/agent/state` no longer reconstruct context. They include
`context_budget` only when an active runtime decision belongs to the active turn.
This describes that running turn; changed preferences apply to the next turn.
It is not an idle estimate. Preserve supplied source/model/turn/stale fields.
`included.context_budget` on open means the property was supplied, even if its
status is unknown. Omission means no update; it does not clear a known meter.

GET `/api/threads/:thread_id/context-budget` returns `{context_budget: ...}` with
no-store. It reuses an applicable active decision or calls the existing full
accounting/reconstruction path. Authorization precedes all runtime/context reads
(401 anonymous; 404 missing/foreign thread). This endpoint can still be expensive;
there is no new idle cache or performance SLO.

Paint chat first. Read budget independently when omitted/stale, on relevant
model/compaction/lifecycle changes, or explicit refresh. Do not loop on unknown.
A supplied nonstale unknown snapshot avoids an immediate redundant read. Fence
late responses by owner/thread and newer live budget evidence. Transient failures
retain the meter. Budget reads contain no transcript or stream cursor.

## Pending inventories (F1)

The existing authorized agent SSE stream adds:

```text
event: agent.pending_requests_changed
id: <ordinary opaque agent-stream cursor>
data: {}
```

The payload is empty; ignore any fields. Every hint invalidates all five
inventories. It contains no request content or identity and is not an execution event. Commit notifications cover creation,
decision, cancellation, persisted expiry/staleness/repair, and joined invocation/
action visibility. No hint is published on rollback. Time passing alone is not a
commit: expiry becomes canonical when existing maintenance persists the change.

Coalesce hints into one GET `/agent/state`; if another arrives during the read,
discard that response's pending inventory and fetch again. Apply only these arrays
as replacements, including empty arrays:

| Inventory | State field |
|---|---|
| Questions | pending_questions |
| App permissions | pending_data_requests |
| Activation reviews | pending_automation_requests |
| Existing-contact reviews | pending_bootstrap_requests |
| Browser waits | pending_browser_waits |

Keep canonical tool results and unrelated live tools/reasoning/text. Do not apply
that targeted response's cursor, runtime activity or drafts. Failed dirty reads
retry with capped backoff, stop on definitive resource/auth loss, pause while
hidden and revalidate on foreground.

Backstop: while the thread is visible, repeat the same coalesced GET
`/agent/state` once per 60 seconds, restarting the interval after any completed
inventory read (hint-driven or not). Apply it exactly like a hint-driven read.
Never use `/open` or `/context-budget` for the backstop; do nothing while hidden.
Standalone permissions/automation screens remain outside this contract.

Duplicate hints are harmless. Existing bounded replay applies; listener loss,
publication failure, overflow or stale cursor require full `/open` recovery and
loaded-history reconciliation. These notifications are not a durable event log.
Only full stream bootstrap/recovery adopts the snapshot stream boundary.

## Measurements and execution (F5/F6)

Backend exports route-template histograms at INFO every 60 seconds, independent
of suppressed fast request logs. See measurement-runbook.md. Mobile should still
measure network, decode and paint separately. No production before/after numbers
have been collected for this change.

Existing committed invocation wakeups already wake the in-process worker. The
one-second scan remains recovery/maintenance; this is not a fixed one-second
saving and the notification is not execution authority.

## Remaining work

F4 account disablement/revocation is not implemented by this release. Policy
choices remain open in phase-5-account-policy.md. No stronger token/stream/offline
revocation guarantee is being introduced. Phase 4 budget caching is deferred
until measured demand justifies its invalidation complexity.

Executable regression scenarios live in service message-cursor/change-listener/
pending-events tests and web client-state-refresh/use-pending-requests/
use-context-budget tests. Run these as contract examples; native execution has
not been validated by those tests.

[Supplemental fixtures](contract-fixtures.json) include an actual v2 encoder
result, pending hint/empty and question inventories, and omitted/available/stale/
unknown budgets. These are synthetic examples; available budget fields come from
the service builder with illustrative model limits. Existing full transcript/tool
fixtures in the prior backend-mobile-performance handoff remain applicable.
