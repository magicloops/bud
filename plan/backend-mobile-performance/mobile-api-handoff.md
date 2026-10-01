# Mobile API handoff: backend performance

This is the contract for the matching service/web working-tree change dated
2026-09-30. It is not deployed. Production is currently one service instance,
confirmed by Adam. Native build/version and production measurements are unverified.
The accompanying [fixtures](mobile-api-fixtures.json) are synthetic examples;
existing model, invocation, message and thread schemas still apply.

## Coordinated release

Apply `0048_lush_timeslip.sql` and `0049_thread_change_publication.sql` using
`pnpm db:migrate` before starting this service. Deploy the matching web and a mobile
build implementing this document together. Tool serialization and the list response
are breaking changes; old mobile builds using JSON-in-content or the per-Bud list
stream are unsupported. No daemon changes. Agree the actual mobile build number
before merging because service deployment follows main automatically.

Keep receipt rows and admitted work on rollback. A service restart invalidates
process-local stream cursors/checkpoints; clients must recover with fresh snapshots.
Rolling back the service alone is insufficient: restore matching clients and the
old list notification trigger if returning to the old list implementation. Do not
drop receipt data. No deployment, restart or production migration was performed.

## Create a conversation and send its first message

`POST /api/threads` accepts the existing initial thread fields plus `creation_key`
and `opening_message` (the ordinary message request, including `client_id`, text,
model/effort, cwd and viewport). A key is required with an opening message.

Persist the exact request and key until its outcome is known. Retry that same
request after a lost response. Equivalent concurrent retries produce one thread,
message and invocation. New returns 201; retry returns 200 with the current owned
`thread`, `message`, `invocation`, `thread_id` and queued `agent` envelope. A changed
intent with the same key returns 409; deleted/unavailable results return 404.
Receipts have no retry TTL. Keys are owner scoped. Validation and model availability
errors do not create empty threads. Durable admission is required (503 otherwise).

Opening-message selection overrides initial thread selection, then the service
default. `agent.started:false` means admitted, not failed. Open the returned thread
to recover anything completed before the create response; do not attach live-only
and assume earlier output is retained. Empty-thread creation remains supported.

## Open, compact messages and recovery

`GET /api/threads/:thread_id/open?limit=100` returns `thread`, `transcript`,
`agent_state`, `stream_cursor` and `included`. Limit is 1–200. Required read failure
fails the request. The response is private `no-store` and is **not an atomic database
snapshot**. One runtime snapshot/cursor is captured before all canonical reads.

Attach `/api/threads/:thread_id/agent/stream?after=<stream_cursor>` using that opaque
cursor. `included` is `{web_view:false,browser:false,context_budget:false}`; omitted
optional data is not an authoritative null. Load those features separately when
needed. Existing paged messages and standalone agent state remain available.

Tool rows use `tool_payload` (object or null) and `presentation:{kind,id,status}`.
Kinds: `questions`, `app_permission`, `automation_activation`, `bootstrap`,
`browser_handoff`, `terminal`, `generic`. ID/status may be null for historical
evidence. Never infer approval/success from missing status. Pending calls have
pending presentation; canonical results retain their actual payload. Human display
`content` is a summary, not a second copy of tool JSON. Service timing/path/model
metadata stays in `metadata`; payload details live in `tool_payload`. Non-tool
content and stored model replay are unchanged. Plain malformed historical content
is retained. Unknown kinds should render a generic tool view.

`agent.tool_result` keeps identities, name, summary, truncation and service timing
plus `message`; duplicated outer result fields are removed. Use the same message
decoder for REST, `transcript.message` and embedded canonical SSE messages.

Reconcile by `client_id`. A persisted canonical row wins over older replayed
drafts, calls and insert events, even if the event arrives after the HTTP response.
`agent.invocation_changed` carries canonical committed invocation state; apply
the ordered invocation reducer without treating it as proof of transcript coverage.
`transcript.message {message}` covers all committed message inserts, including
backfills and continuations. It can duplicate other canonical events.

`transcript.invalidated {message_ids}` means canonical rows may have changed or
disappeared. Coalesce recovery, close the old stream, open a new boundary and
reconcile loaded messages. `POST /api/threads/:thread_id/messages/reconcile` is a
read-only bounded request `{message_ids:[UUID...]}` (1–200 IDs) returning
`{messages,missing_message_ids}`. Only requested, currently owned rows are returned;
missing IDs are not a cross-owner existence signal. Batch loaded older history too,
and discard obsolete request generations. Remove only requested missing rows.

On `agent.resync_required`, unknown cursor, replay eviction, listener loss or
restart, repeat that recovery. Do not compare opaque cursors or reconnect forever
with the same invalid cursor. Preserve scroll/history and optimistic messages;
never let late responses from another thread/account replace the current view.
The web retains its existing five-second durable-state fallback for non-message
pending-request recovery; this change does not claim those inventories are fully
event-driven. Native can retain its corresponding fallback until coverage is proven.

## Bounded list and one owner feed

Replace the per-Bud stream with `GET /api/me/thread-list/stream`. Authenticate,
wait for `ready {epoch,sequence}`, then GET
`/api/threads?bud_id=...&limit=50&cursor=...`, buffering events during the read.
The list returns `{threads,page:{has_more,next_cursor},feed_checkpoint:{epoch,sequence}}`.
Default 50, maximum 200; archived rows remain included. Opaque cursors bind the
owner and Bud filter; invalid/mismatched cursors return 400.

Ordering is descending `(last_conversation_at,created_at,thread_id)` using
millisecond timestamp precision. Both timestamp columns are non-null. A snapshot
and publications are coordinated within the owner scope. Discard buffered events
at or before its checkpoint; apply later sequences exactly once. Full-row
`upsert {thread,epoch,sequence}` and `remove {thread_id,epoch,sequence}` replace the
old changed→GET loop. Sequence covers all this owner's Buds: advance it even for
patches outside the currently displayed Bud.

Deduplicate, re-sort, cap the loaded window, refill short windows with a bounded
GET, and refresh a boundary before paging beyond it. These are moving pages, not
a frozen inventory. A gap, epoch mismatch or `resync_required` requires a new
subscription/snapshot. Heartbeats need no GET. Reconnect always snapshots; list
Last-Event-ID/durable resume is not supported. Queue overflow or auth/ownership
loss closes the connection. One shared database listener serves list/transcript
publication, not one database connection per mobile stream.

## Read, discovery and measurement

`POST /api/threads/:thread_id/read {last_seen_message_id}` returns
`{ok,updated,last_seen_message_id,summary:{unseen_thread_count,updated_at}}`.
Use that summary rather than an immediate extra summary GET. Watermarks advance
atomically by timestamp/ID; stale requests return the winning watermark. Summary
time is observation time, not a revision or a promise against concurrent writes.

Issuer discovery freshness is one hour: `public, max-age=3600,
stale-while-revalidate=15, stale-if-error=86400`. Cache by issuer/environment. On a
relevant endpoint/configuration error refetch metadata once, then surface failure;
credential rejection must not become a discovery retry loop. Token and JWKS cache
policies and revocation guarantees are unchanged. Production proxy behavior still
needs measurement.

`Server-Timing` reports processing before headers, excluding network transfer and
device decoding. SSE header/first-frame timings differ from connection lifetime
and first model output. A synthetic 2,000-line tool fixture shrank from 244,205 to
119,328 JSON bytes; gzip from 11,696 to 5,922. This is one deterministic fixture,
not a mobile p50/p95 claim. Measure device decode, launch/open/reconnect, concurrent
sends, transferred bytes and pool wait after the coordinated release.

Local choices that can change with evidence: page limits, 250 ms coalescing,
bounded queue sizes, discovery TTL and single-process coordination. Ownership,
idempotency, honest outcomes and explicit recovery are correctness requirements.
Multiple service instances need a separate routing/publication/replay design;
PostgreSQL notifications alone do not make current runtime replay distributed.
