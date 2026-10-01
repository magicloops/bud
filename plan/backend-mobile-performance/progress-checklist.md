# Progress: Backend Mobile Performance

**Status:** Service/web implementation and local validation completed for the
contracts below. Native adoption, deployed measurements and coordinated rollout
are pending external validation, not claimed as passes.
**Parent:** [Implementation spec](implementation-spec.md).
**Delivery:** [Mobile API handoff](mobile-api-handoff.md) · [Fixtures](mobile-api-fixtures.json).
**Follow-up:** [Mobile questions and cutover](mobile-api-follow-up-handoff.md) ·
[Expanded fixtures](mobile-api-follow-up-fixtures.json).
**PR:** [#139](https://github.com/magicloops/bud/pull/139), implementation `cee62c3`
and OAuth startup regression fix `65a1be7`.

| Phase | Implemented and checked locally | Still unverified |
|---|---|---|
| 0 | REST/SSE timing boundaries, row/byte logging; single-instance topology confirmed | Production pool use, representative p50/p95/device decode and overhead budgets |
| 1 | Serialized immediate worker wake/claim/refill; committed invocation publication; transaction/fencing fixtures | Production concurrent-send comparison |
| 2 | Atomic thread/message/invocation receipt, exact retry, owner isolation, rollback/deletion; matching web creation | Native build; composer retry survives only the mounted web visit |
| 3 | Compact shared DTO; fresh pre-read checkpoint; bounded open; DB insert/mutation publication; canonical replay guards; loaded-history reconciliation; web open adoption | Full native replay/scroll QA and production resync frequency |
| 4 | Bounded owner SQL, exact tuple cursors, owner feed/checkpoints, complete DB summary hints, capped web window/refill/paging and paged automation selectors | Production fan-out/pool/backpressure measurements |
| 5 | Atomic monotonic read + SQL summary; discovery cache headers; protocol/specs and mobile handoff | Actual mobile build ID, proxy freshness, deployment/restart/rollback exercise |

Local migrations: generated/reviewed 0048 and custom 0049, exact SQL execution
fixtures and local application. `db:push` was attempted but canceled when it
proposed unrelated destructive constraint churn; reviewed plan SQL was applied
locally instead. Implementation and startup fix are committed and pushed in PR
#139. No deployment or production restart has been performed by this work.

2026-10-01: Adam confirmed the product is pre-launch and all Buds/mobile clients
can upgrade in sync. Mobile implementation is underway with its team; exact native
build and device acceptance are still pending. Use a coordinated cutover, without
a legacy compatibility bridge. Merge triggers service deployment, so migration
and matching-client readiness must be confirmed before merge. This API change
does not itself require a daemon update.

Backend implementation readiness is distinct from full plan completion: Phase 0
representative measurements and Phase 5 live release/restart/rollback acceptance
remain open. The expanded handoff addresses all five mobile follow-up questions;
its serializer-generated fixtures are synthetic, not captured production traffic.

The web keeps its existing five-second durable-state fallback for non-message
pending inventories. Message publication is complete through database triggers,
but that does not prove all pending-request inventory changes are event-driven.
Removing this fallback remains gated on that separate coverage evidence. No new
compatibility flags, durable event ledger or multi-instance routing were added.
