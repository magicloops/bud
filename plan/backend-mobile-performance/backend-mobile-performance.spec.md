# backend-mobile-performance

## Purpose

Phased implementation plan for the accepted iOS backend performance requests.
Tracks shared service/web/mobile API improvements, measurable outcomes, ownership,
stream recovery and coordinated rollout. Implementation is in progress; see the
progress checklist for tested foundations and outstanding phase gates.

## Files

| File | Responsibility |
|---|---|
| [implementation-spec.md](implementation-spec.md) | Scope, dependencies, constraints, deferred decisions, affected specs and completion criteria |
| [phase-0-measurement.md](phase-0-measurement.md) | Timing instrumentation, deployment confirmation and baseline workloads |
| [phase-1-worker-scheduling.md](phase-1-worker-scheduling.md) | Post-commit wake/claim/refill and committed invocation lifecycle delivery |
| [phase-2-atomic-new-chat.md](phase-2-atomic-new-chat.md) | Creation receipt, atomic admission, retry semantics and migration |
| [phase-3-transcript-and-open.md](phase-3-transcript-and-open.md) | Compact shared tool serialization, bounded open, publication coverage and replay correctness |
| [phase-4-thread-list.md](phase-4-thread-list.md) | Bounded list pagination, one owner feed, checkpoint ordering and complete invalidation |
| [phase-5-follow-ups-and-rollout.md](phase-5-follow-ups-and-rollout.md) | Mark-read summary, discovery freshness and coordinated closeout |
| [progress-checklist.md](progress-checklist.md) | Implementation tracking; no phases marked complete by planning |
| [validation-checklist.md](validation-checklist.md) | Automated, database, client, performance and rollout evidence |

## Dependencies and boundaries

- [Reviewed requests](../../reference/IOS_PERFORMANCE_BACKEND_REQUESTS.md) and
  [current-contract answers](../../reference/IOS_PERFORMANCE_BACKEND_QUESTIONS.md).
- Existing durable invocation repository, runtime replay, thread/list serializers
  and authenticated ownership helpers; linked source specs in the parent plan.
- Web/mobile adoption is required for changed wire shapes. No daemon change planned.
- Durable delta/resume infrastructure and account/session revocation policy remain
  separate work. Open implementation gates are recorded in the parent and phases.

No runtime dependencies or implementation debt are introduced by these documents.

*Cataloged by [bud.spec.md](../../bud.spec.md).*

## Handoff artifacts

- `mobile-api-handoff.md`: coordinated-release contracts, client algorithms,
  rollout order, mutable implementation choices and explicit unverified evidence.
- `mobile-api-fixtures.json`: synthetic request/response/event examples.
