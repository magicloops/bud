# Pending inventory mutation coverage

Migration 0050 uses PostgreSQL AFTER triggers and the existing 0049
`bud_thread_changes` channel. Notifications become visible only at outer commit,
including raw-pg and operational SQL. This replaces the proposed application
callback collection, avoiding a separate hook in every writer. No tables or
request ledger are added. Trigger DDL is migration-owned, outside schema.ts.

| Canonical table | Inventory / visibility |
|---|---|
| agent_question_request | Questions: create, answer, supersession, cancellation, repair |
| data_access_request | App permissions: create, decisions, persisted expiry/invalidation |
| automation_proposal | Activation review: create, decisions, persisted stale/expired/canceled state |
| automation_bootstrap_proposal | Existing-contact review: create, decisions, persisted stale/expired/canceled state |
| browser_handoff | Browser handoff creation, resolution, timeout/cancel/recovery |
| agent_invocation | Reservation/status/cancel and owner/thread joins for all inventories |
| agent_invocation_action | Entering/leaving waiting_for_user, including return-control waits |
| thread / bud (0049) | Ownership/deletion resets invalidate replay and require authorization again |

INSERT/UPDATE/DELETE are covered. Request updates differing only in updated_at
are ignored; invocation lease heartbeats are ignored. Ordinary action progress
outside waiting_for_user is ignored before any row serialization. One transaction may coalesce duplicate hints.
All five inventories are invalidated together (empty event payload); publication rechecks current thread/Bud
ownership, then uses ordinary runtime replay. Queue overflow or publication loss
forces resync. Existing expiry/staleness machinery still owns persisting those
states; notifications do not introduce new expiry or grant-policy semantics.

A missed hint is bounded by the clients' 60-second visible-thread backstop read.

Exact migration tests run against copies of the real local table definitions
(`LIKE public.<table>`, NOT NULL relaxed), so a renamed column fails the test.
They exercise the five request tables, rollback, expiry and
delete, action transitions, invocation reservation release and lease filtering
through separate PostgreSQL connections. Publisher tests cover owner loss,
publication failure and invalidation during an async ownership lookup. Mounted
web tests cover burst coalescing, mutation during reads, retries, foreground,
owner/thread fencing and pending-only overlay replacement.

Remaining acceptance: two physical clients, real producer flows for every review
kind, full restart/open/attach races and production maintenance timing. SQL
coverage is broader than application callbacks but does not replace those tests.
