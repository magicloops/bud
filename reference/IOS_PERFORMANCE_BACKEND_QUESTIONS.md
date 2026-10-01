# iOS Performance Backend Questions

**Status:** Backend review answered; proposed changes need separate handoffs
**Audience:** Backend, web platform, iOS
**Last Updated:** 2026-09-30

## Purpose

The mobile app is working through a performance plan (`plan/perf/`), based on
`review/2026-09-30-mobile-performance-latency-review.md`. Most fixes are mobile-only,
and **nothing in the plan is blocked on these answers**. Several answers would still
let mobile:
- remove round trips;
- stop re-fetching whole lists and pages;
- make the new local thread cache (Phase 7) correct and cheap;
- decide how safely chat can start before `/api/me` returns (Phase 8e).

Please answer inline under each question (**Answer:**). "No / not planned" is a useful
answer. Where a question implies a backend change, tell us whether it's reasonable. We
will open a separate handoff for any change we agree on.

## Backend review scope

Answers were checked against repository source at `9d6b300` on 2026-09-30.
**Current behavior** describes this checkout, not proof of the deployed version.
**Changeable/recommended** means a feasible improvement, not shipped functionality,
an agreed delivery date, or a permanent backend constraint. Authentication,
ownership and data integrity remain requirements for every proposed improvement.

Production latency/payload distributions, iOS request construction, actual HTTP
negotiation and organizational cache policy were not independently measured or
verified. Answers call out those uncertainties. Some specs describe optional/legacy
admission; current startup always selects durable admission, so source takes
precedence for B13.

Suggested first handoffs: B2/B3 for one authorized list feed with complete
invalidations; B11/B12 for thread-open with an explicit history/live boundary;
B13/B14 for canonical create/send acknowledgements and lifecycle events; B8/B9 for
compact structured tool presentation. Cache v2 (B5–B7) needs a revision/change
contract, not only append pagination. B20 measurement can guide ordering.

## Summary

| # | Topic | Priority | Mobile phase it informs |
|---|---|---|---|
| B1 | What triggers thread-list `changed`, and how often | **High** | 4a |
| B2 | Delta payloads, `ready` semantics and resume for the list stream | **High** | 4a |
| B3 | One user-scoped list stream instead of one per bud | Medium | 4a |
| B4 | Thread list conditional GET / `updated_since` / page size | Medium | 4a, 7 |
| B5 | Conditional GET for the messages page | Medium | 7 |
| B6 | `after_cursor` semantics for delta fetches | **High** | 7 (v2) |
| B7 | Deletions, redactions, compaction and on-device caching policy | **High** | 7 |
| B8 | Page payload size and tool payload duplication | Medium | 3, 7 |
| B9 | Structured classification fields for tool messages | Medium | 2, 6 |
| B10 | Timestamp format consistency | Low | 2 |
| B11 | One combined "open thread" response | Medium | 4c |
| B12 | Page + agent-state cursor consistency, so the stream can attach without re-fetching | **High** | 4c |
| B13 | Send acknowledgement and prompt "run started" stream event | **High** | 4c |
| B14 | Create a thread with its opening message in one call | Medium | 4c |
| B15 | Is `/api/me` required before other authenticated calls? | **High** | 8e |
| B16 | Access-token lifetime; caching the OAuth discovery document | Medium | 4b, 8e |
| B17 | Model catalog scope, change frequency and versioning | Medium | 4b, 7 |
| B18 | Aggregated mobile bootstrap endpoint | Low | 4b |
| B19 | HTTP/2 in production and local development | Low | 4a |
| B20 | Server-side latency numbers and `Server-Timing` headers | Medium | 0 |
| B21 | Browser-state WebSocket scope and timeouts | Low | 4d |
| B22 | Return the updated summary from mark-read | Low | 4b |
| B23 | Agent stream heartbeat interval | Low | 2 |

---

## Thread list and list stream

Context: since PR #48, mobile opens one `GET /api/buds/:bud_id/thread-list/stream`
per bud. Every `ready` or `changed` frame makes mobile re-fetch the full thread list
(`GET /api/threads`) and republish it. At launch that means N extra list fetches, and
during a conversation it can mean repeated refetches. Mobile is adding a debounce and
will ignore the initial `ready` regardless of the answers below.

### B1 — What triggers `changed`, and how often?
- Which server events emit `changed`? Examples: thread created or renamed; a new
  message in any thread; agent run start or finish; attention flags; pin or archive.
- While an agent is actively streaming into a thread, how often does that thread's bud
  stream emit `changed`: once per message, per tool call, or per token batch?
- Is `changed` coalesced or throttled server-side?

**Answer:**

**Current behavior (source-confirmed):** Migration 0043 notifies on thread insert/delete, or updates to `last_conversation_at`, `title`, `deleted_at`, `bud_id`, or `created_by_user_id`. User-message inserts and assistant inserts with `metadata.segment_kind = "final"` advance `last_conversation_at` when their timestamp is newer. Title generation can cause another invalidation.

Token batches, ordinary tool results, intermediate assistant text, reasoning, compaction rows, and run start/finish alone do **not** trigger this notification. Updates only to preview/count/activity/attention/pin/archive/model preference, or read watermarks, do not independently notify either. Some summary fields can therefore change without invalidation; this is a current coverage limitation.

No fixed throttle/debounce exists. PostgreSQL can fold identical notifications within a transaction; the route's `dirty` flag combines notifications during an async authorization check. Neither establishes a rate guarantee. Expect conversation-boundary/title changes rather than per-token updates, with no fixed count per turn.

**Changeable:** Broaden invalidation to all relevant summary changes and explicitly coalesce it alongside B2/B3.

Evidence: [migration 0043](../service/drizzle/migrations/0043_tired_mauler.sql), [list stream](../service/src/routes/threads/list-stream.ts), [thread metadata](../service/src/db/thread-metadata.ts).

### B2 — Delta payloads, `ready` semantics, and resume
- Could a `changed` frame carry the affected thread ID(s)? Ideally it would carry the
  updated thread summary (the same shape as a `GET /api/threads` row), so mobile can
  patch one row instead of refetching the list.
- Is `ready` always the first frame, and does it mean "the stream is live; anything
  before this is covered by a fresh list GET"?
- After a reconnect, can changes during the gap be missed? Does the list stream support
  `Last-Event-ID` resume? If not, mobile will treat `ready` after a reconnect as "refetch
  once".

**Answer:**

**Current behavior:** `ready` is the first application frame on a successful attachment, after the authorized subscriber is registered. `ready`, `changed`, and list `heartbeat` carry `{}`. No thread IDs/summaries, event IDs, or `Last-Event-ID` replay are implemented. Changes during disconnection or before subscription can be missed. Loss of the shared database LISTEN connection closes subscriptions.

`ready` means subscribed; it does **not** certify that an earlier/parallel list GET covers preceding changes. Establish the stream, then fetch the list, preserving invalidations during that fetch. Reconnect should similarly cause one fresh read. Ignoring initial `ready` is safe only with an equivalent fresh read after subscription; an earlier launch GET alone leaves a race.

**Changeable:** Thread IDs require enriching database hints but are reasonable. Canonical owner-scoped summary upserts plus removal IDs are better. Define reconnect recovery, revisions/order, deletion, and complete summary invalidation together. These are proposed improvements, not a shipped delta/replay contract.

Evidence: [list stream](../service/src/routes/threads/list-stream.ts), [migration](../service/drizzle/migrations/0043_tired_mauler.sql).

### B3 — One user-scoped stream instead of one per bud?
- Would a single `GET /api/me/thread-list/stream` (all buds the user can see, with a
  `bud_id` on each frame) be feasible?
- It would cut long-lived connections from N to 1.

**Answer:**

**Feasible; not implemented.** One user-scoped stream fits the existing all-owned-Buds list GET. Current per-Bud subscriptions share one database LISTEN connection per gateway but still consume N client connections.

Resolve the authenticated viewer, filter delivery to currently owned Buds/threads, recheck expiry/ownership, and handle Bud inventory changes. Frames can identify `bud_id` and affected threads. Prefer implementing this with B2. No delivery date is committed.

Evidence: [list GET](../service/src/routes/threads/core.ts), [subscriptions](../service/src/routes/threads/list-stream.ts).

### B4 — Thread list: conditional GET, incremental fetch, page size
- Does `GET /api/threads` support `ETag`/`If-None-Match` (a 304 response), or an
  `updated_since` parameter?
- What are the default and maximum page size, and the typical response size for an
  active user?
- Mobile will cache the list on disk (Phase 7) and revalidate at launch.

**Answer:**

**Current behavior:** No endpoint ETag/304, `updated_since`, or pagination. Only optional `bud_id` is recognized; GET returns every nondeleted owned thread, including archived threads. There is no default/maximum page size because the list is unbounded. Unknown query keys are stripped, so sending `limit` currently has no effect. Typical bytes/thread counts were not measured.

**Changeable:** Conditional GET and bounded pagination are reasonable. `updated_since` based only on `last_conversation_at` misses titles, read state, model changes and deletions. True incremental sync needs revisions/removals. A list ETag must include viewer-specific read state and joined terminal/model fields. Authorize even for 304 and prevent shared-owner cache reuse.

Evidence: [core routes](../service/src/routes/threads/core.ts), [schema](../service/src/routes/threads/shared.ts).

## Thread page, caching, and deltas

Context: opening a thread fetches `GET /api/threads/:id/messages?limit=100`, plus
`/agent/state` and `/web-view`. Mobile is adding a local cache so it can show the
last-seen transcript immediately and then revalidate (Phase 7). v1 simply replaces the
cached window with the fresh latest page. v2 would fetch only what changed, which
depends on B5–B7.

### B5 — Conditional GET for the messages page
- Can the messages endpoint return `ETag`/`Last-Modified` and honour
  `If-None-Match`/`If-Modified-Since`, returning 304 when the latest page hasn't changed?

**Answer:**

**Not implemented; reasonable to add.** Messages GET neither emits nor honors these endpoint validators. An ETag must cover the requested window/limit and complete representation, including mutable metadata and `turn_timings`; newest message ID/date alone is insufficient. Last-Modified needs a reliable modification/revision time.

A response hash saves transfer/decoding but can still require backend reads; a maintained revision can save database work too. Choose with measurements. Authorize first, scope validators correctly, and keep private transcripts out of shared caches.

Evidence: [messages GET](../service/src/routes/threads/messages.ts), [serializer](../service/src/routes/threads/shared.ts).

### B6 — `after_cursor` semantics
Mobile already sends `before_cursor`/`after_cursor`/`limit`.
- Does `after_cursor=<cursor of our newest cached message>` return every message after
  it, in order?
- Are cursors stable across deploys and over time (days)? Could a cached cursor become
  invalid, and if so, what error comes back?
- Does an `after_cursor` fetch include **updates to messages at or before the cursor**?
  Examples: a tool result filled in later, a final-answer classification change, a title
  change, a message edited or superseded. Or does it only return new messages?

**Answer:**

**Contract correction:** Requests accept **`before` and `after`**. `before_cursor`/`after_cursor` are response fields. Unknown query keys are stripped: literally sending those names silently fetches the latest page. Verify mobile's URL builder; mobile source was not inspected here.

`after=<page.after_cursor>` returns at most `limit` rows strictly newer by `(created_at,message_id)`, ascending in that order. Default 100, maximum 200. Continue with the returned cursor while `has_more_after` is true; one call does not return every newer message.

Cursors are base64url JSON containing timestamp/UUID, with no TTL, stored cursor record, or signing-key dependency. Normal deploys retaining this format do not expire them. Malformed cursors return `400 {error:"invalid_cursor"}`. A well-formed anchor need not still exist and is not validated as belonging to the thread; the actual query remains owner/thread scoped. Perpetual format compatibility is not promised.

**Not a change feed:** Updates at/before the cursor, deletions, thread titles, and later inserts with older timestamps are excluded. Compaction backfills are a concrete example. Timestamp precision and creation order versus commit order also need validation before promising lossless sync. Use a revision contract for cache v2.

Evidence: [schema/helpers](../service/src/routes/threads/shared.ts), [pagination](../service/src/routes/threads/messages.ts), [compaction timestamps](../service/src/agent/compaction-message.ts).

### B7 — Deletions, redactions, compaction, and caching policy
- How can a client learn that a message it already has was deleted, redacted, or
  hidden by compaction (compaction transcript rows)? Are there tombstones, a
  `removed_ids` list, or a thread-level revision number?
- Is there any product, privacy or retention policy that restricts caching transcripts
  on the device?
  - Mobile plans an owner-scoped cache, file protection `.complete`, excluded from
    backup, wiped on sign-out, bounded to the latest page of about 5 recent threads.
  - Are there data classes that must never be cached, such as terminal output,
    browser screenshots, or personal-data results?

**Answer:**

**Current behavior:** No tombstone feed, `removed_ids`, or transcript revision. Thread deletion is soft deletion: inventory omits it and thread lookups return 404. Compaction changes model context and adds a visible `role:"compaction"` summary; it does **not** remove/hide old transcript rows in messages GET. Existing messages are not universally immutable: durable continuation code updates content/metadata.

Replacing the latest cached window is sensible for v1. Purge a thread on authenticated 404 and reconcile inventory with an authoritative list. Absence from a bounded message page is not proof of deletion of an older row. A 404 does not distinguish deletion from ownership loss. There is no immediate remote-redaction mechanism for an offline copy.

**Policy uncertainty:** No explicit repository policy was found approving/forbidding this device cache or definitively classifying terminal/personal-data results. The proposed protection, backup exclusion, owner scoping, sign-out wipe and bounds are sensible, but are not established privacy approval. Include issuer/environment in cache scope and invalidate on account changes.

**Recommended policy/design:** Keep credentials, grants, scoped cookies and access tokens out of transcript caches. Browser state/frame routes use `no-store`; do not implicitly extend transcript caching to screenshots/media/private browser content. Terminal/personal-data content can already be inside tool messages, so skipping separate endpoints does not solve classification. Agree explicit exclusions or a server cacheability/redaction field. Cache v2 needs revision-based upserts/removals and a full-resync fallback.

Evidence: [deletion](../service/src/routes/threads/core.ts), [compaction](../service/src/agent/compaction-message.ts), [continuation writes](../service/src/agent/invocation-repository.ts), [browser routes](../service/src/browser/routes.ts).

### B8 — Page payload size and tool payload duplication
- What are the typical and p95 sizes of a 100-message page for tool-heavy threads?
- Tool messages appear to carry structured `args`/`result`/`metadata` **and** a
  `raw_content` JSON string. Is the same data duplicated? Mobile decodes both.
- Could pages omit or truncate large tool results (with a detail endpoint, or
  `result_truncated: true`) when requested, e.g. `?tool_payloads=summary`?
- Every byte is decoded before first paint, so payload size drives thread-open time.

**Answer:**

**Measurements unknown:** Typical/p95 bytes were not measured. Sample actual tool-heavy pages and report uncompressed JSON versus transferred bytes and row count separately; 100 rows is not a byte budget.

**Duplication confirmed, naming corrected:** Backend envelopes contain `content` and `metadata`, not `raw_content`. Tool writing stores `JSON.stringify(execution.payload)` in `content` and spreads that payload into `metadata`, adding turn/timing/model/path fields. Much data is duplicated. `raw_content` may be mobile's name for `content`; that mapping is unverified. Tool shapes vary rather than universally containing nested `args`/`result`.

**Changeable:** A summary projection is reasonable: preserve identity, tool/presentation kind, status, summary, timing and interactive request IDs, omit duplicate JSON and bound large results, with explicit truncation/availability and an authorized detail reference. There is no generic message-detail/projection API today. Prefer structured metadata over parsing both copies; improve REST and SSE consistently.

Evidence: [serializer](../service/src/routes/threads/shared.ts), [tool persistence/SSE](../service/src/agent/transcript-writer.ts).

### B9 — Structured classification fields for tool messages
- To classify tool messages, mobile currently parses `raw_content` JSON and runs
  regexes to detect:
  - automation proposals (`proposal_id` matching `ap_…`/`bp_…`);
  - app permission requests (`request_id` matching `dar_…`);
  - browser handoffs (`browser_*` tools).
- Could the backend expose these as explicit structured metadata? For example:
  `metadata.presentation_kind: "automation_proposal" | "app_permission_request" |
  "browser_handoff"` plus the ID field.
- Mobile can then classify without parsing and keep the parser only as a fallback
  during rollout.

**Answer:**

**Reasonable; no uniform `metadata.presentation_kind` today.** Tool metadata already contains structured payload fields, often `tool`, `kind`, `call_id`, `args` and result IDs. Pending calls expose `name` and structured `args`. State has typed pending arrays for data requests, automation proposals, bootstrap proposals and browser waits; handoffs can be recovered as `pending_tool`.

Use those fields wherever possible instead of duplicate JSON parsing or prefix regexes. Add an explicit presentation discriminator and proposal/request/handoff ID consistently to persisted rows, live events and state recovery. Ordinary `browser_*` activity is not automatically a human handoff. Historical rows may need serializer derivation/backfill; a rollout fallback is changeable, not a permanent parser requirement.

Evidence: [writer](../service/src/agent/transcript-writer.ts), [state](../service/src/routes/threads/agent.ts).

### B10 — Timestamp format
- Are all API and stream timestamps ISO 8601 **with** fractional seconds, or is it mixed?
- Mobile currently tries two formats per date. A single guaranteed format lets us use
  one parser.

**Answer:**

**Not universal.** Reviewed canonical message dates, current-user dates and runtime draft/state dates use JavaScript Date/`toISOString()`: UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, with milliseconds. Agent heartbeat `ts` is numeric epoch milliseconds; OAuth `exp` is epoch seconds. Nested tool/provider/wire timestamps do not share a blanket normalization guarantee.

One parser is suitable for the specifically reviewed ISO fields, with separate numeric handling. Keep tolerance elsewhere until audited. Standardizing Bud-owned date strings is reasonable; external contracts/numeric fields should be documented separately.

Evidence: [messages](../service/src/routes/threads/shared.ts), [runtime](../service/src/runtime/agent-runtime-state.ts), [me](../service/src/routes/me.ts), [heartbeat](../service/src/routes/threads/agent.ts).

## Opening a thread, streaming, and sending

### B11 — One combined "open thread" response
- Opening a thread currently needs messages page + agent state + web-view attachment in
  parallel. The model preference comes with the page, and the model catalog is separate.
- Could one request return the page, agent state (including `stream_cursor`), the
  web-view attachment and the model preference? For example:
  `GET /api/threads/:id/open?limit=100`, or `?include=agent_state,web_view` on the
  messages endpoint.

**Answer:**

**Feasible; not implemented.** An authorized `open` response could reuse canonical messages/page/turn timings, agent state, web-view attachment, and stored/effective model preference.

**Shape correction:** Messages GET currently returns `messages`, `turn_timings`, and `page`; it does **not** contain model preference. Preference is on thread/list serialization. Check whether mobile merges these internally.

Aggregation alone does not provide B12's consistency guarantee. State enrichment reconstructs context budget and reads pending requests; measure its cost and avoid making optional attachment/catalog work unnecessarily block transcript paint. Keep thread ownership and attached-site authorization explicit. No daemon/protocol change is intrinsically needed.

Evidence: [messages](../service/src/routes/threads/messages.ts), [thread serialization](../service/src/routes/threads/shared.ts), [state](../service/src/routes/threads/agent.ts), [web view](../service/src/routes/proxied-sites.ts).

### B12 — Page + stream cursor consistency
- Today, when mobile attaches `GET /api/threads/:id/agent/stream`, it **re-fetches the
  messages page** (and sometimes agent state) that it fetched a moment earlier. It does
  this to avoid a gap between history and live events. We want to drop the duplicate.
- If mobile fetches the page and `/agent/state` together, then opens the stream using
  `agent_state.stream_cursor`, is it guaranteed that (page ∪ stream events after
  cursor) is complete, with no gaps? Are duplicates possible and safe to dedupe by
  message or turn ID?
- What happens if a message is persisted between the page read and the agent-state
  read? Is `stream_cursor` always at or before the newest message in the page, or can
  it be ahead?

**Answer:**

**No gap-free guarantee for separate page/state reads.** Example: page finishes; an assistant row is persisted and emitted; state captures a cursor after that event; stream resumes after the cursor. That row is in neither the earlier page nor replay. The cursor can be ahead of the page. Parallel GETs have the same race.

Agent cursors describe process-local events/checkpoints, not a DB message boundary. Replay defaults to **256 entries (including checkpoints) and 60 seconds**; either can evict a cursor. Unknown/expired/restarted/other-instance cursors cause `agent.resync_required` and stream closure. No-cursor attach is live-only. Async durable enrichment after runtime capture also makes the whole state response non-atomic.

Overlap is possible. Upsert canonical rows by `message_id`; reconcile optimistic/draft rows by `client_id`, and transient state by turn/call identity. Turn-only dedupe loses legitimate messages. A canonical completion must replace its existing draft, not be discarded as a duplicate client ID.

**Changeable:** Design B11 with an explicit boundary captured before canonical reads, replay retention across those reads, and defined overlap/concurrent-write/checkpoint/restart/resync semantics. Simply combining existing GETs is insufficient. Stream-first buffering/reconciliation is an interim candidate requiring race tests, not a certified current contract. Keep canonical recovery until that contract is validated.

Evidence: [routes](../service/src/routes/threads/agent.ts), [runtime](../service/src/runtime/agent-runtime-state.ts), [persist then emit](../service/src/agent/transcript-writer.ts).

### B13 — Send acknowledgement and a prompt "run started" event
- Does `POST /api/threads/:id/messages` return the canonical user message and the
  run/turn/invocation ID?
- After a send, does the agent stream promptly emit an event (e.g. `agent.turn_started`
  or output activity) when the run starts? What is the typical delay?
- Mobile currently performs a full canonical refresh (page + agent state + web view +
  list) if no assistant output appears within 2 s of a send. That's common on the first
  message of a new thread. If a prompt stream event is guaranteed, mobile will skip that
  refresh while the stream is healthy.

**Answer:**

**Current normal server path:** Send returns canonical `message`, top-level `message_id`/`client_id`, and `invocation` with `invocation_id`, `turn_id`, `input_message_id` and status. Fresh admission normally returns 201 with `agent:{started:false,queued:true,mode,bud_status}`; idempotent retries recover canonical message/invocation with 200. Client IDs currently must be UUIDs.

Startup now always selects durable mode. Older route/test code can return `agent.started:true`/`stream_cursor`, and some specs describe that older default; it is not standard server startup. The current queued acknowledgement has no stream cursor.

**No prompt-start SLA:** Admission and `runtime.startTurn()` do not emit `agent.turn_started`. Model-call `agent.output_activity` can signal working/text/completion, but follows worker pickup, preflight, terminal initialization and context work. Worker polling is every 1 second, with four concurrent tasks by default; queueing/waits can add much more. These are implementation settings, not measured 1-/2-second guarantees. Typical/p95 start delay is unknown. Heartbeat proves transport liveness, not run progress.

**Changeable:** Explicit admitted/queued and started/status events with invocation/turn identity and durable recovery are reasonable; waking the worker on admission could reduce polling delay. Render the queued acknowledgement immediately. Two seconds without assistant text is not a failed send; if reconciliation is needed, prefer targeted invocation/state reads over page + web view + list. Eliminating all fallback needs an agreed lifecycle/recovery contract.

Evidence: [send](../service/src/routes/threads/messages.ts), [startup](../service/src/invocation-startup.ts), [worker](../service/src/agent/invocation-worker.ts), [runtime](../service/src/runtime/agent-runtime-state.ts), [invocation](../service/src/agent/invocation-view.ts).

### B14 — Create a thread with its opening message
- New chat is currently: `POST /api/threads` → list reload → open (page + state + web
  view) → stream attach → `POST …/messages`.
- Could `POST /api/threads` accept an optional opening message (with `client_id` for
  idempotency) and return the thread summary plus the created message?

**Answer:**

**Reasonable; not implemented.** Create-thread accepts Bud/title/model/reasoning and returns only `{thread_id}`. Optional opening message plus canonical summary/message/invocation would remove this waterfall. A list reload need not precede opening the returned ID.

Idempotency must cover **creation and message admission together**. Message `client_id` deduplication in an existing thread does not prevent a retried create from making another thread. Use an owner-scoped creation key, authorize the Bud, stamp thread/message/invocation ownership, atomically persist creation/admission and execute through the worker after commit. Return queued/started honestly and use B12's attach boundary.

Evidence: [creation](../service/src/routes/threads/core.ts), [schemas](../service/src/routes/threads/shared.ts), [admission](../service/src/routes/threads/messages.ts).

## Launch and auth

### B15 — Is `/api/me` required before other calls?
- Mobile waits for `GET /api/me` before any chat request at launch, even when it
  already has a valid token and a verified owner ID bound in the Keychain.
- We would like to start chat requests (buds, thread list, thread page) in parallel
  with `/api/me` (Phase 8e, deferred and treated carefully).
- Does any server behavior depend on `/api/me` being called first? Examples: lazy user
  provisioning, claim-flow gating, session activation, audit.
- Can a valid access token call the chat endpoints when `/api/me` would return an
  error such as "account disabled" or "claim required"? Do those endpoints enforce the
  same checks?
- Which `/api/me` failure cases must block chat rendering from a local cache? We plan
  to tear down on 401, a different user ID, or account disabled.

**Answer:**

**No server prerequisite to call `/api/me` first.** Chat routes independently resolve cookie/verified bearer identity and ownership. Me additionally loads auth user/profile/provider links and lazily creates a Bud profile; chat ownership does not depend on that profile. There is no claim-required/session-activation gate introduced by me. No claimed Buds can simply mean empty inventory.

**Checks are not identical:** Generic bearer viewer resolution validates token subject/audience/issuer/API scope without querying a live enabled-account record. Me tries the auth user, can fall back to token claims, then performs profile/DB work. No shared account-disabled gate exists in these inspected paths. A valid JWT can authorize chat while me fails on profile/DB work; calling me first does not establish immediate disablement/revocation enforcement. Native browser-state additionally checks live auth-user existence. Refresh-token revocation alone does not immediately invalidate an issued JWT.

**Recommendation:** Parallel startup reads with me are reasonable when token/cache are bound to a verified owner and issuer/environment. Suppress owner cache/rendering on sign-out, owner mismatch or terminal auth failure; a 401 may first take the normal refresh/retry path. Purge inaccessible resources on authenticated 404. Offline/timeout/5xx alone is not proof of invalid ownership; stale offline rendering is a product decision. Any future explicit disabled/revoked-account error should block rendering and be enforced by the shared server viewer path. No current disabled-account error contract is promised.

Evidence: [viewer/profile](../service/src/auth/session.ts), [verification](../service/src/auth/auth.ts), [me](../service/src/routes/me.ts), [browser-state](../service/src/browser/routes.ts).

### B16 — Access-token lifetime and discovery document caching
- What is the access-token TTL? Mobile refreshes when within 60 s of expiry.
- Is `<issuer>/.well-known/openid-configuration` (e.g. `https://app.bud.dev/api/auth/.well-known/openid-configuration`) safe to cache for
  the app process lifetime? Does it send `Cache-Control`? Does it change across deploys?
- Mobile fetches it on every token refresh today, which adds a round trip.

**Answer:**

**Source default, not a live token measurement:** Bud does not override OAuth access-token expiry; the installed plugin defaults to **3600 seconds (1 hour)**. Use actual `expires_in`/`exp` instead of hardcoding that dependency/configuration default. Sixty seconds of refresh headroom is compatible.

Installed discovery handlers send `Cache-Control: public, max-age=15, stale-while-revalidate=15, stale-if-error=86400`, which Bud forwards. This is source evidence, not a production-header probe. Metadata derives from issuer/auth/plugin configuration and can change across deploys; process-lifetime freshness is not promised.

**Changeable:** Reuse issuer-scoped discovery with freshness/revalidation rather than fetching on every refresh. A longer documented TTL is reasonable for our controlled issuer. Process-lifetime stale reuse needs an explicit fallback on endpoint/configuration errors, rather than claiming today's header permits indefinite freshness. Keep local/staging/production separate. JWKS rotation/cache is a separate concern.

Evidence: [OAuth options/forwarding](../service/src/auth/auth.ts); installed `@better-auth/oauth-provider/dist/index.mjs` expiry/discovery implementation.

### B17 — Model catalog
- Is `GET /api/models` per bud, or per user? How often does it change?
- Could it carry an `ETag` or a `catalog_version`, or could the version be included in
  the buds response, so mobile can cache the catalog and skip it at launch?

**Answer:**

**Scope:** Authenticated GET without `bud_id` returns the configured service/provider catalog and defaults, not user preferences. With `bud_id`, it authorizes that Bud and adds currently available local models from online status/capabilities. Service configuration/code/context policy and Bud status/reconnect/capabilities can change results. No fixed update frequency, ETag or version exists today.

**Changeable:** Content ETag/version is reasonable. Cache by environment/request scope, and owner for Bud-local data. Include defaults, context policy and local availability in versioning; one static global version does not describe all Buds. Inventory version hints are possible with a shared calculation. Cached models can paint immediately, but send validation remains authoritative and may reject a now-unavailable local model.

Evidence: [models](../service/src/routes/models.ts), [send preflight](../service/src/routes/threads/messages.ts).

### B18 — Aggregated bootstrap (low priority)
- Would a single mobile bootstrap response be acceptable, containing user, buds,
  capabilities, the first page of threads, and the model-catalog version?
- Mobile's first step is to parallelize the existing calls, so this is only worth doing
  if it's cheap.

**Answer:**

**Acceptable in principle; not implemented; cost unmeasured.** Parallel existing calls first. A bootstrap response could share viewer resolution and return user, owned Bud inventory/capabilities, bounded threads and catalog version(s).

Reuse owner-filtered SQL/serializers, define partial failures/freshness and global versus Bud-local versions. Profile enrichment should not accidentally make a recoverable me/profile failure fail all chat bootstrap. Prioritize B3/B11 and measured savings before another aggregate endpoint; low priority is reasonable.

Evidence: [me](../service/src/routes/me.ts), [list](../service/src/routes/threads/core.ts), [models](../service/src/routes/models.ts).

## Infrastructure and observability

### B19 — HTTP/2 in production and local development
- Please confirm `app.bud.dev` serves HTTP/2 (or HTTP/3) to iOS clients.
- What protocol do the local dev servers serve (`http://localhost:5173`,
  `https://localhost:3443`)? We believe it is HTTP/1.1.
- With HTTP/1.1, iOS allows only a few connections per host. Mobile holds N list
  streams + the agent stream + the browser WebSocket open, which could queue ordinary
  requests behind them when running against a local backend.
- This is a minor, local-only concern. Development builds are also slow against the
  production backend, so we attribute the Debug-vs-Release gap to the client, not to
  the protocol. Mobile will move long-lived streams to a separate `URLSession` either
  way. Can local HTTPS dev support HTTP/2?

**Answer:**

**Production negotiation unverified.** Routing/Cloudflare Worker source does not prove what iOS negotiates with `app.bud.dev`. Record `URLSessionTaskMetrics.networkProtocolName` for actual API/SSE calls, or use an ALPN-capable live probe. Neither an HTTP/1.1 origin nor separate daemon gRPC proves client protocol.

Fastify has no HTTP/2/TLS options, and plain Vite at `http://localhost:5173` has no HTTP/2 configuration; these direct dev paths use HTTP/1.1. **3443 is Caddy**, with TLS reverse proxy config and no HTTP/1-only restriction. Local HTTPS can support HTTP/2 at that edge already; verify Caddy configuration/version and negotiated ALPN instead of assuming 3443 is HTTP/1.1. HTTPS alone is not proof of HTTP/2; HTTP/3 availability is not established.

Connection queueing on HTTP/1.1 is plausible, but exact iOS socket limits/pool sharing are client-dependent. Separate URLSessions are worth testing, not proof of eliminating contention. Measure negotiation/queue time before assigning latency to protocol or Debug/Release behavior.

Evidence: [server](../service/src/server.ts), [Vite](../web/vite.config.ts), [Caddy](../dev/caddy/Caddyfile.https-local).

### B20 — Server-side latency and `Server-Timing`
- What are current p50/p95 server times for:
  - `GET /api/threads`
  - `GET /api/threads/:id/messages?limit=100`
  - `GET /api/threads/:id/agent/state`
  - `POST /api/threads`
  - `POST /api/threads/:id/messages`
  - `GET /api/models`
  - `GET /api/me`
- Could responses include a `Server-Timing` header? Mobile's new signposts would then
  separate server time from network and client time.

**Answer:**

**All seven requested p50/p95 values are unknown.** No production aggregation/representative benchmark was performed. Completion logs record route template, status and rounded `duration_ms`; some frequent successful GETs, including fast agent-state reads, are debug-only and may be absent from production logs. SSE completion duration is connection lifetime, not handler latency.

**Reasonable:** Add monotonic total-handler `Server-Timing` on REST, optionally auth/DB/serialization spans, before response headers are sent. `onResponse` logging is too late to add a header. Avoid sensitive identifiers, expose the header through CORS for web JS if needed, and measure SSE headers/first event separately.

Collect per-route p50/p95 with sample count, environment/build, warm/cold distinction, status, bytes/rows. State can reconstruct context budget/pending requests; it is not necessarily a cheap memory lookup. Handler timing excludes edge/network/client work; correlate with mobile metrics.

Evidence: [logs](../service/src/access-log.ts), [state enrichment](../service/src/routes/threads/agent.ts), [hooks](../service/src/server.ts).

### B21 — Browser-state WebSocket
- Mobile opens `/api/threads/:id/browser-state` per open thread. What are the expected
  heartbeat interval and idle timeout?
- Would a user-scoped browser-state socket make sense, or is per-thread intended?

**Answer:**

**Current contract:** WebSocket ping and application `{type:"heartbeat",revision}` every **15 seconds**. Terminate when last pong is **more than 45 seconds** old, checked on heartbeat ticks (actual closure can be later). Authorization is rechecked on changes and every **30 seconds** while idle; failure closes 4404. Database-feed loss/errors can terminate; output buffering above 4096 bytes terminates. No fixed maximum idle lifetime while healthy; edge/proxy timeouts are unverified.

Per-thread is intentional for the open thread. Bud/session state scopes also exist, but **only thread state currently accepts native bearer discovery**; Bud scope is not a drop-in native consolidation endpoint. Revision is connection-local invalidation, not durable replay.

**Changeable:** A user discovery feed can make sense for multiple concurrent thread subscriptions, with explicit scope IDs and auth/ownership rechecks. Keep media/control separate. Measure whether one open-thread socket is a bottleneck. No user feed exists today.

Evidence: [transport](../service/src/browser/state-stream.ts), [scopes/auth](../service/src/browser/routes.ts).

### B22 — Notification summary after mark-read
- Mobile calls `GET /api/me/notifications/summary` after each `POST /api/threads/:id/read`.
- Could the mark-read response include the updated summary?

**Answer:**

**Yes, reasonable; not implemented.** Mark-read returns `{ok,updated,last_seen_message_id}`; summary separately returns owner-filtered `{unseen_thread_count,updated_at}`.

Reuse a shared owner-scoped summary helper after writing the watermark, returning it on changed and no-op acknowledgements. Define it as a snapshot at calculation time: concurrent assistant output can immediately alter the count. Do not blindly decrement a cached badge. Check watermark concurrency in the implementation handoff.

Evidence: [mark-read](../service/src/routes/threads/messages.ts), [summary](../service/src/routes/me.ts).

### B23 — Agent stream heartbeat interval
- What is the heartbeat interval on `agent/stream`? Mobile currently decodes heartbeat
  payloads, and is changing that regardless.
- Knowing the interval helps us tune reconnect watchdogs.

**Answer:**

**Source-confirmed:** **5 seconds for `NODE_ENV=production`; 1 second otherwise.** Attach emits an immediate heartbeat when no events are replayed. Payload `ts` is numeric Unix epoch milliseconds, sometimes with `initial:true`; heartbeats carry no resumable event ID.

Use for transport liveness, not agent progress or guaranteed arrival timing; event-loop/proxy delay and mobile suspension affect delivery. Allow multiple missed intervals. Timing is changeable; document/negotiate it if mobile needs a durable contract. List-stream heartbeat is separately 15 seconds.

Evidence: [route](../service/src/routes/threads/agent.ts), [attach](../service/src/runtime/agent-runtime-state.ts).

## Related

- `review/2026-09-30-mobile-performance-latency-review.md`
- `plan/perf/implementation-spec.md`
- `plan/perf/phase-4-launch-and-chat-flow-network-waterfalls.md`
- `plan/perf/phase-7-thread-and-list-caching.md`
- `plan/perf/phase-8-structural-follow-ups-evidence-gated.md` (8e)
