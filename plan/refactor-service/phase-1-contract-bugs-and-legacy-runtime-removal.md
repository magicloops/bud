# Phase 1: Contract Bugs And Legacy Runtime Removal

## Objective

Fix the most important browser-visible, bootstrap, and runtime correctness issues first, then remove the standalone legacy run surface so the rest of the refactor does not preserve dead architecture by accident.

This phase should leave the service on a cleaner behavioral base before the deeper ownership splits start.

## Scope

### In scope

- remove the standalone run/runtime surface if no current first-party consumer still depends on it
- remove the legacy unauthenticated stream endpoints from `server.ts`
- make provider-less boot legal for auth/device-claim/local setup flows
- unify enrollment-token hashing across runtime and scripts
- make thread-title generation use the available provider set or skip quietly
- fix the Node REPL context-sync heuristic
- align service docs/specs with the real local/staging DB workflow

### Out of scope

- deep `TerminalSessionManager` decomposition
- deep `AgentService` decomposition
- route/gateway file splits beyond what is needed to remove the legacy runtime/bootstrap surfaces
- broader schema cleanup unless removal of the standalone runtime makes a small low-risk deletion obvious

## Proposed Work

### 1. Remove the standalone legacy run surface

Target surfaces to remove:

- `/api/runs`
- `/api/runs/:runId/stream`
- `RunManager` bootstrap and its route registration
- `RunEventBus` usage that exists only for the removed runtime

If a small helper or type is still directly reused by the thread-scoped terminal runtime, keep that helper only after moving it under a non-legacy ownership boundary.

### 2. Remove the remaining legacy terminal stream surface

Delete `/api/terminals/:budId/stream` instead of trying to preserve it. The thread-owned terminal stream already exists and matches the current ownership model.

### 3. Make provider/bootstrap behavior match the documented local workflow

Recommended changes:

- make zero-provider startup valid for auth/device-claim-only flows
- move provider availability checks to the point where agent or title-generation work is actually requested
- make thread-title generation resolve against the currently available provider set instead of assuming Anthropic availability

### 4. Unify enrollment-token hashing

Introduce one shared `hashEnrollmentToken(...)` helper and use it from:

- the websocket gateway
- the seed script
- any other enrollment-token utility path found during implementation

### 5. Fix the low-cost context and contract bugs

Phase 1 bug fixes should include:

- Node REPL detection ordering in context sync
- removal of the remaining unauthenticated or ownership-bypassing stream surfaces
- any directly adjacent tests needed to lock those fixes in

### 6. Align docs with the current DB workflow

Update the service-facing docs that currently drift from reality:

- `service/README.md`
- `service/drizzle/drizzle.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `AGENTS.md` if the repo-wide workflow note is corrected in this pass

The target documentation posture is:

- local development: `db:push`
- staging: `db:migrate`
- no production rollout guidance yet

## Expected File Areas

- `service/src/server.ts`
- `service/src/routes/runs.ts` or its removal
- `service/src/runtime/run-manager.ts` or its removal
- `service/src/runtime/event-bus.ts`
- `service/src/llm/index.ts`
- `service/src/agent/thread-title-service.ts`
- `service/src/ws/gateway.ts`
- `service/src/scripts/seed.ts`
- `service/src/terminal/context-sync-service.ts`
- `service/README.md`
- `service/drizzle/drizzle.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `AGENTS.md` if touched

## Testing Strategy

### Automated

- route-level coverage that the removed legacy stream paths are gone or not registered
- provider-optional startup coverage
- direct tests for the shared enrollment-token hash helper
- direct tests for thread-title provider fallback/skip behavior
- regression coverage for Node REPL detection

### Manual

- boot the service with no LLM keys and confirm auth/device-claim flows still start
- confirm the thread-scoped terminal and agent flow remain the primary browser-visible paths

## Exit Criteria

- the standalone legacy run surface is removed from normal service bootstrap
- the remaining browser-visible stream paths are ownership-aware
- provider-less boot works for non-agent flows
- seeded enrollment tokens and live gateway verification use the same hash algorithm
- the Node REPL heuristic is fixed and tested
- service/operator docs describe the real DB workflow accurately
