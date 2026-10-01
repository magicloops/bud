# Phase 3: Compact Transcript and Safe Thread Open

**Status:** Service/web implemented and locally tested; native adoption and deployed measurements pending.
**Dependency:** Phase 1 publication foundation; independent of Phase 2 admission.
**Parent:** [Implementation spec](implementation-spec.md).

## Outcome

Clients load a bounded transcript and the state needed to attach its stream through
one authorized `open` request. Tool classification and decoding use a shared wire
shape. Explicit recovery covers missing replay and durable mutations.

## Step A: Shared serializers

Extract shared thread-summary and message serializers used by list/open/messages,
canonical live messages and recovery state. A thread summary includes the same
read/attention, model preference and terminal fields as the canonical list query.
Avoid a second narrower summary type for `open`.

For tool rows, introduce a structured `tool_payload` and a `presentation` object
with `kind`, nullable interactive `id`, and applicable `status`. Retain message
identity, role, timestamps, timing/path/model metadata and human-readable content.
Remove payload duplication from content/metadata on the new wire shape. Preserve
the existing content semantics of non-tool roles. Freeze exact examples for each
tool family before changing client parsers; presentation enums must cover existing
questions, approvals, bootstrap proposals, browser handoffs, terminal and generic
results rather than only the examples in the mobile request.

Normalize historical rows from their actual storage shape. Ordinary tool rows have
duplicated payload metadata; continuation rows may have JSON only in `content`.
Malformed historical payloads use a safe generic representation with original
display content retained. Do not erase evidence or mislabel an unresolved action.
Batch any required durable action-state lookup; no query per transcript row.

Use the same presentation vocabulary on pending/live calls and results, while
keeping their distinct call/result semantics. Do not force a pending call to look
like a persisted result. Keep persisted model inputs and provider-ledger replay
unchanged. A storage cleanup is outside this phase.

Measure encoded and transferred bytes plus decode/classification cost after
deduplication. Summary projection, result truncation and a details endpoint remain
deferred unless that evidence justifies a separately specified addition.

## Step B: Open response

Add `GET /api/threads/:thread_id/open?limit=100` with the existing messages page cap
of 200. Reject invalid limits consistently with message history. Initial contract:

```jsonc
{
  "thread": { /* canonical ThreadSummary */ },
  "transcript": {
    "messages": [ /* shared canonical wire rows */ ],
    "turn_timings": [ /* existing settled timing entries */ ],
    "page": { /* existing messages pagination metadata */ }
  },
  "agent_state": { /* shared authorized state projection */ },
  "stream_cursor": "<boundary captured before canonical reads>",
  "included": { "web_view": false, "browser": false }
}
```

Default v1 omits browser inventory and web-view attachment data. Load them separately
when their UI is used; they cannot delay the initial JSON response. Do not include
model catalogs or initiate daemon calls. Reuse state loaders, but move expensive
optional reconstruction such as idle context-budget computation off the critical
path with an explicit inclusion indicator; preserve the standalone state contract
unless a coordinated change is documented. Missing is distinct from authoritative
null. Final fixtures must enumerate these inclusion semantics.

Authorize the thread once at the route boundary and pass the resolved owner/thread
to shared loaders that retain SQL scoping. Keep any attachment-specific permissions
if optional inclusion is added. A failed required transcript/state load is an error,
not an empty successful snapshot. Capture the top-level cursor before reads and
attach using existing `agent/stream?after=…`; do not add `start` or `valid_until`.

## Step C: Prove snapshot/replay continuity

Inventory every visible writer before removing redundant client reads: ordinary
admission; assistant/tool/reasoning writes; `prepareQuestionContinuation`; input
rewrites in preflight; compaction/backfills; title and timing updates; deletions or
visibility changes; durable pending requests and invocation transitions. For each,
record transaction owner, post-commit event/invalidation, and canonical recovery.

Add canonical insert events where absent. Use an explicit transcript invalidation
for mutable-row updates/deletion/backfills that cannot be safely applied by the
existing reducer; it causes a coalesced bounded canonical refresh. This is an
acceptable exceptional read. Do not add a generic durable changes table.

Required reconciliation rules:

- The top-level `stream_cursor` covers transcript changes starting before the page
  read. A later `agent_state.stream_cursor` must not replace it for attachment.
- Runtime overlays use the state snapshot's cursor boundary so replayed draft/tool
  effects already incorporated in that snapshot are not applied twice. Cursors stay
  opaque to clients; specify an explicit replay/snapshot boundary marker if needed
  rather than making clients parse or lexicographically compare opaque tokens.
- Canonical insert replay deduplicates by message identity; it cannot overwrite a
  newer canonical row from the snapshot. Mutations use invalidation/reload until a
  tested versioned update contract exists. Reconcile optimistic rows by `client_id`.
- Older lifecycle/pending-state events cannot regress a newer state read. Extend
  Phase 1's ordered publication/recovery rules to all durable state projections.
- Publication failure while a process remains alive must invalidate affected replay
  continuity or trigger resync. Logging and silently continuing is insufficient.
  Process restart naturally invalidates the old cursor epoch.
- Buffer eviction, unknown cursor, process mismatch and replay overflow produce
  explicit `agent.resync_required`. Recovery starts a fresh open/attach generation
  and cancels the obsolete one; late responses cannot replace the new state.

The exact snapshot boundary mechanism is an implementation gate: record it with
fixtures here before client cutover. Prefer a narrow per-thread publication/read
coordination primitive and explicit invalidation over a new synchronization system.

Current implementation chooses the simpler common boundary: create a fresh runtime checkpoint and capture its
snapshot synchronously before any canonical query and use that exact cursor for
both runtime overlays and top-level attachment. There is no later overlay boundary
or need for clients to compare opaque cursors. Canonical rows read afterward must
win over older replayed draft/call effects. Runtime and reducer regression tests cover old invalidations, during-read changes
and canonical-over-draft precedence. Database triggers cover committed message
inserts, updates and deletes. The reference web now adopts this boundary.
Do not hold database write locks or pause agent execution across client network I/O.
A compound response alone does not establish consistency.

## Validation, adoption and rollout

Test each writer before/during/after the page and state reads; delayed post-commit
publication; update after insert but before replay; active-to-final transitions;
old-timestamp backfills; replay eviction and restart; failed required loads;
foreign resources; and concurrent navigation/resync. Verify draft text is neither
duplicated nor rolled backwards. Preserve scroll position when recovering while
reading older history, and retain the existing older-history endpoint.

Update service messages/agent/core/shared routes, transcript writer, continuation
and compaction writers, runtime snapshot/buffer, web API types, bootstrap and
message reducers/renderers. Read/update their agent/runtime/routes/web specs and
`docs/proto.md`. Add the relevant ownership tests to the auth checklist.

Ship additive loaders/open before adoption if useful. Compact tool wire changes
require coordinated web/mobile parsing. Name the actual deployed consumer requiring
any temporary bridge and its removal condition. Do not make two serializers a
permanent API choice. After the race suite passes, adopt open in web/mobile and
remove redundant happy-path metadata/messages/state fetches. Keep targeted recovery.

Acceptance: one core open request plus agent stream on the normal path, fewer tool
bytes/decodes, no silent transcript/state gaps, and measured resync/latency results.
No claim is made that browser-state/media connections disappear.


Implemented mutation recovery uses read-only POST `/messages/reconcile`, up to
200 requested UUIDs per batch; missing requested IDs remove loaded rows. Open
creates a fresh checkpoint to cover repaired invalidations. Loaded older history
is reconciled as well as the latest page. Non-message pending inventories retain
the existing durable-state fallback rather than claiming complete event coverage.
See the handoff for the final contract and ownership boundaries.
