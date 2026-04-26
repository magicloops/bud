# Phase 1: Durable Control And Reconciliation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: In progress - durable schema/store, daemon journal, live reconnect exchange, and gateway drain foundation implemented

---

## Objective

Add enough durable operation, stream, and device-session state for daemon work to reconcile across reconnects, backend deploys, and transport migration. This phase should not become a generic workflow engine.

## Context

Current terminal sessions persist in tmux and terminal output persists in `terminal_session_output`, but daemon-directed requests themselves are mostly in-memory. Proxy and file streams will need clearer lifecycle state: who requested the work, whether the daemon accepted it, what stream exists, what bytes were delivered, and whether outcome is known after reconnect.

## Scope

### In Scope

- `device_session` records or equivalent
- `transport_session` records or equivalent
- minimal `bud_operation`
- minimal `bud_stream`
- reconnect reconciliation report from daemon
- service-side reconciliation handling
- daemon local journal for accepted operations and active stream checkpoints
- explicit `UNKNOWN` outcome state
- gateway drain state
- audit-event foundation if needed for phase 4

### Out Of Scope

- proxy/file sessions themselves
- QUIC health scoring
- full workflow orchestration
- multi-user collaboration semantics
- replacing `terminal_session_output`

## Fixed Decisions

- Operation and stream rows are scoped to an owning Bud and user where browser-visible.
- Terminal-specific history remains in `terminal_session_output`.
- Live routing may remain process-local at first, but durable state must not assume a single process forever.
- Reconnect reconciliation should prefer explicit `UNKNOWN` over invented success/failure.
- The daemon journal only needs to cover accepted operations and active stream checkpoints, not full terminal history.

## Implementation Tasks

### Task 1: Design lifecycle states

Define operation states:

- `offered`
- `accepted`
- `rejected`
- `running`
- `succeeded`
- `failed`
- `canceled`
- `unknown`
- `expired`

Define stream states:

- `opening`
- `open`
- `half_closed_local`
- `half_closed_remote`
- `closed`
- `reset`
- `unknown`
- `expired`

Define allowed transitions and where each transition is authoritative.

### Task 2: Add schema and migrations

Add minimal tables or equivalents:

- `device_session`
- `transport_session`
- `bud_operation`
- `bud_stream`
- initial `audit_event` if the team wants audit IDs in operation/stream rows immediately

Required fields should cover:

- tenant/user ownership fields following repo conventions
- Bud/device foreign keys
- operation/stream IDs
- idempotency keys
- state and timestamps
- transport kind/session references
- traffic class
- byte offsets and credit counters where needed
- typed error/reset metadata

Follow the repo Drizzle workflow and update DB specs/migration specs.

### Task 3: Add service repositories

Create repository/helper modules for:

- operation creation and idempotent lookup
- state transitions with optimistic guards
- stream creation and state transitions
- device-session registration
- transport-session registration
- audit event append

Keep SQL ownership filters explicit for browser-originated resources.

### Task 4: Add daemon local journal

Persist enough local daemon state to report:

- accepted operation IDs
- running operation IDs
- active stream IDs
- last known stream offsets/checkpoints
- local policy version
- terminal sessions currently known to the daemon

The journal should tolerate missing/corrupt entries by reporting less, not by blocking daemon startup.

### Task 5: Add reconnect reconciliation protocol

Add control payloads for:

- daemon reconnect report
- service reconciliation request
- operation status report
- stream status report
- service reconciliation decision

The service should resolve mismatches into:

- confirmed current state
- retry/resume directive
- reset directive
- `UNKNOWN`

Current implementation:
- daemon sends `reconnect_report` after handshake from its local journal
- service validates the report, records an audit event, compares reported operation/stream ids with durable rows, and replies with `reconciliation_decision`
- unknown matches are returned as `unknown` with typed `UNKNOWN_OPERATION` / `UNKNOWN_STREAM` errors
- daemon logs the decision; future proxy/file phases will add concrete resume/reset behavior per stream type

### Task 6: Add gateway drain semantics

Add a gateway drain flag/state so a service instance can:

- stop accepting new long-lived streams
- let existing streams finish within a deadline
- mark affected operations/streams `unknown` or `reset` if cut short
- tell daemons to reconnect to a new gateway if the deployment supports it

Current implementation:
- process-local gateway drain can be enabled through the transport helper
- the WebSocket router refuses new long-lived work (`terminal_ensure`, proxy-open, file-open/read) while allowing control frames
- active transport close/timeout marks affected durable operation/stream rows `unknown`

### Task 7: Update terminal routing to record operations where useful

Do not overfit terminal sends into a heavyweight workflow. Record enough operation metadata for later transport cutover and debugging:

- request ID / operation ID
- thread/session context
- owner
- state transitions
- final typed error if any

## Files Likely Affected

### Service

- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- `service/src/runtime/`
- `service/src/runtime/terminal/`
- `service/src/transport/`
- new `service/src/audit/`
- new repository modules under `service/src/db/` or `service/src/runtime/`

### Bud

- `bud/src/protocol.rs`
- `bud/src/app.rs`
- new `bud/src/journal/`
- new or updated `bud/src/transport/`

### Docs

- `docs/proto.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- affected runtime/transport specs

## Test Plan

- schema tests or migration inspection for all new tables/indexes
- service repository state-transition tests
- operation idempotency tests
- daemon journal read/write tests
- reconnect reconciliation unit tests
- manual reconnect test while terminal session is active

## Exit Criteria

- operation and stream lifecycle states are documented and represented in schema/code
- daemon reconnect reports enough state for service reconciliation
- service can mark uncertain work `UNKNOWN`
- terminal flows still behave the same for users
- schema changes have checked-in migrations and updated specs
