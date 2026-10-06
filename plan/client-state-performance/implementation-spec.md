# Implementation Spec: Shared Client State and Performance

Status: Phases 0–3 implemented in service/web; local validation recorded below.
Native/physical acceptance and production measurements pending. Phase 4 deferred;
Phase 5 awaits policy decisions. Updated: 2026-10-05.

## Context

Implement the accepted direction in the
[review](../../research/ios-performance-backend-follow-ups.md) of
[mobile follow-ups F1–F6](../../reference/IOS_PERFORMANCE_BACKEND_FOLLOW_UPS.md).
Extend [backend/mobile performance](../backend-mobile-performance/implementation-spec.md)
without changing its durable execution authority or adding client-specific APIs.
The external mobile repository is a handoff dependency, not part of this checkout.

## Objective

History pagination must not skip microsecond-boundary rows. An idle visible
thread with a healthy stream must need no routine agent-state polling. Thread
opening must never reconstruct model context to paint chat. Web and mobile use
the same canonical snapshots, invalidation events and recovery rules. Auth policy
must be enforced consistently before clients claim stronger revocation behavior.

## Phases and dependencies

| Phase | Scope | Dependencies / completion |
|---|---|---|
| [0: Measurement](phase-0-measurement.md) | F5 distributions; F6 confirmation | Independent; baseline before performance comparisons |
| [1: Exact cursors](phase-1-exact-cursors.md) | F3 correctness | Independent; first release candidate |
| [2: Cheap state and budget](phase-2-cheap-state-and-budget.md) | F2 bounded opening and targeted reads | Shared web/mobile adoption |
| [3: Pending events](phase-3-pending-request-events.md) | F1 complete invalidation, remove thread poll | Phase 2 cheap reads; publication/recovery coverage |
| [4: Budget reuse](phase-4-budget-reuse.md) | Further F2 request reduction | Optional after Phase 0/2 measurements |
| [5: Account policy](phase-5-account-policy.md) | F4 shared eligibility and revocation | Independent; policy/provider decisions before final schema |

Phases are reviewable units, not mandatory separate PRs. Phases 2/3 can share a
coordinated release. Phase 4 may be explicitly deferred without blocking 1–3.
Phase 5 must be reported separately; it cannot be called delivered with only a
new error string or client cache handling.

## Design / approach

- PostgreSQL remains canonical; existing bounded process-local SSE replay gives
  continuity and explicit resync. No durable event log or generic sync framework.
- Centralize post-commit pending-state invalidation with filtered PostgreSQL
  triggers on the existing thread-change channel. Execution wake hints remain separate from client notification.
- Split cheap runtime/pending state from expensive context-budget reconstruction.
  Reuse the existing accounting implementation; do not estimate from a UI page.
- Preserve the `/open` runtime/cursor boundary captured before canonical reads.
  The compound response is not an atomic database snapshot.
- Ordinary targeted state refreshes never move a client's stream resume cursor.
  Only the full bootstrap/recovery algorithm adopts a snapshot boundary.
- Use snake_case wire fields and shared fixtures. No permanent legacy modes for
  controlled pre-launch clients; coordinate changed semantics and cursor resets.

## Ownership

| Surface | Authorization and data scope | Writes |
|---|---|---|
| Open, messages, state, budget | Resolve cookie/bearer viewer, authorize thread before loading; owner-filter durable reads | None, except bounded ephemeral budget cache |
| Pending SSE | Authorize owned thread before attach/replay; derive publication routing from committed owned rows | No separate request ledger |
| Request decisions | Existing resource authorization, optimistic version checks, owner-bound transactions | Retain acting-user/owner stamps |
| Account policy | Verified identity plus live account eligibility; mutation restricted to authorized administration | Account target, acting administrator, tenant where applicable, audit |
| Metrics | Route-template aggregates only | No user content, IDs, credentials or per-request DB rows |

Retain `401` for authentication failure and `404` for foreign resources. Add
eligibility-specific errors only under Phase 5. Add changed reads/streams to
[multi-user validation](../init-auth/validation-checklist.md).

## Spec files to update during implementation

- [Thread routes](../../service/src/routes/threads/threads.spec.md),
  [routes](../../service/src/routes/routes.spec.md),
  [service source](../../service/src/src.spec.md): cursor/state/budget/metrics.
- [Agent](../../service/src/agent/agent.spec.md),
  [runtime](../../service/src/runtime/runtime.spec.md),
  [personal data](../../service/src/personal-data/personal-data.spec.md),
  [browser](../../service/src/browser/browser.spec.md): mutation and replay coverage.
- [Web thread features](../../web/src/features/threads/threads.spec.md),
  [web routes](../../web/src/routes/routes.spec.md),
  [Bud routes](../../web/src/routes/$budId/budId.spec.md),
  [web lib](../../web/src/lib/lib.spec.md): reducers, transport and recovery.
- [Auth](../../service/src/auth/auth.spec.md),
  [DB](../../service/src/db/db.spec.md),
  [migrations](../../service/drizzle/migrations/migrations.spec.md): Phase 5 policy.
- [Root](../../bud.spec.md), [service](../../service/service.spec.md),
  [web](../../web/web.spec.md) when flows change; parent specs for new modules.
- [Protocol](../../docs/proto.md): new SSE event. Publish updated mobile contracts
  and executable fixtures in this plan directory during implementation.

## Impacted contracts

- [x] REST state, budget and message cursors
- [x] SSE invalidation and recovery
- [x] Web UI and external mobile adoption
- [ ] Bud–service wire protocol: no change expected
- [ ] Agent tools: no execution/schema changes expected
- [x] DB migration: Phase 3 trigger-only 0050; no new tables/columns. Phase 5 undecided.

Schema changes require local `pnpm db:push`, generated/reviewed checked-in
migrations and deployed `pnpm db:migrate`; record actual filenames, not invented
sequence numbers. No data migration to reduce message timestamp precision.

## Non-goals and risks

Defer transcript deltas/tombstones, durable list resume, catalog propagation,
distributed wake/replay, durable budget caches and owner-wide request feeds.
Standalone permissions/automation pages may keep their view-local polling.
Missing mutation coverage is the primary risk to removing thread polling;
acceptance requires a writer inventory and adversarial replay tests.

Single-instance production was confirmed on 2026-09-30; verify again before
rollout. A separated worker or multiple service instances requires a topology
design before relying on process-local hints. Existing DB claim/fence authority
must never depend on event delivery.

## Test plan and rollout

Use [validation and rollout](validation-and-rollout.md) as the evidence ledger.
Do not mark client adoption or deployment tested when only fixtures were handed
off. Service auto-deploys on main merge; record matching service/web/mobile
versions and cutover order before merge. No daemon upgrade expected for 0–4.
No commit, PR, merge or deployment is authorized by this planning document.

## Implementation decisions

- Migration `0050_pending_request_notifications.sql` replaces the proposed
  application callback collection. Existing LISTEN infrastructure covers raw-pg,
  maintenance and operational writers without duplicated per-writer callbacks.
  See [mutation coverage](mutation-coverage.md). All five kinds invalidate together.
- Active budget applicability is the matching runtime turn. It describes that
  running decision, not the next turn after a preference change. No idle cache.
- INFO interval histograms are the chosen metrics export; production baseline
  remains pending. [Runbook](measurement-runbook.md).
- [Mobile handoff](mobile-api-handoff.md) and [fixtures](contract-fixtures.json)
  describe rollout requirements; native adoption is not verified by web tests.
