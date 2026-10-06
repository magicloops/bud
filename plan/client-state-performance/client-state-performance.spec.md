# client-state-performance

## Purpose

Implementation specifications for shared backend/web/mobile state performance
follow-ups F1–F6. Service/web phases 0–3 implemented; measurements and native
acceptance remain outstanding. Phase 4 deferred; Phase 5 policy gated. Phase 6
(PR #140 review hardening and slow backstop) implemented locally. Mobile is not live, so
no backwards compatibility is required.

## Files

| File | Responsibility |
|---|---|
| [implementation-spec.md](implementation-spec.md) | Objective, phase dependencies, ownership, scope and rollout |
| [phase-0-measurement.md](phase-0-measurement.md) | Complete latency measurements and existing worker-wake verification |
| [phase-1-exact-cursors.md](phase-1-exact-cursors.md) | Microsecond-safe history cursors and client reset behavior |
| [phase-2-cheap-state-and-budget.md](phase-2-cheap-state-and-budget.md) | Cheap state/open contracts, dedicated budget read and client adoption |
| [phase-3-pending-request-events.md](phase-3-pending-request-events.md) | Complete post-commit invalidation; five-second thread poll removed |
| [phase-4-budget-reuse.md](phase-4-budget-reuse.md) | Optional, measurement-gated bounded budget reuse |
| [phase-5-account-policy.md](phase-5-account-policy.md) | Account eligibility, revocation decisions and client cache policy |
| [phase-6-review-hardening.md](phase-6-review-hardening.md) | PR #140 review fixes, 60-second cheap-state backstop, payload simplification |
| [validation-and-rollout.md](validation-and-rollout.md) | Acceptance evidence, progress and coordinated releases |

## Dependencies

Existing thread loaders, durable request/invocation repositories, runtime replay,
viewer authorization and web stream reducers. No new runtime dependency is
introduced by this plan. Parent catalog: [prior plan](../backend-mobile-performance/backend-mobile-performance.spec.md).

Related source specs are listed in [implementation-spec.md](implementation-spec.md).

## Implementation artifacts

- `mobile-api-handoff.md`: REST/SSE contracts and coordinated client rollout.
- `contract-fixtures.json`: synthetic exact cursor, pending replacement and budget
  omission/available/stale/unknown examples; available budget uses service builder.
- `mutation-coverage.md`: trigger boundaries, ownership, tests and physical gaps.
- `measurement-runbook.md`: INFO histogram aggregation and comparable workloads.
