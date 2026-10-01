# iOS Performance Backend Requests

**Status:** Reviewed against service `9d6b300`. Recommendations below; not yet implemented.
**Audience:** Backend, web platform, iOS
**Last Updated:** 2026-09-30
**Based on:** `reference/IOS_PERFORMANCE_BACKEND_QUESTIONS.md` (answered against
service `9d6b300`), `review/2026-09-30-mobile-performance-latency-review.md`,
`plan/perf/`

## Purpose

Mobile is running a performance plan (`plan/perf/`). Mobile-only work covers most of
it: main-thread fixes, parallel requests, and local caching. This doc collects the
**backend changes we recommend**, which remove latency that mobile can't remove on its
own. Most also benefit the web client.

For each request: the problem (with evidence), a proposed contract (a sketch, open to
backend redesign), requirements, how mobile will use it, and how to measure it.

We're asking the backend team to confirm or adjust each contract and to pick a
priority. Once a request is agreed, it gets a normal cross-repo handoff with versions
and deployment order.

## Backend review and recommended scope

The API simplifications are worth doing. The durable synchronization infrastructure
bundled into R2/R3 is not justified yet. Start with bounded canonical snapshots,
reliable event coverage, and explicit resync on gaps. Mobile's proposed v1 cache
already replaces its latest window, so it does not require a durable delta protocol.
The original requests below remain proposal sketches; this review narrows them.

| Request | Recommendation | Scope worth implementing |
|---|---|---|
| R1 | **Do first** | Post-commit worker wake, fill available execution slots, committed invocation status events |
| R2 | **Do, simplify** | Authorized thread-open snapshot and safe stream attachment; defer transcript deltas/tombstones |
| R3 | **Do, simplify** | Bounded list and one user-scoped feed with canonical row patches; defer durable resume |
| R4 | **Do** | Atomic, idempotent thread creation plus first-message admission |
| R5 | **Do** | Shared presentation/serialization and one tool payload on the wire; measure before adding projections |
| R6 | **Do early** | Handler timing, route metrics, queue timing; use existing logging/metrics facilities |
| R7 | **Separate correctness work** | Explicit account/session policy and enforcement; not a prerequisite for parallel startup |
| R8 | **Defer unless cheap** | Scoped ETag; no inventory-wide catalog version machinery |
| R9 | **Small useful follow-up** | Return badge summary without an unbounded in-memory recount |
| R10 | **Small useful follow-up** | Document and increase discovery freshness with bounded error recovery |

### Evidence, uncertainty, and changeable constraints

- **Confirmed in source:** the worker schedules at most one execution attempt per
  second; list reads are unbounded; current invalidation is incomplete; ordinary
  tool results duplicate payloads; the existing stream buffer is bounded and
  process-local. See the [question responses](IOS_PERFORMANCE_BACKEND_QUESTIONS.md)
  for the current contracts and source references.
- **Not measured here:** production route percentiles, queue latency distributions,
  representative transferred page sizes, or mobile's actual request waterfall.
  The mobile plan/review named above lives outside this repository and was not
  inspected. Request-count estimates are the mobile team's evidence, not an
  independently reproduced trace. Parallel requests and HTTP/2 also mean fewer
  requests do not translate directly into the same number of saved round trips.
- **The 500 ms estimate is conditional:** with idle capacity and arrivals uniformly
  distributed across the one-second poll, expected scheduling wait is about 500 ms.
  Busy capacity, database contention, preflight and terminal setup change that.
  R1 removes avoidable scheduling delay; it does not promise a one-second p95 win
  or an equivalent improvement in first model output.
- **Current limits are implementation choices:** polling, per-bud feeds, snapshot
  composition, duplicate wire payloads and discovery TTL can change. Durable
  admission, transaction boundaries, lease fencing, ownership and honest recovery
  from stream gaps remain correctness requirements.
- **Deployment assumption:** [render.yaml](../render.yaml) configures one service
  instance. This is not proof of live topology. Confirm it before implementation;
  do not introduce shared replay storage, sticky routing or another dedicated
  PostgreSQL listener solely for hypothetical horizontal scaling.

### R1 review — remove the scheduling delay without redesigning the queue

Implement a serialized, bounded claim pump, local wake after transaction commit,
and immediate refill when a running task releases capacity. Keep the existing
database claim and lease/fence rules. Calling today's `runOnce()` repeatedly is
not sufficient: it awaits execution and also runs recovery/expiry scans each time.
Separate claiming from executing and schedule maintenance deliberately. Stop on
no claim, avoid busy loops under contention, and preserve shutdown behavior.

Wake coverage must include automation/bootstrap admission and transitions that
make parked work eligible (answers, approvals, browser returns), not just the
human messages route. Admissions nested inside another transaction must wake only
after the outer commit. Keep periodic checks for lost hints, future retry times,
deadlines and expired leases; five seconds is a tuning proposal, not an established
safe interval. Do not slow recovery until its deadline/lease behavior is validated.

Prefer one invocation-status event derived from committed repository state over
three independent event types. Claim means `leased`/preflight; `running` begins
after successful preflight. Include waiting, resume, cancellation and terminal
transitions, and recover through state. Do not emit progress on every lease
heartbeat. Define event ordering so older replay cannot overwrite newer status.
The existing [timing publisher](../service/src/agent/invocation-timing.ts) provides
a useful post-commit publication pattern.

Defer cross-instance `pg_notify` unless another worker/gateway actually needs it.
Existing listeners and the mode lock already consume pool connections; copying
that pattern has a cost with the configured five-connection main pool. Measure
admission-to-claim separately from admission-to-output, including concurrent sends.

### R2 review — combine reads, defer a durable transcript change feed

Build `open` from shared authorized loaders for thread summary, latest transcript
window, timings and agent state. Keep `limit` bounded. Include only cheap optional
attachments; omit slow sections with an explicit inclusion indicator and load them
separately. Awaiting an optional section in one JSON response still delays the whole
response. Keep model catalog caching separate. This does not by itself eliminate
the separate browser-state connection.

Capture the stream boundary before canonical reads and reuse the existing cursor
and `after` contract. **Boundary capture alone is insufficient.** Audit every
durable transcript mutation for post-commit canonical events or an explicit
invalidation/resync path. For example,
[prepareQuestionContinuation](../service/src/agent/invocation-repository.ts)
inserts transcript rows, and the worker does not publish its returned rows.
Preflight can also rewrite input content. Those paths must be covered before
removing attach-time recovery reads. Reconcile snapshot/replay overlap by message
identity and cursor order; mutable rows and state must not regress on older replay.

For v1, promise **no silent gaps**, with explicit resync when retention is exceeded
or the process restarts. Do not promise `valid_until`: a 60-second age limit plus a
256-entry limit cannot guarantee 60 seconds of replay under load. If resync rates
prove excessive, then consider buffer sizing or stronger replay infrastructure.

Defer per-row revisions, deletion tombstones and `since_revision`. They require
every writer to participate, precise latest-window membership/eviction semantics,
and correct pagination through changes, backfills and deletions. A per-thread
counter also cannot serve the per-user list cursor in R3. If measured unchanged
revisit bytes justify it, add one transcript validation mechanism that can skip
unchanged transcript bytes while still refreshing agent state. A response hash
saves transfer, not necessarily database work. Avoid simultaneously introducing
ETags, revision counters and multiple delta formats.

Validate writes between boundary capture, each read and stream attach, overlapping
updates, continuation/backfill paths, buffer eviction, restart, and foreign-owner
access. A compound response is not automatically a transactional snapshot.

### R3 review — one feed and complete summaries, without a durable event ledger

Implement bounded, deterministic list pagination and one owner-scoped stream.
Reuse a canonical summary loader/serializer across list GET, upserts and `open`;
today's [list query](../service/src/routes/threads/core.ts) includes joined read and
terminal state that the simpler thread serializer does not. Invalidate every
represented field, including joined state, while ignoring irrelevant heartbeats.
Coalesce changes and materialize a row once per delivery scope rather than issuing
one query per subscribed connection. Ensure the final coalesced value is delivered.

Initially use subscribe/ready → bounded GET, buffering patches during that GET,
and repeat on reconnect. This removes steady-state full-list refetches and N
connections without durable list revisions or tombstones. Define how patches
affect sorting, archive filters, loaded pages and eviction from a bounded recent
window; do not allow an initially bounded cache to grow forever.

Authorize before reads and delivery. Ownership loss must never deliver the new
owner's summary; emit only a removal for a previously visible ID, or force resync
when that visibility cannot be established. Keep SQL owner filtering. Durable
resume can follow if reconnect GET volume remains material; an ETag does not solve
the subscription race. The 250 ms coalescing interval is provisional.

### R4 review — worthwhile, and independent of transcript revisions

Reuse [admitInTransaction](../service/src/agent/invocation-repository.ts) within the
thread-creation transaction; do not add another queue or execution path. Persist an
owner-scoped creation receipt/key covering creation and admission, enforce uniqueness
under concurrent retries, return the stored result, and reject conflicting reuse.
Carry over current first-message options, including viewport/cwd if needed, and
define model-preference precedence once. Authorize the bud and stamp all owners.

Wake only after commit. A stream cursor in this response needs the same correctness
work as R2, so do not capture it after fast worker output has already escaped replay.
Do not promise `revision: 1` without adopting a revision protocol. This improvement
can ship before the full `open` endpoint and needs retry/race/rollback validation.

### R5 review — improve the wire shape first, preserve model evidence

Use one shared tool serializer and typed presentation across REST, live events and
state. Normalize historical rows on the server, including an explicit generic
fallback. Resolve pending/resolved presentation consistently with current action
state; a historical payload alone may have stale status. Avoid per-row database
lookups to classify a page.

Remove duplicate payloads from the **wire representation first**. Ordinary
[tool writes](../service/src/agent/transcript-writer.ts) duplicate content into
metadata, but continuation tool rows can keep the payload only in `content`.
Blindly dropping `content` loses those results. Keep the durable transcript and
model-replay evidence intact until all readers/writers are audited; a storage
migration is not required to reduce transfer and decoding.

Measure real tool-heavy pages after deduplication. Add a bounded preview plus an
ownership-authorized detail loader if large results still dominate. Truncation
must be explicit, preserve interactive IDs, and affect presentation rather than
durable model evidence. Avoid a second summary/full projection API until its value
is demonstrated. Wire changes need coordinated web/mobile serializer adoption.

### R6 review — small observability work first

Add handler timing and structured route metrics through existing facilities, plus
admission-to-claim and admission-to-output measurements. Record route templates,
sample counts, status and response size. Produce a baseline and compare the same
workloads after changes; a bespoke dashboard is not a prerequisite.

Report `auth`, `db` and `ser` only when their boundaries are actually instrumented.
Concurrent database operations do not sum to elapsed handler time. Define exactly
what `total` includes; handler duration excludes network transfer and client decode.
Instrument SSE headers/first event separately from the lifetime of the connection.
The absence of numbers in our review does not establish that no production metrics
exist; check existing logs/monitoring first.

### R7 review — decide the security policy separately

Clarify account deletion/disablement versus revocation of one credential/session.
A shared live-account gate is worthwhile correctness work if those account states
are product requirements. A revocation list or new disablement system is not a
performance optimization and should not be introduced just to parallelize `/me`.
Parallel startup can already use the same authentication contract as chat requests.

Document the access-token revocation bound. Immediate revocation requires a live
session/grant check or another explicit mechanism; revoking refresh alone cannot
provide it. Choose the smallest mechanism that meets the actual requirement, and
apply it to established streams as well as attachment. Distinguish expired auth,
ordinary resource denial and account/session revocation with stable error codes;
mobile must not wipe caches on every `403`. A server error can request a wipe when
the client reconnects, but cannot remotely erase an offline device's cache.

### R8–R10 review — useful small changes, modest expected gains

- **R8:** A scoped ETag is reasonable when inexpensive. Authorize before evaluating
  it and keep caching private. Hash the actual response so bud availability is
  represented; do not add inventory-wide version propagation. Mobile can already
  paint a scoped cache and revalidate in the background. ETags reduce unchanged
  bytes, not request count or necessarily catalog computation.
- **R9:** Return the summary if it removes a measured follow-up request. Reuse an
  owner-filtered SQL aggregate rather than the current full-row in-memory count,
  and ensure concurrent mark-read requests cannot move the watermark backwards.
  The summary is an observed snapshot, not a guarantee against later writes.
- **R10:** A documented one-hour freshness window is reasonable for the controlled
  issuer, with one refetch on relevant endpoint/config errors. Confirm the deployed
  discovery response and provider overrides before claiming the new TTL. This
  reduces avoidable discovery fetches; it does not guarantee that every hourly
  refresh avoids one. Keep discovery and signing-key cache policies distinct.

### Recommended sequence and rollout corrections

Start with a small R6 baseline, then R1. R4 is a contained way to remove a new-chat
waterfall. Implement R5's shared serialization with R2's snapshot work, then R3's
list consolidation (move R3 earlier if measurements show list traffic dominates).
R9/R10 can be small independent changes. Scope R7 separately; revisit R8 and durable
R2/R3 synchronization only when measurements justify them.

Backend-first rollout applies to additive contracts. Breaking wire changes require
coordinated web **and** mobile updates and only the overlap a current deployed
client needs. Web's named EventSource listeners ignore unknown R1 event names,
but do not handle them as progress until updated. Mobile behavior is unverified.
Retire the per-bud list feed only after both clients migrate. Keep messages
pagination for older history and state reads for targeted recovery; adopting `open`
does not make those endpoints obsolete.

Implementation handoffs must record the final contracts, affected clients, order,
restarts/migrations and relevant specs/protocol docs. Schema changes need checked-in
migrations; new reads/streams need ownership validation. This review makes no code,
schema or deployment changes and does not approve the original contracts verbatim.

## Original mobile priorities and proposals

| # | Request | Why | Who benefits | Priority |
|---|---|---|---|---|
| R1 | Wake the invocation worker on admission; add run lifecycle events | Every send waits 0–1 s for a poll before any agent work starts | All clients, every send | **High** |
| R2 | One `open` request per thread, with a transcript revision (delta) and a gap-free stream start point | Opening a thread takes ~7 requests today, and separate reads can't be made gap-free | Mobile thread open, reopen and cache | **High** |
| R3 | One user-scoped thread-list feed with row upserts, removals, complete invalidation and resume | N per-bud streams, full-list refetches, stale list fields | Mobile launch and list; web | **High** |
| R4 | Create a thread together with its opening message | Four dependent steps before a new chat can send | New chat | Medium |
| R5 | Structured tool presentation fields; no duplicated tool JSON; bounded results | Larger pages and client-side parsing to classify tool rows | Page size, decode and classification | Medium |
| R6 | `Server-Timing` headers and per-route latency percentiles | No server-side latency numbers exist; can't attribute time | Prioritizing all of the above | Medium |
| R7 | An explicit account disabled/revoked error enforced in the shared viewer path | Needed for safe cache rendering and parallel startup | Security and correctness | Medium |
| R8 | Model catalog version/ETag per scope | Catalog can't be cached with confidence | Launch and new chat | Low |
| R9 | Mark-read returns the updated notification summary | Extra request after every read | Minor | Low |
| R10 | A documented, longer TTL for the OAuth discovery document | Refresh re-fetches discovery | Launch after token expiry | Low |

Suggested order: R6 early (a small change, and it informs everything else), then R1,
R2, R3, R4. R5 and R7–R10 fit wherever they are convenient.

---

## R1 — Wake the invocation worker on admission; add run lifecycle events

### Problem
`POST /api/threads/:id/messages` does durable admission: it saves the message and a
queued invocation, then returns `201 { agent: { started: false, queued: true } }`
(`service/src/routes/threads/messages.ts:233-249`). The run starts only when
`InvocationWorker` picks it up (`service/src/agent/invocation-worker.ts`):

```ts
this.timer = setTimeout(() => {
  if (this.active.size < this.concurrency) {   // concurrency = 4
    const task = this.runOnce() ...             // claims at most ONE invocation
  }
  this.schedule(1000);                          // next tick in 1 s
}, delay);
```

Consequences:
- **Every send waits 0–1 s (≈ 0.5 s on average) before the worker claims it.**
  Preflight, terminal setup and context work follow, and only then the first
  `agent.output_activity`.
- **One claim per tick.** Invocations queued at the same time start about 1 s apart,
  even with free capacity. Examples: several users at once, or a user plus
  automations.
- Every tick runs `recoverExpired` + `expireQueued` + `claim` against the database,
  whether or not there is work.
- Admission doesn't emit a "run started" (or "queued") stream event, so clients can't
  tell "queued" from "stuck". Mobile currently runs a full canonical refresh 2 s after
  a send when no output has appeared, which is common because of the above.

### Proposal
1. **Wake on admission.** After the admission transaction commits:
   - call `invocationWorker.wake()` in the same process;
   - `pg_notify('bud_invocation_admitted', <invocation_id>)` for other gateway
     instances. The service already runs `LISTEN` connections for the thread list and
     browser state, so the pattern exists.
2. **Claim up to capacity on each wake/tick.** Loop `claim` while
   `active.size < concurrency` and a row was claimed.
3. **Keep polling as a safety net only.** Consider backing off to about 5 s idle, since
   wake-ups now carry latency. Keep `recoverExpired`/`expireQueued` on their own slower
   cadence rather than every tick.
4. **Lifecycle events on `agent/stream`, recoverable through `/agent/state`:**

   ```jsonc
   // emitted at admission commit
   { "type": "agent.invocation_queued",  "invocation_id": "...", "turn_id": "...", "input_message_id": "...", "client_id": "..." }
   // emitted when the worker claims it and begins preflight
   { "type": "agent.invocation_started", "invocation_id": "...", "turn_id": "..." }
   // emitted when preflight parks it (e.g. waiting_for_model, bud offline)
   { "type": "agent.invocation_waiting", "invocation_id": "...", "turn_id": "...", "reason": "waiting_for_model" }
   ```

   `/agent/state` should expose the current invocation status, so a reconnecting
   client recovers the same information.

### Requirements
- Wake-ups are hints. Correctness still comes from the database claim (thread-first
  locking is unchanged).
- Events carry only IDs and status. No content.
- Lifecycle events follow the existing ordering and replay rules for `agent/stream`.

### Mobile will
- Render the queued acknowledgement from the send response immediately.
- Treat `invocation_queued/started/waiting` as progress. Replace the 2 s canonical
  refresh with a targeted `/agent/state` read, only on disconnect, resync, or a long
  silence.

### Measure
Admission → claim latency, and admission → first `agent.output_activity`, as p50 and
p95, before and after. Expect about −500 ms p50 and about −1 s p95 on claim, more for
simultaneous admissions.

---

## R2 — One `open` request per thread, with transcript revision and a stream start point

### Problem
Opening a thread on mobile today:

| Request | Purpose |
|---|---|
| `GET /api/threads/:id` | title, bud, model preference |
| `GET /api/threads/:id/messages?limit=100` | transcript |
| `GET /api/threads/:id/agent/state` | run state, pending questions and approvals, stream cursor |
| `GET /api/threads/:id/web-view` | attached web view |
| `GET /api/models?bud_id=…` | model catalog (mobile will cache this; see R8) |
| stream attach: `GET /api/threads/:id` + `…/messages` again | re-read to cover the page→state→stream race |
| browser-state inventory + WebSocket | browser sessions |

That is about 7 requests and 2 connections. Each request repeats auth and ownership
checks on the server and decoding on the device.

Separate reads also **can't be gap-free** (answer to B12):
- The state cursor can be ahead of the page.
- Replay is process-local, limited to 256 entries and 60 s.
- Other-instance or expired cursors trigger `agent.resync_required`.

Mobile is also adding a local transcript cache. Revalidating it currently means
re-downloading the latest 100 messages, because `after` is plain pagination, not a
change feed (B6). There are no tombstones or revision (B7), and existing rows can be
rewritten (continuation writes).

### Proposal
**`GET /api/threads/:id/open?limit=100[&since_revision=R]`**, one authorized response:

```jsonc
{
  "thread": { /* ThreadSummary, incl. title, bud_id, model preference, read state */ },
  "revision": 48213,                       // per-thread transcript revision (see below)
  "transcript": {
    "mode": "full" | "delta",              // "delta" only when since_revision was given and is still servable
    "messages": [ /* canonical rows; in delta mode: rows inserted OR updated after R */ ],
    "removed_message_ids": [ /* delta mode only */ ],
    "turn_timings": { /* as today */ },
    "page": { "before_cursor": "...", "has_more_before": true }   // full mode
  },
  "agent_state": { /* same shape as GET /agent/state */ },
  "web_view": { /* attachment */ } | null,
  "browser": { /* session inventory summary for this thread */ } | null,
  "stream": { "start": "<opaque boundary token>", "valid_until": "2026-…Z" }
}
```

**Transcript revision:**
- A monotonic per-thread counter. It is bumped **in the same transaction** as any
  message insert, update or delete, any visibility change, and any change to thread
  fields shown in the transcript.
- Each row stores the revision at which it last changed. Deletions leave a tombstone
  (message ID + revision), kept for a bounded window.
- `since_revision=R` returns rows changed after R, plus removals.
- If R is older than the tombstone window, or otherwise can't be served, return
  `mode: "full"`.
- This one mechanism also serves R3 (list upserts) and future web caching.

**Stream start point:**
- Capture the live-event boundary **before** the canonical reads.
- Guarantee that events after it are replayable by `GET …/agent/stream?start=<token>`
  until `valid_until`. The validity window must cover a slow cellular client, so at
  least 60 s.
- Overlap between the response and replayed events is allowed; clients upsert by
  `message_id` and reconcile drafts by `client_id`.
- An expired or unknown token returns `agent.resync_required`, as today, and the client
  calls `open` again.
- **Multi-instance:** agent runtime state is process-local today. The backend needs to
  choose between routing `agent/stream` to the owning instance and keeping the boundary
  and replay buffer somewhere shared. Please say which fits.

**Interim option:** if `open` is far off, `ETag`/`If-None-Match` on the existing
messages GET gives a cheap "nothing changed" 304 for cached revisits. Skip it if R2 is
near.

### Requirements
- Thread ownership is authorized once, and attached-site authorization stays explicit.
- Optional parts (`web_view`, `browser`) must not delay the transcript. Returning `null`
  plus a flag to fetch separately is fine if one of them is slow.
- Delta semantics must include rewritten rows (durable continuation) and compaction
  backfills with older timestamps. The revision, not `created_at`, defines "changed".

### Mobile will
- Paint from its local cache instantly, then call `open` once, with `since_revision`
  when it has a cache.
- Attach the stream using `stream.start`.
- Remove the separate metadata, web-view and messages/state fetches and the
  attach-time re-read.

That makes opening a thread 1 request + 1 stream, instead of about 7 requests + 2
connections.

### Measure
Requests per open; bytes per open (cached revisit: delta vs. full); open→interactive
time; resync rate after attach.

---

## R3 — One user-scoped thread-list feed

### Problem
Since mobile PR #48, mobile opens one `GET /api/buds/:bud_id/thread-list/stream` per
bud. From the answers to B1, B2 and B4:
- Frames carry `{}`. Every `ready`/`changed` forces a full `GET /api/threads`, which
  is **unbounded**: every non-deleted owned thread, including archived, with no
  pagination or ETag.
- `ready` doesn't cover changes before subscription, and there's no resume. So
  correctness requires "subscribe, then fetch", repeated after every reconnect.
- Invalidation covers only insert, delete, `last_conversation_at`, title, `bud_id` and
  owner. Preview, count, attention, pin/archive, model preference and read state go
  stale.

### Proposal
**`GET /api/threads?limit=…&cursor=…`** (bounded pagination), returning a
`list_revision` and an `ETag`.

**`GET /api/me/thread-list/stream?since=<list_revision>`**, where the revision comes
from the list GET, so there's no subscription race:

```jsonc
{ "type": "ready",    "list_revision": 9012 }
{ "type": "upsert",   "list_revision": 9013, "thread": { /* full ThreadSummary as in GET /api/threads */ } }
{ "type": "remove",   "list_revision": 9014, "thread_id": "..." }
{ "type": "resync_required" }   // since too old / gap; client refetches the list
{ "type": "heartbeat" }
```

- **Complete invalidation:** any change to any field in the summary emits an `upsert`.
  Deletion, archive (if hidden) and ownership loss emit a `remove`.
- **Server-side coalescing** (e.g. ≤ 1 upsert per thread per 250 ms).
- **Resume** by `since`/`Last-Event-ID` within a retention window, otherwise
  `resync_required`.
- Filter delivery to currently owned buds and threads. Re-check authorization on
  expiry and on inventory changes.

### Mobile will
- Paint the cached list, attach one stream `since` the cached revision (or fetch the
  list, then attach `since` its revision), and patch rows.
- Drop the N per-bud streams and full refetches.

The existing per-bud stream can be removed after the coordinated mobile rollout.

### Measure
List GETs per session; list bytes; stream connections per client; staleness of
preview and attention fields.

---

## R4 — Create a thread together with its opening message

### Problem
New chat on mobile: `POST /api/threads` (returns only `{thread_id}`) → open (R2) →
stream attach → `POST …/messages`. Each step waits on the previous one.

### Proposal
`POST /api/threads` accepts optional
`opening_message: { text, client_id, model?, reasoning_effort? }` and a
`creation_key`, an owner-scoped idempotency key. It returns:

```jsonc
{ "thread": { /* ThreadSummary */ }, "message": { /* canonical */ }, "invocation": { /* as send */ },
  "revision": 1, "stream": { "start": "...", "valid_until": "..." } }
```

### Requirements (from the answer to B14)
- Idempotency covers **creation and admission together**. A retried create with the
  same `creation_key` returns the same thread, message and invocation.
- Authorize the bud and stamp ownership on thread, message and invocation.
- Persist creation and admission atomically, and run the invocation through the worker
  after commit (R1 wake applies).

### Mobile will
Render the new thread from the response and attach the stream directly. One round trip
before streaming.

---

## R5 — Structured tool presentation and compact tool payloads

### Problem (answers to B8 and B9)
- Tool rows store `JSON.stringify(payload)` in `content` **and** spread the same
  payload into `metadata`. Clients download and decode both.
- To detect automation proposals (`ap_…`/`bp_…`), app-permission requests (`dar_…`)
  and browser handoffs, mobile currently re-parses `content` and runs regexes, per row,
  in its hot rendering path.
- Page byte sizes haven't been measured.

### Proposal
1. **A presentation discriminator**, identical on persisted rows, live
   `agent.tool_call`/`agent.tool_result` events, and `/agent/state` recovery:

   ```jsonc
   "presentation": { "kind": "automation_proposal" | "app_permission_request" | "browser_handoff" | "web_retrieval" | "terminal" | "generic",
                     "id": "ap_…" | "dar_…" | "<handoff id>" | null,
                     "status": "pending" | "resolved" | ... }
   ```

   Backfill historical rows at serialization time.
2. **Stop duplicating the payload.** Keep one structured copy.
3. **Optional compact projection** (`?tool_payloads=summary` on messages/`open`): keep
   identity, kind, status, summary, timing and interactive IDs. Bound large results,
   with `result_truncated: true` and an authorized detail endpoint
   (`GET /api/threads/:id/messages/:message_id`).
4. Please sample real tool-heavy pages and report uncompressed vs. transferred bytes, so
   we can size the benefit.

### Mobile will
Classify from `presentation`. Keep today's parsing only as a fallback until the
backfill is confirmed, then delete it. Load full tool details on expand.

---

## R6 — `Server-Timing` and latency percentiles

### Problem
Per the answer to B20, there are no p50/p95 numbers for any mobile-critical route.
Mobile's new signposts can measure connect, first byte and decode, but can't separate
server handler time from network time.

### Proposal
- On REST routes, add
  `Server-Timing: total;dur=12.4, auth;dur=1.1, db;dur=8.7, ser;dur=1.9`, written before
  headers are sent. Expose it to web JS via `Access-Control-Expose-Headers` if needed.
  Contains no identifiers.
- For SSE, measure time-to-headers and time-to-first-event separately.
- A per-route p50/p95 dashboard with sample count, status, and bytes/rows for:
  - `GET /api/threads`
  - messages
  - `agent/state`
  - `open` (R2)
  - `POST /api/threads`
  - `POST …/messages`
  - `GET /api/models`
  - `GET /api/me`
  - admission→claim (R1)

### Mobile will
Log `Server-Timing` next to `URLSessionTaskMetrics` in its perf signposts, and share
captures.

---

## R7 — An explicit account disabled/revoked error

### Problem (answer to B15)
- Chat routes validate the JWT (subject, audience, issuer, scope) without checking a
  live account record.
- There's no shared "account disabled" gate, and refresh-token revocation doesn't
  immediately invalidate an issued access token.
- Mobile is adding an on-device transcript cache and, later, chat startup in parallel
  with `/api/me`. It needs a clear signal for "wipe local data and sign out".

### Proposal
- A stable error, e.g. `403 { "error": "account_disabled" }` or `{ "error": "session_revoked" }`,
  enforced in the **shared viewer resolution path**, so every authenticated route
  returns it, including SSE and WebSocket attaches.
- Document how quickly revocation takes effect for access tokens that are already
  issued (e.g. a short TTL or a revocation list check).

### Mobile will
On this error: stop streams, wipe the owner's local caches, and sign out, regardless of
which request returned it.

---

## R8 — Model catalog version

### Problem (answer to B17)
`GET /api/models` has no version or ETag. The result varies by scope: global config,
plus bud-local models that depend on online status.

### Proposal
An `ETag` on `/api/models`, per request scope. Optionally include
`model_catalog_version` per bud in the buds/inventory response.

### Mobile will
Cache the catalog per environment + owner + bud, paint it immediately, and revalidate
it off the critical path. Send validation stays authoritative on the server.

---

## R9 — Mark-read returns the notification summary

`POST /api/threads/:id/read` should return
`{ ok, updated, last_seen_message_id, summary: { unseen_thread_count, updated_at } }`,
a snapshot taken after the watermark write (answer to B22). Mobile then drops the
follow-up `GET /api/me/notifications/summary`.

---

## R10 — A documented TTL for the OAuth discovery document

Discovery currently sends `max-age=15, stale-if-error=86400`, and its metadata can
change across deploys (answer to B16). For our controlled issuer, a longer documented
TTL (e.g. `max-age=3600`) would let mobile reuse it confidently for hourly refresh.
Mobile will also refetch it once on endpoint or config errors, whatever the TTL.

---

## Cross-repo rollout

These follow AGENTS.md's coordinated-upgrade policy: no long-lived dual APIs.
- **Deployment order:** backend first. Mobile adopts in its next build, and the old
  path is removed after the controlled rollout.
- **Temporary overlap:**
  - R1: none needed. Events are additive, and today's clients ignore unknown event
    types. Please confirm for web.
  - R2 and R3: the old endpoints stay only until the matching mobile build is deployed,
    then the per-bud list stream and redundant open reads can be retired.
  - R5: mobile keeps its parsing fallback for one release, until the backfill is
    verified.
- Each agreed request gets its own handoff doc in `reference/`, with the final
  contract, versions, deployment order, and any mobile rebuild/reinstall notes.

## Mobile-side status

- Mobile-only phases do not depend on these requests.
- Mobile will record per-endpoint client metrics (Phase 0 of `plan/perf/`) and share
  them, to help rank R1–R5.
- The transcript cache ships in v1 form (replace the latest window, purge on
  authenticated 404), with full canonical rows cached under device protections:
  owner- and environment-scoped, `.complete` file protection, excluded from backup,
  wiped on sign-out. No server cacheability marking is requested.

## Related

- `reference/IOS_PERFORMANCE_BACKEND_QUESTIONS.md`: questions and answers.
- `plan/perf/implementation-spec.md`: mobile plan.
- `plan/perf/phase-4-launch-and-chat-flow-network-waterfalls.md`,
  `phase-7-thread-and-list-caching.md`, `phase-8-structural-follow-ups-evidence-gated.md`.
