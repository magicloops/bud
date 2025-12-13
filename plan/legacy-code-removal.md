# Plan: Legacy Code Removal

## Context
- Links to: [AGENTS.md](../AGENTS.md), [bud.spec.md](../bud.spec.md)
- Related spec files:
  - [service/src/runtime/runtime.spec.md](../service/src/runtime/runtime.spec.md)
  - [service/src/ws/ws.spec.md](../service/src/ws/ws.spec.md)
  - [service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
  - [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
  - [web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)
  - [bud/src/src.spec.md](../bud/src/src.spec.md)

## Objective

Remove legacy code paths that were superseded by thread-scoped terminal sessions:

1. **Legacy PTY sessions** - Direct PTY sessions without tmux (replaced by tmux-backed terminal sessions)
2. **Legacy `shell.run` agent tool** - Single-command execution (replaced by `terminal.run`, `terminal.capture`, `terminal.interrupt`)
3. **Legacy UI components** - `run-view.tsx` (replaced by xterm.js terminal view)

## Background

The system previously had two session models:
- **Legacy PTY sessions**: Direct PTY access managed by `SessionManager`, used for interactive sessions before tmux integration
- **Thread-scoped terminal sessions**: tmux-backed sessions managed by `TerminalSessionManager`, with persistent state and better TUI support

The agent previously used:
- **`shell.run`**: Execute a single command and wait for completion, using marker-based protocol
- **`terminal.*` tools**: Interactive terminal control with readiness detection (current approach)

## Legacy Code Inventory

### 1. Web (`web/`)

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `src/components/workbench/run-view.tsx` | ~158 | Unused | Not imported anywhere, safe to delete |

### 2. Service (`service/`)

#### Runtime Layer

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `src/runtime/session-manager.ts` | ~659 | Legacy | Full PTY session lifecycle |
| `src/runtime/session-manager.test.ts` | ~? | Legacy | Tests for legacy manager |

#### WebSocket Layer

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `src/ws/term-gateway.ts` | ~135 | Legacy | Browser WebSocket for PTY sessions |

#### Routes Layer

| File | Endpoints | Status | Notes |
|------|-----------|--------|-------|
| `src/routes/sessions.ts` | `/api/sessions`, `/api/sessions/:id/close`, `/api/sessions/:id/take-writer` | Legacy | Full file can be removed |
| `src/routes/threads.ts` | `POST /api/threads/:threadId/session` | Legacy | Single endpoint to remove |

#### Agent Layer

| File | Section | Status | Notes |
|------|---------|--------|-------|
| `src/agent/agent-service.ts` | `executeCommandInSession()` method | Legacy | Lines 820-911: marker-based command execution |
| `src/agent/agent-service.ts` | `shell_run` function call extraction | Legacy | Lines 744-758 |
| `src/agent/agent-service.ts` | `shell.run` conversation building | Legacy | Lines 511-536 |
| `src/agent/agent-service.ts` | `sessionManager` constructor param | Legacy | Can be removed after cleanup |

#### Database Schema

| Table | Status | Notes |
|-------|--------|-------|
| `sessionTable` | Legacy | Keep for now (data migration consideration) |
| `sessionLogTable` | Legacy | Keep for now (data migration consideration) |

#### Server Wiring

| File | Section | Notes |
|------|---------|-------|
| `src/server.ts` | `SessionManager` instantiation | Remove after routes cleaned up |
| `src/server.ts` | `registerSessionRoutes()` call | Remove |
| `src/server.ts` | `registerTermGateway()` call | Remove |
| `src/server.ts` | SSE route `/api/sessions/:sessionId/stream` | Remove |

### 3. Rust Daemon (`bud/`)

| File | Section | Lines | Notes |
|------|---------|-------|-------|
| `src/main.rs` | `SessionManager` struct | 660-806 | Legacy PTY session manager |
| `src/main.rs` | `SessionHandle`, `SessionCommand`, `SessionConfig` types | ~620-660 | Supporting types |
| `src/main.rs` | `run_pty_session()` function | (find exact lines) | PTY execution |
| `src/main.rs` | `session_*` frame handling in `handle_server_frame()` | (find exact lines) | Frame routing |
| `src/main.rs` | `SessionOpenFrame`, `SessionInputFrame`, etc. protocol types | ~230-280 | Frame definitions |

## Removal Order

Recommended order to minimize breakage:

### Phase 1: Web Cleanup (Lowest Risk)

1. Delete `web/src/components/workbench/run-view.tsx`
2. Update `web/src/components/workbench/workbench.spec.md` to remove reference

### Phase 2: Service Routes & Gateway

1. Remove `src/routes/sessions.ts`
2. Remove `registerSessionRoutes()` call from `src/server.ts`
3. Remove `src/ws/term-gateway.ts`
4. Remove `registerTermGateway()` call from `src/server.ts`
5. Remove legacy SSE route `/api/sessions/:sessionId/stream` from `src/server.ts`
6. Remove `POST /api/threads/:threadId/session` endpoint from `src/routes/threads.ts`

### Phase 3: Service Runtime & Agent

1. Remove `src/runtime/session-manager.ts`
2. Remove `src/runtime/session-manager.test.ts`
3. Remove `SessionManager` import and instantiation from `src/server.ts`
4. Update `AgentService` constructor to remove `sessionManager` parameter
5. Remove `executeCommandInSession()` method from `agent-service.ts`
6. Remove `shell.run` handling from `extractFunctionCall()` in `agent-service.ts`
7. Remove `shell.run` handling from `buildConversation()` in `agent-service.ts`
8. Remove `shell.run` from `AgentDirective` type
9. Update `src/runtime/event-bus.ts` to remove `SessionEventBus` if unused

### Phase 4: Rust Daemon

1. Remove `SessionManager` struct and implementation
2. Remove `SessionHandle`, `SessionCommand`, `SessionConfig` types
3. Remove `run_pty_session()` function and related PTY handling
4. Remove `session_*` protocol types (`SessionOpenFrame`, `SessionInputFrame`, etc.)
5. Remove `session_*` frame handling from `handle_server_frame()`
6. Remove `#[allow(dead_code)]` markers on now-used fields

### Phase 5: Database & Protocol Docs

1. Create migration script to drop `session_table` and `session_log` tables
2. Update `docs/proto.md` to remove `session_*` frame documentation

## Spec Files to Update

After each phase, update the corresponding spec files:

| Spec File | Updates Needed |
|-----------|----------------|
| `web/src/components/workbench/workbench.spec.md` | Remove `run-view.tsx` section |
| `service/src/ws/ws.spec.md` | Remove `term-gateway.ts` section |
| `service/src/routes/routes.spec.md` | Remove `sessions.ts` section, update `threads.ts` section |
| `service/src/runtime/runtime.spec.md` | Remove `session-manager.ts` section |
| `service/src/agent/agent.spec.md` | Remove `shell.run` references |
| `service/src/db/db.spec.md` | Mark `sessionTable`/`sessionLogTable` as deprecated |
| `bud/src/src.spec.md` | Remove `SessionManager` section |

## Impacted Contracts

- [x] WSS protocol - Remove `session_*` frame types from `docs/proto.md`
- [x] SSE events - Remove session-related events
- [x] DB schema - Migration created to drop legacy tables
- [x] Agent tools - `shell.run` tool removal (not exposed to OpenAI currently)
- [x] Web UI - `run-view.tsx` removal (already unused)

## Test Plan

### Before Starting

1. Run full test suite: `pnpm test` in service/
2. Verify terminal sessions work end-to-end
3. Confirm no UI is using legacy session APIs (already verified - RunView not imported)

### After Each Phase

1. Run `pnpm build` in service/ and web/
2. Run `cargo build` in bud/
3. Run available tests
4. Manual smoke test of chat + terminal flow

### Integration Testing

1. Create new thread
2. Send message that triggers terminal use
3. Verify terminal output streams to UI
4. Verify agent can execute commands
5. Verify session persists across page reload

## Rollout

No migration needed - this is cleanup of unused code paths. The thread-scoped terminal sessions are already the active implementation.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Hidden usage of legacy APIs | Grep for imports/usages before removing |
| Historical conversation data references `shell.run` | Keep `buildConversation()` handling for historical messages, or migrate message records |
| Database foreign keys | Check for FK constraints before dropping tables |

## Decisions

1. **Historical messages**: Remove `shell.run` handling in `buildConversation()` - no production users yet, acceptable breakage
2. **Database tables**: Drop tables at the end with a migration script
3. **Protocol docs**: Update `docs/proto.md` as part of this work to keep it inline

---

*Created: 2025-12-12*
*Status: Completed*

## Completion Summary

All phases completed successfully:

1. **Phase 1**: Deleted `run-view.tsx`, updated workbench spec
2. **Phase 2**: Removed `sessions.ts`, `term-gateway.ts`, legacy session handling in `gateway.ts`
3. **Phase 3**: Removed `session-manager.ts`, `SessionEventBus`, `shell.run` from agent
4. **Phase 4**: Removed `SessionManager` and legacy PTY handling from Rust daemon
5. **Phase 5**: Created migration `0007_drop_legacy_sessions.sql`, updated `docs/proto.md`
6. **Specs Updated**: All 7 spec files updated to reflect changes

Migration to run: `service/drizzle/migrations/0007_drop_legacy_sessions.sql`
