# Plan: Stable thread ordering

Status: implemented across service, web, and mobile; manual UI acceptance pending.

## Context and objective
Implement [design](../design/stable-thread-ordering.md): promote on persisted user
messages and final assistant responses, never on intermediate work. Preserve
ownership and make ordering deterministic across reloads and clients.

## Approach
- Add/backfill `last_conversation_at` and atomically maintain it at message insert.
- Expose/order by it in owned thread lists and summaries.
- Deliver list-level updates for inactive threads; monotonically merge on clients.
- Update web and mobile comparators and validate concurrent work/replay behavior.

## Specs and contracts
DB schema and migrations specs; thread routes; web workbench/routes/lib specs;
mobile design; protocol summary stream; auth validation checklist.
No daemon change. Apply migration before service, then coordinated client builds.

## Validation
PostgreSQL insert/rollback/backfill tests, owner isolation, client ordering and
stale snapshot tests; service/web type checks and mobile build/tests where available.

## Results
- Service: 44 route/schema/PostgreSQL tests passed; final focused migration and
  stream checks passed after adding migration readiness validation.
- Service and web TypeScript checks passed; two web ordering tests passed.
- iOS simulator build passed. Targeted suite: 127/131 passed, including both new
  ordering tests and DTO tests. The four model-selection failures reproduce with
  identical assertions on unchanged mobile HEAD `b4f3b64`; see the debug note.
- Local migration 0043 applied. Deployment must apply the checked-in SQL before
  starting the updated service, then rebuild mobile. No daemon restart needed.
- Remaining: manually run two concurrent threads on web/mobile, checking stable
  order during work and promotion on accepted user messages/final responses;
  perform the real cookie/bearer revocation checks in the auth checklist.
