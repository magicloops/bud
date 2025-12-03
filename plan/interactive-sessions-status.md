# Interactive Sessions Branch Status

_Last updated: 2025-12-03_

## Branch: `adam/interactive-sessions`

This document tracks the current implementation status, what's working, what's missing, and next steps for the interactive sessions feature.

---

## Executive Summary

The **Persistent Terminal** feature (Phases 1-5 from `plan/persistent-terminal.md`) is **fully implemented** and working correctly. All critical agent integration bugs have been fixed. The **PTY-based interactive sessions MVP is complete** and ready for use.

**Recent milestone**: Terminal resize sync implemented (2025-12-03), enabling Claude Code and other TUI applications to render correctly in the web terminal.

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 4.5** | Plumbing & Stubs | ✅ Complete |
| **Phase 4.6** | Native PTY Sessions (MVP) | ✅ Complete |
| **Phase 4.7** | Reliability & Perf | 🔄 In Progress (90%) |
| **Phase 4.8** | tmux Stubs & Capability UX | Not started |
| **Phase 5.0** | tmux Minimal Durable | Not started |
| **Phase 5.1** | tmux Multi-viewer & Backfill | Not started |
| **Phase 5.2** | Production Polish | Not started |
| **Phase 5.3** | Docs & Hardening | Not started |

---

## What's Working

### Terminal Infrastructure (Complete)
- **Bud (Rust)**: tmux session management, pipe-pane output capture, readiness detection
- **Backend (TypeScript)**: TerminalManager, SSE streaming, terminal REST endpoints, idle/linger timers
- **Web UI**: xterm.js terminal panel, SSE connection with heartbeat/reconnect, history restoration

### Terminal Features Verified Working
- [x] Terminal displays and accepts keyboard input
- [x] Commands execute in tmux and output appears in xterm
- [x] SSE streaming with heartbeat and automatic reconnection
- [x] Terminal history restoration on reconnect
- [x] Connection status indicator (green/yellow/red dot)
- [x] Readiness indicator (Ready/Waiting/Processing)
- [x] Truncation banner when scrolled to top
- [x] Ctrl+C interrupt via menu
- [x] Input batching with 20ms debounce
- [x] Dynamic xterm import to avoid initialization timing issues
- [x] **Terminal resize sync** - TUI apps render correctly (2025-12-03)

### Agent Integration (Complete)
- [x] Agent sends command via `terminal.run`
- [x] Agent observes output via `terminal.observe`
- [x] Agent sends interrupt via `terminal.interrupt`
- [x] Readiness detection triggers agent continuation
- [x] Byte offset tracking for accurate output capture
- [x] Agent message streaming via SSE

---

## Critical Issues Fixed (2025-12-03)

All five critical blocking issues have been resolved:

| Issue | Description | Fix |
|-------|-------------|-----|
| **Issue 1** | Agent messages not streaming | Wired web client to `/api/sessions/:sessionId/stream` |
| **Issue 2** | Terminal output shows stale/mixed data | Changed ordering from `seq` to `byte_offset` |
| **Issue 3** | Agent sees stale terminal output | Changed PK to `byte_offset`, added in-memory offset tracking |
| **Issue 4** | OpenAI returns YAML instead of JSON | Added `text: { format: { type: "json_object" } }` |
| **Issue 5** | Messages not showing after refresh | Changed query to `ORDER BY createdAt DESC` |
| **Issue 6** | TUI apps render incorrectly | Implemented terminal resize sync |

---

## Phase 4.7 Completion Status

From the spec (`plan/interactive-sessions.md` lines 550-563):

| Deliverable | Status |
|-------------|--------|
| Backpressure windows, adaptive chunking | ✅ Done |
| permessage-deflate | ✅ Done |
| Attach tokens (rotation) | ✅ Done |
| "Take writer" flow | ✅ Done |
| Observability: core metrics | ✅ Done (metrics endpoints exist) |
| Structured logs | ✅ Done |
| UI: xterm.js terminal | ✅ Done |
| UI: 60fps render throttle | ✅ Done |
| UI: ANSI-stripped "Copy as text" | ⚠️ Not implemented |
| Download/export UX | ⚠️ Not implemented |
| Richer metrics dashboards | ⚠️ Not implemented |
| SSE-driven session inventory | ⚠️ Not implemented |

**Remaining for Phase 4.7**: Copy/export functionality and enhanced metrics UI.

---

## Testing Status

All test implementations are documented in `plan/terminal-tests.md` but **not yet implemented**:

| Test Suite | Location | Status |
|------------|----------|--------|
| Backend unit tests | `service/src/runtime/__tests__/terminal-manager.test.ts` | ❌ Not started |
| Agent tool tests | `service/src/agent/__tests__/terminal-tools.test.ts` | ❌ Not started |
| Backend integration tests | `service/src/__tests__/integration/terminal.test.ts` | ❌ Not started |
| Bud readiness detector tests | `bud/src/terminal/readiness.rs` | ❌ Not started |
| Frontend component tests | `web/src/__tests__/terminal.test.tsx` | ❌ Not started |

---

## Files Modified Recently

### Terminal Resize Sync (2025-12-03)
- `service/src/runtime/terminal-manager.ts` - Added `sendResize()` method
- `service/src/routes/terminals.ts` - Added `POST /api/terminals/:budId/resize` endpoint
- `web/src/App.tsx` - Added resize sync after `fitAddon.fit()`

### Bug Fixes (2025-12-03)
- `service/src/agent/agent-service.ts` - Added JSON format requirement to OpenAI API
- `service/src/routes/threads.ts` - Fixed message ordering from ASC to DESC
- `service/src/runtime/terminal-manager.ts` - Byte offset tracking for output

---

## Recommended Next Steps

### Priority 1: Complete Phase 4.7 (Optional)
Implement remaining Phase 4.7 deliverables if needed:
- Add "Copy as text" button (ANSI-stripped)
- Add download/export for terminal transcripts

### Priority 2: Implement Tests
Follow `plan/terminal-tests.md` to add automated test coverage.

### Priority 3: tmux Durability (Future)
If session persistence across Bud restarts is needed, proceed with Phase 5.0.

---

## Architecture Notes

### Terminal Scoping
The current implementation is **Bud-scoped** (one terminal per Bud) rather than thread-scoped. This is acceptable for the PoC and simplifies the mental model.

### Data Flow
```
User types in xterm.js
    → fitAddon.fit() calculates cols/rows
    → POST /api/terminals/:budId/resize
    → WebSocket terminal_resize frame to Bud
    → tmux resize-window
    → SIGWINCH to foreground process
    → TUI re-renders correctly
```

### Key Components
- **Frontend**: `web/src/App.tsx` (xterm.js, SSE, resize sync)
- **Backend**: `service/src/runtime/terminal-manager.ts` (TerminalManager)
- **Backend**: `service/src/routes/terminals.ts` (REST endpoints)
- **Backend**: `service/src/ws/gateway.ts` (WebSocket to Bud)
- **Bud**: `bud/src/main.rs` (tmux management, resize handling)

---

## Related Documents

- `PROGRESS.md` - Overall phase completion status
- `plan/persistent-terminal.md` - Original implementation plan (Phases 1-5)
- `plan/interactive-sessions.md` - Full feature spec with tmux durability
- `plan/terminal-resize-sync.md` - Terminal resize sync spec ✅
- `plan/terminal-tests.md` - Test plan and coverage goals
- `plan/fix-agent-terminal-output-race.md` - Byte offset fix ✅
- `plan/fix-agent-message-streaming.md` - SSE streaming fix ✅
- `debug/` - Various debugging documentation
