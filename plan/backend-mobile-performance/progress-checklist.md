# Progress: Backend Mobile Performance

**Status:** Service/web implementation and local validation completed for the
contracts below. Native adoption, deployed measurements and coordinated rollout
are pending external validation, not claimed as passes.
**Parent:** [Implementation spec](implementation-spec.md).
**Delivery:** [Mobile API handoff](mobile-api-handoff.md) · [Fixtures](mobile-api-fixtures.json).

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
locally instead. No deployment, commit, PR or production restart performed.

The web keeps its existing five-second durable-state fallback for non-message
pending inventories. Message publication is complete through database triggers,
but that does not prove all pending-request inventory changes are event-driven.
Removing this fallback remains gated on that separate coverage evidence. No new
compatibility flags, durable event ledger or multi-instance routing were added.
