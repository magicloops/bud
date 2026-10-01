# Phase 4: Bounded Thread List and One User Feed

**Status:** Service/web implemented and locally tested; native adoption and deployed measurements pending.
**Dependency:** Phase 0; share the summary loader with Phase 3.
**Parent:** [Implementation spec](implementation-spec.md).

## Outcome and bounded reads

Replace per-Bud invalidation streams with one user-scoped feed of canonical row
upserts/removals. Full GETs occur on initial subscription/reconnect and explicit
recovery, not after every normal row change.

Add bounded `GET /api/threads?limit=50&cursor=…` with a cap of 200 and a response
containing `threads` and `page: { next_cursor, has_more }`. These list defaults are
initial choices to validate in Phase 0, not existing behavior. Preserve current
filter semantics unless an explicit filter is supplied; do not silently hide
archived threads. Use the current descending tuple
`(last_conversation_at, created_at, thread_id)` with explicit null ordering and exact
timestamp precision. Encode the complete tuple and filter scope in an opaque cursor;
reject malformed or mismatched cursors. Apply ownership/filter predicates in SQL
before limit. Avoid a full count on each page.

Use one shared summary loader for list GET, upserts and `open`. Document every field
and its source table/runtime input. Add only indexes justified by the query plan.

## Feed and bootstrap ordering

Add `GET /api/me/thread-list/stream` with named `ready`, `upsert`, `remove`,
`resync_required` and `heartbeat` events. An upsert carries a full canonical summary;
a remove carries only `thread_id`. No durable `since`/`Last-Event-ID` resume contract
or list ETag is introduced in this phase.

The client subscribes, waits for ready, then fetches its bounded window while
buffering patches. Merely applying every buffered patch after GET can regress a
newer snapshot. Use a small process-local ordering contract:

1. The user-scoped publisher owns an epoch and sequence for delivery order.
2. Serialize snapshot queries and summary materialization/publication through that
   scope's bounded coordinator. Notifications mark rows dirty; materialize their
   current authorized summaries inside the coordinator, not before enqueueing.
3. List GET returns a `feed_checkpoint: { epoch, sequence }` marking publications
   covered by the snapshot. Queued dirty rows are reloaded/published after the
   snapshot. The client discards buffered events through that checkpoint and applies
   later events in order. No cursor decoding or timestamp comparison is required.
4. Epoch mismatch, lost notification continuity or bounded-queue overflow requires
   resubscription and a fresh bounded GET. The checkpoint is not resumable after
   reconnect/restart and has no durable retention promise.

Prove these semantics with interleaving tests before freezing fixtures. If the
coordinator becomes too complex or slow, revise the bootstrap mechanism explicitly;
do not ship the stale-patch race. Keep coordination local to list publication and
reads, with no client-I/O locks or separate permanent database listener per viewer.

## Complete invalidation and delivery

Extend existing DB notifications/publication to every represented field: preview,
count, conversation order, title, attention, pin/archive, preference, read watermark,
terminal summary and ownership. Include joined-table changes and service-derived
configuration changes where represented. Ignore lease/output heartbeats that do
not change the summary. Reuse the existing shared LISTEN infrastructure.

Coalesce dirty thread IDs (initial target 250 ms), reload each once per owner scope,
then fan out. Bound dirty queues and connection buffers; overflow causes resync.
Ensure trailing changes are delivered. A LISTEN disconnect is a continuity loss,
not permission to keep clients indefinitely stale. Recheck auth/ownership during
delivery and on existing idle checks. On ownership loss, remove only an ID known
to have been visible, or force resync without leaking the new owner's data.

## Client list semantics

Maintain a bounded loaded window, sort with the canonical tuple, deduplicate IDs,
and evict overflow. Upserts may move rows into or out of visible filters; archive
only removes a row when the client's filter excludes it. Removal/movement can
leave a short window: issue a bounded refill when needed. Invalidate older-page
cursors when mutations make their boundary unreliable, and restart paging from
the retained window boundary rather than pretending pages form a stable snapshot.
Test deletion of the final visible row, pin/archive changes and equal timestamps.

## Validation, migrations and rollout

Cover multiple users/Buds, foreign cursors, owner changes, joined read-state updates,
every summary field, before-ready and during-GET changes, stale materialization,
coalescing, page movement, reconnect, auth expiry, listener loss, slow clients and
shutdown cleanup. Query work must not multiply by subscriber count.

Touch thread core/list-stream routes, DB metadata/triggers, joined-state publishers,
web list loaders/reducers and API types. Trigger/index changes need checked-in
migrations plus DB/migration specs; update routes/protocol/web specs and auth tests.

Pagination's default response change is breaking. Coordinate web/mobile adoption
before enforcing it, or use the smallest explicit opt-in bridge required by a
named current client and remove it immediately after the controlled upgrade.
Retire the per-Bud stream only after both clients migrate. Acceptance: one list feed
per signed-in client, bounded reads, fresh summary fields and no full GET per upsert.
