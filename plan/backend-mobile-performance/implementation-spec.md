# Implementation Spec: Backend Mobile Performance

**Status:** Service/web contracts implemented and locally validated; see progress and handoff for native/deployment evidence still pending.
**Created:** 2026-09-30
**Baseline:** Service `9d6b300`; recheck affected code before implementation.
**Tracking:** [Progress](progress-checklist.md) · [Validation](validation-checklist.md)

## Context and objective

Implement the accepted scope from the
[backend review](../../reference/IOS_PERFORMANCE_BACKEND_REQUESTS.md), using the
[current-contract answers](../../reference/IOS_PERFORMANCE_BACKEND_QUESTIONS.md)
as source evidence. Improve send scheduling, new-chat admission, thread opening,
list updates and response size for both mobile and web.

The intended result is less unnecessary waiting and fetching, bounded reads, and
one shared client contract. Durable database state remains authoritative; bounded
stream replay provides continuity with explicit recovery when continuity is lost.

This plan builds on the existing
[transcript API](../mobile-api-simplify/implementation-spec.md) and
[stream attachment](../mobile-agent-stream-attach-semantics/implementation-spec.md)
work. Older plan statuses/spec descriptions may lag current durable admission;
verify implementation rather than reintroducing their legacy execution branches.
Mobile's external `plan/perf/` is a coordination dependency, not a reviewed local
artifact. This directory specifies backend work and the required client adoption.

## Phase map

| Phase | Requests | Deliverable | Dependency |
|---|---|---|---|
| [0: Measurement](phase-0-measurement.md) | R6 | Defined timing boundaries and a reproducible baseline | None |
| [1: Worker scheduling](phase-1-worker-scheduling.md) | R1 | Post-commit wake, capacity refill, invocation status events | Phase 0 baseline |
| [2: Atomic new chat](phase-2-atomic-new-chat.md) | R4 | Idempotent thread creation with first-message admission | Phase 1 wake integration |
| [3: Transcript and open](phase-3-transcript-and-open.md) | R2, R5 | Shared compact serialization and safe snapshot/stream recovery | Phase 1 publication foundation |
| [4: Thread list](phase-4-thread-list.md) | R3 | Bounded pagination and one user-scoped row feed | Phase 0; shared summary loader |
| [5: Small follow-ups and closeout](phase-5-follow-ups-and-rollout.md) | R9, R10 | Read-summary response, discovery TTL, final client handoff | Small changes independent; closeout follows 1–4 |

Phases are implementation units, not necessarily separate releases or PRs. Phase
4 can move ahead of 2/3 if list measurements warrant it; extract the shared summary
loader there first. Phase 3 has a serialization step and a recovery step that can
be reviewed independently. Include reference-web adoption and mobile fixtures in
each contract phase rather than postponing all client work until closeout.

## Fixed scope and constraints

- Keep durable admission, thread reservations, lease fencing and existing execution
  concurrency. Waking a worker does not authorize or execute work by itself.
- Reuse shared authorized loaders and serializers. Do not implement `open` by
  making HTTP requests back into the service or by bypassing resource checks.
- Use bounded full snapshots initially. No transcript change ledger, tombstones,
  durable list resume, pinned replay TTL or shared replay store in these phases.
- Preserve message IDs, `client_id` reconciliation, timings, reasoning/compaction
  rows and model-replay evidence. Compact the client wire representation first.
- Keep existing messages pagination for older history and agent state for targeted
  recovery. Consolidating initial reads does not retire these capabilities.
- Use the existing authenticated viewer, owner-filtered SQL, `401` for missing
  authentication and `404` for foreign resources. Authorize before stream attach.
- Keep snake_case wire fields. No daemon protocol changes are planned.
- Assume the checked-in single-instance service topology only after confirming the
  actual deployment in Phase 0. Do not build speculative multi-instance support.

## Ownership and persistence

| Surface | Resource and authorization | Writes/stamping |
|---|---|---|
| Create with first message | Resolve viewer and owned Bud; transaction rechecks ownership | Thread, message, invocation and creation receipt inherit owner; include tenant fields |
| Open/messages/state | Resolve owned thread; optional site/browser data keeps its own access checks | Read-only |
| Invocation events | Owned thread before subscription and during existing auth rechecks | Publish committed, client-safe state only |
| List GET/feed | Viewer-scoped SQL and currently owned Bud/thread joins | Read-only; removals cannot expose another owner's summary |
| Mark read/summary | Resolve owned thread and message; aggregate only viewer-owned threads | Stamp acting user on read state |
| Discovery | Existing public issuer metadata routes | Configuration only |

Add each changed read/stream/write to the
[multi-user checklist](../init-auth/validation-checklist.md) during implementation.
Never persist raw request bodies in idempotency receipts solely to compare retries.

## Deferred work and reconsideration criteria

| Item | Decision and trigger |
|---|---|
| R7 account/session revocation | Separate correctness design. Establish account states, session granularity and revocation deadline before choosing enforcement. Not a dependency for parallel startup. |
| R8 model ETag | Optional follow-up only if catalog transfer/revalidation is material and implementation is small. Cache painting can proceed today. No inventory-wide version propagation. |
| Transcript validation/deltas | First measure compact full-window revisits. Prefer one unchanged-response validator if that solves the measured cost; durable deltas require a separate design. |
| Durable list resume | Reconsider if bounded reconnect GETs remain material after consolidation. |
| Tool summary/detail projection | Reconsider if deduplicated full tool pages still exceed the measured byte/decode budget. |
| Cross-instance wake/replay | Requires an actual deployment need and a reviewed topology change. |

These are excluded from completion criteria. Do not silently promote them into
implementation while working through a phase.

## Evidence and decision gates

2026-09-30 user confirmation: production remains one service instance. Keep
process-local wake/replay for this scope; multiple instances will require a future
design for routing/publication/replay. Mobile delivery for this implementation is
a contract/fixture handoff document to its team, not a required edit or release
in the external mobile repository. Record adoption as unverified until their build
is tested; do not treat the handoff as deployed client validation.

Confirmed source findings include one worker attempt per second, incomplete list
invalidation, unbounded list reads and ordinary tool payload duplication. Production
percentiles, payload distributions and the mobile waterfall remain unmeasured.
The proposed 500 ms scheduling reduction is an idle-arrival estimate, not an SLO.

Resolve these bounded decisions in the owning phase and record the result there:

| Decision | Owner phase | Required evidence |
|---|---|---|
| Deployment topology and available pool capacity | 0 | Actual instance/worker configuration and connection use |
| Timing/size budgets | 0 | Representative baseline with sample counts and workload definitions |
| Post-commit publication ordering | 1, extended in 3 | Delayed callbacks, concurrent commits and recovery race tests |
| Snapshot/replay reconciliation | 3 | Mutation coverage inventory and adversarial interleaving fixtures |
| List cursor/window semantics | 4 | Exact sort/filter contract and page/patch concurrency fixtures |
| Client release compatibility | Each contract phase | Named deployed web/mobile consumers and tested deployment order |

Do not remove existing recovery reads until Phase 3's correctness gate passes.
Do not report the compound response as an atomic snapshot without implementing
and testing that property.

## Specs and contracts to update during implementation

- [Root architecture](../../bud.spec.md), [service](../../service/service.spec.md)
  and [service source](../../service/src/src.spec.md) for changed flow/ownership.
- [Routes](../../service/src/routes/routes.spec.md),
  [thread routes](../../service/src/routes/threads/threads.spec.md),
  [agent](../../service/src/agent/agent.spec.md) and
  [runtime](../../service/src/runtime/runtime.spec.md) as their phases land.
- [DB](../../service/src/db/db.spec.md) and
  [migration catalog](../../service/drizzle/migrations/migrations.spec.md) for the
  creation receipt, trigger changes or indexes actually introduced.
- [Auth](../../service/src/auth/auth.spec.md) for discovery TTL;
  [personal data](../../service/src/personal-data/personal-data.spec.md) for admission wake coverage.
- [Protocol](../../docs/proto.md) for SSE changes; affected web folder specs for
  loaders, types, reducers and renderers. New modules must enter their parent spec.

Impacted contracts: REST, SSE, database schema/triggers, reference web and mobile.
Agent tool execution semantics and Bud↔service protocol are outside this scope.

## Rollout and completion

Additive service contracts may deploy first. Wire removals and changed list response
shapes require coordinated web/mobile builds. Record exact versions and migration
filenames at implementation time; none have been assigned by this planning change.
The service auto-deploys on merge, so resolve rollout ordering before merging.

Schema work requires local `db:push`, generated/reviewed checked-in migrations and
deployment through `db:migrate`. Retain durable receipts across rollback; do not
roll back data by deleting admitted work. Restarting the service loses local replay
and clients must explicitly recover. No daemon upgrade is expected.

Complete when phases 0–5 meet their acceptance criteria, both-client adoption is
recorded, measured results and limitations are published, temporary bridges have
been removed, and [validation](validation-checklist.md) has evidence. Creating this
plan authorizes no deployment and marks no implementation work complete.
