# Phase 3: Pending-request invalidation and client convergence

Status: Service and web implemented; SQL notification and client race tests pass.
Request: F1. Physical two-client producer/recovery acceptance pending.
Amended by [Phase 6](phase-6-review-hardening.md): empty payload, 60-second
visible-thread backstop, no mobile compatibility requirement.

## SSE contract

Add `agent.pending_requests_changed` on the existing authorized thread stream:

```json
{}
```

The payload is empty; every hint invalidates all five inventories.
No IDs or payloads are necessary: inventories are bounded and clients reread
state once. Normal SSE event ID/resume semantics apply. This is an invalidation
hint, not a state delta, execution wake, or durable delivery promise. Duplicate
hints and coalescing are allowed; every committed visible change must invalidate
the affected inventory or explicitly force canonical resync.

## Mutation coverage

Before editing, inventory every writer and record its file/function/transaction
owner against this matrix, including raw-pg paths:

| Inventory | Required boundaries |
|---|---|
| Questions | Creation/park visibility, answer, skip/supersession, cancel, repair |
| App permissions | Creation/park, approve/decline, expiry, invalidation/cancel |
| Activation reviews | Creation/park, decision, expiry, draft/grant staleness, cancel |
| Bootstrap reviews | Creation/park, decision, expiry, staleness, cancel |
| Browser waits | Park/create, return/resolve, user interruption, timeout, cancel, recovery |
| All | Invocation reservation/action changes that add/remove visible rows, thread deletion |

Implementation uses migration-owned PostgreSQL AFTER triggers on request and
joined invocation/action tables, reusing `bud_thread_changes`. This supersedes
the planned application callback collection and adds migration 0050. PostgreSQL
delivers only after the outer commit, including raw-pg and direct SQL writers.
All five inventories invalidate together. Current owner/thread authorization is checked
before publication. Existing bounded runtime replay and invalidateReplay handle
publication/notification loss. See [mutation coverage](mutation-coverage.md).
No Redis, outbox, new table or execution authority is introduced.

## Client algorithm

1. Bootstrap via `/open`, then attach after its captured cursor. Apply ordinary
   invocation/transcript events using existing reducers.
2. On a pending hint, mark inventory dirty and start one cheap state request if
   none is active. Coalesce a burst; a hint during the request schedules one
   follow-up after completion. Never lose the dirty mark on failure.
3. Apply pending arrays as canonical replacements, including empty arrays that
   remove obsolete synthetic cards. Reconcile by stable client/request identity;
   preserve canonical transcript rows and newer live drafts/activity. Do not
   move stream cursors or trigger history reconciliation for a card-only change.
4. Fence reads by owner/thread and request generation. If invalidated during a
   read, avoid displaying its obsolete inventory and fetch again. Retry failed
   dirty refreshes with capped backoff; pause background work and retry on
   foreground. This is recovery of known dirty state, not an idle polling loop.
   Separately, one cheap backstop read runs per 60 visible seconds (Phase 6).
5. Replay gaps, publication failures and service restarts use full existing
   bootstrap/transcript reconciliation. Recheck on foreground/reconnect.

After passing coverage/recovery tests, remove web's five-second durable thread
poll and corresponding mobile fallback for covered kinds. Invocation status
events alone still update badges; transcript repair events/recovery own transcript
truth. Do not replace the removed poll with `/open` on every lifecycle event.
Standalone owner-level permission/automation screens are outside this phase.

## Acceptance

- [ ] Writer matrix covers every kind and every visibility-changing path.
- [ ] Two sessions: create on A and resolve on B; both converge without polling,
      even with worker slots occupied and no later tool output.
- [ ] Expiry/staleness/cancel/repair with closed clients recovers on next attach.
- [ ] Rollback, nested transactions, delayed callbacks, raw-pg commit, duplicate
      hints, mutation during refresh and publication failure tested.
- [ ] Open/read/attach race and replay-miss recovery preserve pending cards,
      canonical finals, history and active drafts; no cursor advancement skips events.
- [ ] At most one cheap agent-state read per 60 seconds, and zero recurring
      open/budget requests, during ten minutes of a healthy idle visible thread.
- [ ] Unauthorized/cross-owner attach/replay rejected; no sensitive event fields.
- [ ] Web stream/reducer tests and mobile full-response/replay fixtures delivered.

Update `docs/proto.md`, runtime/agent/personal-data/browser specs and the mobile
handoff. Trigger-only migration 0050 is required; no daemon protocol change.
