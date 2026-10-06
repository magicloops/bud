# iOS Performance Backend Follow-Ups: Backend Response

**Status:** Implemented in PR #140 (`codex/client-state-performance`); not yet merged or deployed.
**Audience:** iOS, web platform, backend
**Date:** 2026-10-06
**Answers:** [`IOS_PERFORMANCE_BACKEND_FOLLOW_UPS.md`](IOS_PERFORMANCE_BACKEND_FOLLOW_UPS.md) (F1–F6)

## At a glance

| ID | Outcome | Mobile action |
|---|---|---|
| F1 | Delivered: `agent.pending_requests_changed` stream event | Replace the 5-second poll with hint-driven reads plus a 60-second backstop |
| F2 | Partly delivered: budget is in `open` only during an active turn; new `/context-budget` read otherwise | Read the budget from `/context-budget`, not `agent/state` |
| F3 | Delivered: exact-precision v2 cursors | Handle `400 invalid_message_cursor` by resetting the history window |
| F4 | Not delivered | Keep transcripts off disk until it is |
| F5 | Delivered service-side: per-route latency histograms in logs | None |
| F6 | Confirmed: the worker already wakes on admission | None |

These are breaking changes with no compatibility window. Mobile is not live, so
the service does not keep the 0.2.0 behavior: build the next mobile version
against this contract. Until then a 0.2.0 build pointed at the new service
still works, but shows no idle context budget and fails to load earlier history
from any cursor it obtained before the deploy.

No daemon change. All routes keep existing auth: `401` for an unauthenticated
request, `404` for a missing or foreign thread.

## F1: pending-request changes

The thread's agent stream (`GET /api/threads/:thread_id/agent/stream`) adds:

```text
event: agent.pending_requests_changed
id: <ordinary agent-stream cursor>
data: {}
```

The payload is empty and means "reread pending inventory". It does not carry a
kind or request ID as F1 suggested: the inventories are small, and one reread
covers all of them. Ignore any fields that appear later.

The hint fires after commit whenever a pending request is created, answered,
approved, declined, canceled, expired or repaired, from any device or from
service maintenance. It covers all five inventories:

| Inventory | `agent/state` field |
|---|---|
| Questions | `pending_questions` |
| App permissions | `pending_data_requests` |
| Automation activation reviews | `pending_automation_requests` |
| Existing-contact (bootstrap) reviews | `pending_bootstrap_requests` |
| Browser waits | `pending_browser_waits` |

Expiry is published when the service persists it, not at the wall-clock moment.

### What mobile should do

1. On a hint, read `GET /api/threads/:thread_id/agent/state` once. Coalesce a
   burst into one request.
2. If another hint arrives during the read, discard that response's inventory
   and read again.
3. Replace the five arrays above with the response, including empty arrays
   (an empty array removes the card). Apply nothing else from this response:
   not `stream_cursor`, not runtime activity, not drafts.
4. Keep canonical tool results and unrelated live tools, reasoning and text.
5. On failure, keep the inventory marked dirty and retry with capped backoff
   (web uses 1 s doubling to 30 s). Stop on `401`, `403` or `404`.
6. Do nothing while backgrounded; reread once on return to the foreground.
7. **Backstop:** while the thread is visible, repeat the same read once every
   60 seconds. Restart the interval after any completed inventory read,
   hint-driven or not. Never use `open` or `context-budget` for the backstop.

Remove the 5-second `agent/state` poll and the Phase 4e "poll while a card is
on screen" fallback for all five inventories. An idle visible thread should
make about one `agent/state` request a minute instead of 11–13.

The event uses normal stream IDs and bounded replay; duplicates are harmless.
A stale cursor, `agent.resync_required` or a reconnect still means full
recovery through `open`, as today. Only that full recovery adopts a new stream
cursor.

`agent/state` is now cheap: it never reconstructs model context (see F2).

## F2: context budget

Computing the budget for an idle thread reconstructs the model context, so it
is too expensive to put in `open` unconditionally. Instead:

- `open` and `agent/state` include `context_budget` only when a turn is active
  and the running turn already has a budget decision. That value describes the
  running turn, not the next one.
- `included.context_budget` on `open` is `true` when the field was supplied,
  even if its `status` is `unknown`.
- When the field is omitted, treat it as "no update". Do not clear a meter you
  already show.
- New: `GET /api/threads/:thread_id/context-budget` returns
  `{"context_budget": ...}` with `Cache-Control: no-store`. This is the read to
  use for an idle thread. It can be slow; there is no cache yet.

### What mobile should do

- Stop reading `agent/state` after `open` for the budget.
- Paint chat first. If `open` supplied a budget that is not `stale`, use it and
  skip the read (this includes `status: "unknown"`; do not loop on unknown).
- Otherwise read `/context-budget` independently, and again after a turn ends,
  a compaction, a model change or an explicit refresh.
- Drop a late response if the user changed thread or account, or if newer
  budget evidence arrived from the stream. Keep the meter on a failed read.

## F3: cursor precision

Message cursors are now opaque v2 strings that carry PostgreSQL microseconds
and are bound to their thread. The boundary comparison stays strict (`<` / `>`),
as requested. Never build a cursor from a displayed timestamp.

An old-format, malformed or wrong-thread cursor returns:

```text
400 {"error":"invalid_message_cursor"}
```

The error code changed from `invalid_cursor`.

### What mobile should do

- Discard any cursor obtained from an older service.
- On `invalid_message_cursor`, reset the history window once with
  `GET /api/threads/:thread_id/open?limit=100`, keep optimistic and live rows
  you track separately, and page from the new response's cursors. Do not adopt
  that response's `stream_cursor`.
- Do not treat the rejection as end-of-history, and do not retry the rejected
  cursor. Ordinary network failures still retry.

Deleting the row a cursor points at does not invalidate the cursor.

## F4: account disabled/revoked

Not delivered. No new error, token revocation or stream shutdown guarantee
exists. The policy questions are listed in
[`phase-5-account-policy.md`](../plan/client-state-performance/phase-5-account-policy.md).
Phase 7b (transcripts on disk) and Phase 8e should stay blocked on it.

## F5: latency percentiles

The service logs a per-route latency histogram every 60 seconds (route
template, method, status class, bucket counts, response bytes). It is a
backend log, not an API, and it contains no IDs. No production baseline has
been captured yet, so there are no before/after numbers for this change.
`Server-Timing` is unchanged; keep measuring network, decode and paint on device.

## F6: worker wake-on-admission

Confirmed: it shipped before this work. A committed invocation wakes the
in-process worker immediately. The one-second scan remains only for recovery
and maintenance.

## Still deferred

Unchanged from 2026-09-30: transcript deltas and tombstones, durable list
resume, shared replay infrastructure and catalog-version propagation. An idle
budget cache is also deferred until measurements justify it.

## Fixtures and detail

- [Contract fixtures](../plan/client-state-performance/contract-fixtures.json):
  a real v2 cursor and its rejection, the pending hint, empty and question
  inventories, and omitted/available/stale/unknown budgets. Synthetic data.
- [Full contract notes](../plan/client-state-performance/mobile-api-handoff.md)
  and [`docs/proto.md`](../docs/proto.md).
- Reference behavior: web `use-pending-requests.ts`, `use-context-budget.ts`
  and the cursor reset in `use-thread-messages.ts`, with their tests.

Not yet verified: any native build against this contract, and the two-device
create/answer/expire flow on physical devices.
