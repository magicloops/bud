# Review: iOS performance backend follow-ups

Date: 2026-10-04. Status: recommendations, not an implementation contract.

Source: [mobile requests](../reference/IOS_PERFORMANCE_BACKEND_FOLLOW_UPS.md).
Related: [original implementation](../plan/backend-mobile-performance/implementation-spec.md),
[API handoff](../plan/backend-mobile-performance/mobile-api-handoff.md),
[missing-final investigation](../debug/ios-agent-work-missing-final-answer.md).

## Recommendation

Fix cursor correctness first, then complete event-driven thread state for both
clients. Separate cheap state reads from context reconstruction. Treat account
disablement/revocation as its own auth change, with explicit offline-cache policy.
Add lightweight latency distributions; worker wake-up needs confirmation, not
another implementation.

| Request | Decision | Implementation size | Benefit beyond mobile |
|---|---|---|---|
| F1: pending-request events | Do, together with cheap state refresh and web adoption | Medium: mutation coverage and recovery tests dominate | Removes visible-thread polling and stale cross-device cards |
| F2: budget in open | Do conditionally: cheap known snapshot; defer cold reconstruction | Small for separation, medium for a correctly invalidated cache | Faster web opening and fewer repeated context rebuilds |
| F3: exact cursors | Do first; correctness priority | Small, with real PostgreSQL tests | Reliable web history and reconnect catch-up |
| F4: disabled/revoked auth | Do as a separate security contract | Medium–large; depends on revocation scope | Consistent cookie/bearer enforcement and stream shutdown |
| F5: route percentiles | Do minimally, alongside the performance work | Small if using existing log analysis; medium if adding metric export | Shared evidence for choosing subsequent work |
| F6: worker wake | Already implemented; close with evidence | Documentation/validation only | Existing improvement benefits every admission source |

Sizes are relative engineering scope, not delivery estimates. No production
latencies or current mobile traces were measured for this review. The mobile
repository and its referenced `plan/perf/*` files are not present here.

## F1: make pending state converge without routine polling

### Current evidence

- [state-loader.ts](../service/src/routes/threads/state-loader.ts) reconstructs
  questions, app-data requests, activation proposals, bootstrap proposals and
  browser waits from durable state. An invocation lifecycle event is not itself
  the complete pending-request inventory.
- [invocation-timing.ts](../service/src/agent/invocation-timing.ts) already has
  post-commit hooks. [invocation-events.ts](../service/src/agent/invocation-events.ts)
  reloads committed invocation rows, publishes through the existing thread
  runtime, and invalidates replay on publication failure.
- [user-question-repository.ts](../service/src/agent/user-question-repository.ts)
  records an ID-less wake on answers/skips. This wakes execution but supplies no
  invocation ID to the client-event publisher. Question creation/cancellation
  also needs auditing at its enclosing lifecycle boundary.
- [app-keys.ts](../service/src/personal-data/app-keys.ts) records invocation IDs
  on decisions, but expiry can issue only an ID-less wake. Activation proposals
  already record invocation IDs on decisions and reconciliation. This is partial
  coverage, not a reason to assume every pending inventory change is signaled.
- [web's thread route](../web/src/routes/$budId/$threadId.tsx) polls every visible
  durable thread every five seconds, even with no pending card. A change to
  [invocationRevision](../web/src/features/threads/invocation-state.ts) triggers
  `/open`, loaded-message reconciliation, and a separate budget refresh. Thus
  the fallback also repairs invocation/transcript state; removing it requires
  validating those recovery paths, not just adding one listener.

### Recommended implementation

Add one explicit pending-inventory invalidation event, provisionally
`agent.pending_requests_changed`, to the existing authorized thread stream.
Prefer a coalesced hint containing affected kinds and optional request IDs over
another authoritative copy of all cards. Final naming/shape belongs in the spec.

Register changes inside the owning transaction and publish only after commit.
Cover creation/park, answers, approvals/declines, cancellation, follow-up
supersession, expiry, invalidation by changed grants/drafts, and restart cleanup.
Visibility also depends on invocation/action state, so publish when those joins
change even if the request row itself does not. Include browser waits in the
coverage matrix, or explicitly retain their existing convergence mechanism.
No event should carry credentials, encrypted envelopes or private answers.

Reuse the current replay buffer and stale-cursor resync mechanism. Post-commit
publication failure must force canonical recovery. Replay remains bounded and
process-local: this is not durable delivery or a multi-instance solution.
Direct database maintenance outside instrumented writers must invalidate replay
or require client rebootstrap; it cannot silently inherit an event guarantee.

Both clients should coalesce hints into one in-flight cheap state read, mark a
second read needed if another hint arrives during it, and discard obsolete
responses after owner/thread changes. Apply the pending inventory without
reloading history or replacing the stream cursor with a later snapshot cursor.
Preserve newer live drafts/activity. `/open` plus its pre-read cursor remains the
full recovery boundary after reconnect/resync.

Make ordinary `/agent/state` cheap and move explicit context reconstruction to a
budget-only endpoint (F2). This avoids replacing a five-second expensive poll
with bursts of expensive event-triggered reads. Share the existing inventory
loader; do not create mobile-specific state or a separate request ledger.

Remove web's fallback only after two-client tests cover every inventory kind,
mutation during open/attach, duplicate replay, rollback, publication failure,
restart, and an event arriving during a refresh. Keep foreground/reconnect
recovery and retries for a failed refresh. Mobile's temporary “poll only with a
pending card” reduces traffic but cannot discover an unseen card by itself;
it still relies on stream events or bootstrap.

Standalone web permission/review/automation screens also poll their own APIs.
A thread event does not automatically replace those owner-level feeds. Leave
their bounded, view-local refresh behavior for now; reuse the mutation
notifications if an owner-level feed later becomes justified. Do not pretend
F1 removes all polling in the product.

## F2: preserve fast opening; make budget state inexpensive to consume

[open.ts](../service/src/routes/threads/open.ts) deliberately calls the shared
state loader with `includeContextBudget=false` and reports the omission. Ordinary
`/agent/state` prefers the active runtime budget, but otherwise
[context-budget-snapshot.ts](../service/src/agent/context-budget-snapshot.ts)
loads a checkpoint, optionally counts checkpoints, reconstructs model-visible
conversation, loads a usage anchor, applies environment instructions and
estimates tokens/tool schemas. Cost depends on history/provider state; no new
latency figure is established here. Parallelizing that calculation inside
`/open` still makes opening wait for it.

Do not simply flip the flag to true. Recommended path:

1. Separate runtime/pending state from explicit budget reconstruction. Introduce
   an authorized budget-only read for a cold meter or explicit refresh, using
   the existing accounting implementation. Keep expensive model-context detail
   on its existing explicit surface.
2. Include an already-known budget in `/open` when it is cheap and applicable.
   Preserve `source`, `checked_at`, `stale`, model and turn identity. Report
   `included.context_budget` accurately; do not mark omission as a current zero
   or pretend a missing snapshot is a measured budget.
3. Let both clients skip their initial budget read when the supplied value is
   usable. Otherwise paint chat first and fetch the meter independently. Web's
   [use-context-budget.ts](../web/src/features/threads/use-context-budget.ts)
   currently reads full state unconditionally on mount, so backend changes
   alone will not eliminate that request.
4. If eliminating nearly all reopen reads is worthwhile, retain a bounded
   latest-budget cache keyed by owner/thread and accounting inputs. Invalidate
   or mark stale on message/context changes, compaction, model/reasoning changes,
   and environment/tool-catalog changes. Coalesce reconstruction and prevent a
   calculation started against old inputs from overwriting newer state. A cold
   process may return unknown and reconstruct asynchronously on demand.

An active runtime snapshot alone will not fix idle reopens: current runtime
budgets are cleared through lifecycle transitions. Persisting a validated
latest snapshot could remove cold-restart misses, but adds schema, invalidation
and write-path work. Defer that until measurements justify it. A cached estimate
is display state, never authority for model admission or compaction decisions.

The achievable first step is fewer and cheaper reads without slowing chat;
“fresh budget on every open with no additional work” is not currently available.
Coordinate the changed `/agent/state` semantics with web and mobile rather than
maintaining two permanent expensive/cheap execution modes.

## F3: fix the opaque cursor, not the comparison operator

[shared.ts](../service/src/routes/threads/shared.ts) converts timestamps to JS
`Date` in both encoding and decoding. Merely changing serialization will not
preserve precision if decoding still truncates it. The earlier debug note
reproduced skipped microsecond rows; that bug did not explain the supplied
missing-final local thread.

Prefer retaining `(created_at, message_id)` keyset pagination with an exact
PostgreSQL timestamp string in the opaque cursor. Select a normalized UTC
microsecond representation separately from the public display timestamp; carry
it as a string through validation and parameterized `timestamptz` comparison.
Preserve strict `<`/`>` and the ID tie-breaker in both directions. No timestamp
rewrite, schema migration, or change to UI display dates is required.

Resolving the anchor row by ID is a valid alternative and can recover old
millisecond cursors while the row exists, but adds a lookup and a missing/deleted
anchor policy. A self-contained exact tuple is simpler for future cursors and
continues working after anchor deletion. For this controlled release, reject
old imprecise cursor versions explicitly and have clients reload the window;
do not silently keep the old precision bug. Confirm that web/mobile perform that
recovery before cutover.

Test with actual PostgreSQL timestamps: several rows in one millisecond, equal
timestamps/different IDs, page sizes one and larger, before and after traversal,
anchor deletion, invalid cursors, and another owner's/thread's data. Verify
`/open` produces the same exact cursors as `/messages`. Owner/thread SQL filters
remain mandatory; a cursor is a boundary, not access authority. Audit other
timestamp-keyed pagination separately for the same Date conversion pattern.

## F4: explicit auth policy, not just a new error string

[session.ts](../service/src/auth/session.ts) resolves cookie or bearer identity;
`requireViewer` currently emits generic `401 unauthorized` when no viewer exists.
Bearer viewers use verified claims without a shared live account-status gate.
`getNormalizedCurrentUser` has a separate cookie/bearer path and can fall back to
token claims if the user lookup misses. Adding a check only to `/api/me` therefore
would not enforce a consistent resource-access policy.

Implement account disablement first as shared live account eligibility for both
cookie and bearer access, including current-user normalization and specialized
browser/scoped-visit entry points. Add durable policy state and an explicit,
audited way to disable/re-enable an account. Proposed response:
`403 {"error":"account_disabled"}` only after verified identity establishes
that condition. Keep expired/invalid credentials distinct and resource ownership
failures at `404`.

Choose revocation scope before promising `session_revoked`: one native grant,
one web session, or every session for the account. For all-session invalidation,
an account credential epoch/valid-after policy is a plausible small design, but
issuance and refresh must honor it as well as resource verification. For one
device/grant, the bearer verifier needs a stable grant/session association and
live revocation state. Verify the installed provider's claims and refresh
behavior before selecting that implementation. Refresh-token revocation alone
must not be advertised as revoking an already-issued access token immediately.

Existing SSE/WebSocket sessions and scoped viewer credentials need an explicit
revocation delivery/enforcement bound. Checking only at attach leaves already
open connections authorized indefinitely. Audit both attachment and continuing
delivery/control; do not assume a shared REST helper covers every auth surface.
Decide separately whether disablement stops daemon/automation execution; the
mobile cache request alone does not settle that product policy.

For both clients, centralize terminal-auth handling: cancel requests/streams,
clear owner state and cached data, and prevent late responses from restoring it.
Transient network failures and ordinary refreshable expiry must not trigger an
irreversible cache wipe by accident.

**Offline limitation:** no server response can remotely erase an offline cache
or guarantee that a disabled account never sees data painted before validation.
Owner/issuer-scoped storage and logout/account-switch clearing are required
regardless of F4. Choose either cached display while revalidating (accepting a
revocation window), or validation before sensitive display. Disk caching and
parallel startup are not inherently blocked by absence of a special error;
they are blocked if the desired product policy requires immediate revocation.

This work needs cookie/bearer parity tests, account disable/re-enable tests,
refresh/revocation tests, open-stream tests and stale-client-response tests, plus
checked-in migrations if new policy state is introduced. The precise provider
integration and acceptable offline/stream revocation windows remain decisions.

## F5: measure distributions without rebuilding observability

[access-log.ts](../service/src/access-log.ts) already records route templates,
method, status, duration, response bytes and separate SSE timing. However,
successful fast `/agent/state` requests log at debug: an info-only log sample is
biased toward slow/errors and cannot yield honest percentiles for that route.

First establish whether the existing log destination can aggregate complete
measurements. If it can, add a complete low-volume timing signal and queries for
count, error rate, p50/p95 and bytes by method/route over a defined window. If
not, use bounded histograms independent of request log level and export them to
the chosen collector (periodic structured bucket counts are a modest starting
point). Do not store every request or build a custom metrics dashboard/database.

Use low-cardinality labels: route template, method, status class; no user/thread
IDs or URLs. Aggregate buckets across instances before estimating percentiles;
never average per-process p95s. Show sample counts and label histogram quantiles
as approximate. Measure SSE headers/first frame separately from connection
lifetime; the existing first-frame signal can be a heartbeat, not first useful
agent content. Add admission-to-start measurement for the worker separately.

Backend duration does not measure mobile network/decoding/render time. Compare
both, and use the before/after request counts as an acceptance measure for F1/F2.
Collector availability and production distributions remain unverified.

## F6: wake-on-admission shipped

[server.ts](../service/src/server.ts) subscribes to committed invocation changes
and calls `invocationWorker.wake()` before queuing lifecycle publication, for
both Drizzle and raw-pg browser transaction owners.
[InvocationWorker](../service/src/agent/invocation-worker.ts) drains immediately,
coalesces wakes, fills four slots by default, and refills on completion. Its
one-second timer remains for maintenance/recovery and missed wake hints; ordinary
admission does not intentionally wait for that timer.

This is process-local. A separate worker or multiple service instances requires
a cross-process notification mechanism before claiming the same latency behavior;
database claims remain execution authority. Busy slots, per-thread serialization,
DB contention, preflight and dependency waits still contribute latency. This is
not a promise that every send saves exactly one second.

Validation run from `service/`:

```sh
pnpm exec node --import tsx --test src/agent/invocation-worker.test.ts src/agent/invocation-timing.test.ts src/agent/invocation-events.test.ts
```

Result: 22 passed, one database integration test skipped, zero failed. Includes
admission wake before timer fallback, slot refill, commit-only hints and rollback,
and lifecycle publication recovery. This confirms code behavior, not the exact
binary/configuration currently running in production.

## Suggested delivery order and boundaries

1. **Correct history:** F3 with both clients' invalid-cursor recovery and shared
   fixtures. Close F6 with the implementation evidence above.
2. **Event-driven state:** F1 plus separation of cheap state/budget reads from F2;
   web and mobile adopt together. Preserve stream/bootstrap recovery. Establish
   F5 measurements alongside this change.
3. **Budget reuse:** include applicable known snapshots; add bounded caching only
   with explicit invalidation tests. Do not make cold reconstruction block open.
4. **Account policy:** F4 as an independent auth workstream, required before any
   client feature that promises the stronger revocation behavior.

No daemon protocol change is expected for F1–F3/F5/F6. Coordinate service/web/
mobile for state semantics and cursor resets. F4 may require DB migrations and
credential renewal, depending on the selected policy. Future implementation
must update route/agent/runtime/auth/web specs, `docs/proto.md` for new SSE events,
the mobile handoff/fixtures, and the ownership validation checklist. All new
reads authorize the viewer and owned thread before querying; publication derives
thread ownership from committed rows, never client-supplied routing metadata.

Continue deferring transcript deltas/tombstones, durable list replay and shared
replay infrastructure absent a concrete need. These follow-ups can improve both
clients using canonical snapshots plus complete invalidation; they do not need
an event-sourced transcript, an iOS-only API, or a new generic synchronization
framework.
