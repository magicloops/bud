# Phase 2: Terminal Runtime Ownership Split

## Objective

Split terminal runtime responsibilities so session lifecycle, request dispatch, output persistence, readiness/context tracking, and idle cleanup each have clearer ownership boundaries.

This phase should also finish the correctness work around cancel/offline fast-fail behavior and concurrent first-use session creation.

## Scope

### In scope

- centralize thread terminal session creation/ensure ownership
- split terminal send/observe request dispatch from session lifecycle and output persistence
- add cancel/offline fast-fail behavior for pending terminal waits
- make first-use session creation concurrency-safe
- add direct tests for cancel/offline behavior and session creation races

### Out of scope

- deep `AgentService` decomposition
- route/gateway decomposition beyond any minimal plumbing needed for the new terminal seams
- broader product-level changes to terminal semantics

## Proposed Work

### 1. Introduce a single session-record ownership boundary

Target responsibilities to centralize:

- get-or-create session record for a thread
- active-session uniqueness handling
- session lookup by thread/session id
- state transitions for pending/creating/ready/closed

Likely result:

- an extracted store or lifecycle layer under `runtime/terminal/`
- one `ensureSessionRecordForThread(...)` entrypoint shared by routes and agent paths

### 2. Extract terminal request-dispatch ownership

Move send/observe request orchestration into a dedicated dispatcher that owns:

- request id generation
- pending request registries
- per-request timeouts
- mapping Bud responses back to pending promises
- abort/offline rejection behavior

This should become the place where cancel/offline fast-fail is implemented, rather than leaving it split between `AgentService`, `TerminalSessionManager`, and gateway side-effects.

### 3. Extract output persistence and replay ownership

Move terminal output storage/replay concerns behind a clearer boundary:

- output row persistence
- byte-offset tracking
- replay/tail queries
- soft-cap handling
- event-bus emission for output rows

### 4. Extract context, readiness, and idle ownership

Separate the lighter-weight in-memory runtime state:

- readiness cache
- pending command / context state
- idle timer/check worker
- Bud offline suspension/reset behavior

### 5. Fix the first-use session race as part of the new lifecycle boundary

Do not patch the race in callers. The lifecycle/store boundary should absorb:

- read-then-insert conflict handling
- retry on active-session uniqueness collisions
- a stable return path for both browser and agent first-use races

## Expected File Areas

- `service/src/runtime/terminal-session-manager.ts`
- new files under `service/src/runtime/terminal/`
- `service/src/routes/threads.ts` or the new thread terminal route module
- `service/src/agent/agent-service.ts`
- `service/src/ws/gateway.ts`

## Testing Strategy

### Automated

- direct tests for `ensureSessionRecordForThread(...)` conflict behavior
- direct tests for pending observe/send rejection on cancel
- direct tests for pending observe/send rejection on Bud offline transition
- regression coverage for output replay and readiness persistence seams that are extracted

### Manual

- create a thread terminal explicitly, then send the first user message immediately and confirm session creation remains stable
- cancel a long-running terminal wait and confirm it fails promptly
- simulate Bud disconnect during a wait and confirm the pending tool path fails promptly

## Exit Criteria

- session-record lifecycle has a single owned boundary
- pending send/observe waits fail fast on cancel and Bud disconnect
- first-use session creation is concurrency-safe
- output persistence/replay is no longer mixed directly with all other terminal runtime concerns
- terminal runtime seam-level tests exist for the new ownership boundaries
