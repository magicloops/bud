# Phase 4: Ownership Stamping And Authorization Enforcement

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Move Bud from authenticated-but-global to authenticated-and-user-scoped.

By the end of this phase:

- Bud-owned resources are stamped with owner data
- reads are filtered through authorization helpers
- writes are rejected when the acting user does not own the resource
- SSE attaches only for authorized users
- terminal input audit logs capture acting user ids

This is the phase that actually makes "each user can only see their own data" true.

---

## Scope

### In Scope

- ownership stamping for new rows
- route-level authorization helpers
- filtering in list/read endpoints
- SSE attach authorization
- service-layer propagation of acting user id
- reusing Bud owner from claim/approval data

### Out Of Scope

- future shared-Bud ACL model
- organizations/teams
- per-resource collaborative access

---

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/src/routes/buds.ts`
- `service/src/routes/threads.ts`
- `service/src/routes/runs.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/run-manager.ts`
- `service/src/agent/agent-service.ts`
- `service/src/terminal/context-sync-service.ts` if message stamping needs adjustment
- `service/src/auth/session.ts` or equivalent authz helper module

### Documentation / Specs

- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md`
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Resolve historical prototype data before enforcement

Choose one path before relying on ownership filters:

- production path: wipe prototype data before enforcement ships
- local-development path: use [phase-3.5-local-dev-data-backfill.md](./phase-3.5-local-dev-data-backfill.md) to assign the preserved prototype data to a known user

Do not leave historical rows ambiguously owned if route filtering is about to depend on ownership.

### Task 2: Stamp ownership on all new rows

Rows to stamp:

- `bud.created_by_user_id`
- `thread.created_by_user_id`
- `message.created_by_user_id`
- `run.created_by_user_id`
- `run.canceled_by_user_id`
- `terminal_session.created_by_user_id`
- `terminal_session_input_log.user_id`

### Task 3: Centralize authorization lookups

Recommended helpers:

- `getAuthorizedBud(viewer, budId)`
- `getAuthorizedThread(viewer, threadId)`
- `getAuthorizedSessionForThread(viewer, threadId)`

These helpers should become the standard way browser-facing routes resolve resources.

### Task 4: Filter list endpoints

At minimum:

- `GET /api/buds`
- `GET /api/threads`
- any Bud/session inventory endpoints

These must stop returning global data.

### Task 5: Authorize read/write endpoints

At minimum:

- thread reads
- message reads and writes
- run creation/history
- terminal create/ensure/input/interrupt/resize/history
- thread deletion
- Bud session listing/closing

### Task 6: Authorize SSE endpoints before attach

Ensure:

- thread agent stream
- thread terminal stream
- any remaining session/bud SSE paths

do not attach buffers or listeners until ownership is confirmed.

### Task 7: Propagate acting user through service internals

Thread the acting user id through:

- thread/message creation flows
- `AgentService.startUserMessage(...)`
- `RunManager.createRun(...)`
- `TerminalSessionManager.createSessionForThread(...)`
- `terminalSessionManager.sendInput(...)` calls for human input

### Task 8: Ensure Bud owner comes from claim approval

When Bud is created or reclaimed through the claim flow:

- `bud.created_by_user_id` must resolve from the approving user

This is the root of downstream ownership for threads and terminal sessions.

---

## Resolved Defaults For This Phase

1. Unauthorized resource-scoped access returns `404`; `401` is reserved for unauthenticated requests.
2. Assistant/tool/system messages inherit the thread owner.
3. `tenant_id` remains nullable and unused in this tranche.

---

## Validation Checklist

- [ ] `GET /api/buds` returns only owned Buds
- [ ] `GET /api/threads` returns only owned threads
- [ ] one user gets `404` when trying to access another user’s thread by id
- [ ] one user cannot attach to another user’s SSE stream
- [ ] new threads/runs/messages/sessions are stamped with owner info
- [ ] terminal input logs include acting `user_id`
- [ ] reclaiming a Bud preserves ownership correctly

---

## Spec Updates Required

- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/runtime/runtime.spec.md`
- [ ] `service/src/agent/agent.spec.md`
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when a second signed-in user can no longer see or mutate the first user’s Bud-owned resources, even if they know raw ids or URLs.

---

*Last Updated: 2026-03-13*
