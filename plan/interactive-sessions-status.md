# Interactive Sessions Branch Status

_Last updated: 2025-12-02_

## Branch: `adam/interactive-sessions`

This document tracks the current implementation status, what's working, what's missing, and next steps for the interactive sessions feature.

---

## Executive Summary

The **Persistent Terminal** feature (Phases 1-5 from `plan/persistent-terminal.md`) is **fully implemented** and the terminal works correctly for direct user interaction. However, the **agent integration flows** have not been manually tested end-to-end, and there are **UI regressions** from the sample UI design that need to be addressed.

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

---

## What's Missing / Not Working

### 1. View Toggle (Terminal vs Web) - FIXED

**Status**: Resolved (2025-12-02)

The view toggle has been restored to `WorkspaceTopBar`:
- Added `viewMode` state to `App.tsx`
- Restored `ViewToggleButton` component with Terminal/Web view buttons
- Added conditional rendering: terminal pane vs web preview placeholder

### 2. Agent Tool Flows (Not Tested)

The agent terminal tools (`terminal.run`, `terminal.observe`, `terminal.interrupt`) are implemented but have **not been manually tested end-to-end**. Specifically:

| Flow | Status |
|------|--------|
| Agent sends command via `terminal.run` | ⚠️ Not tested |
| Agent observes output via `terminal.observe` | ⚠️ Not tested |
| Agent sends interrupt via `terminal.interrupt` | ⚠️ Not tested |
| Readiness detection triggers agent continuation | ⚠️ Not tested |
| Agent handles password prompts | ⚠️ Not tested |
| Agent handles confirmation prompts | ⚠️ Not tested |
| User takes control while agent is running | ⚠️ Not tested |

**Testing needed**:
1. Start a chat session with a Bud
2. Ask the agent to run a command (e.g., "List the files in the current directory")
3. Verify:
   - Agent uses `terminal.run` tool
   - Command appears in terminal
   - Output is captured and sent back to agent
   - Readiness detection works
   - Agent responds with summary

### 3. Thread-Session Linkage

**Per `plan/unified-session-terminal.md`**: Threads should auto-create a session on first load and reuse it across reconnects. Current status:

| Feature | Status |
|---------|--------|
| `thread.current_session_id` column | ❓ Not verified |
| Auto-create terminal on thread load | ⚠️ Implemented via `/api/terminals/:budId/ensure` but ties to Bud, not thread |
| Session reuse across reconnects | ⚠️ Works for Bud, but thread association unclear |

**Note**: The current implementation appears to be **Bud-scoped** (one terminal per Bud) rather than **Thread-scoped** (one terminal per thread) as specified in the unified session design. This may be intentional for PoC simplification.

### 4. Legacy Run UI Removal

**Per unified design**: "Remove the 'start session' button and legacy run history panel."

**Current status**:
- `run-view.tsx` still exists with `ShellEntry` types and "Load older commands" pagination
- `App.tsx` no longer uses `RunView` component (imports `run-view.tsx` but doesn't render it)
- This is **intentional** - the legacy component exists but is unused; terminal pane replaced it

---

## Automated Tests Status

All test implementations are documented in `plan/terminal-tests.md` but **not yet implemented**:

| Test Suite | Location | Status |
|------------|----------|--------|
| Backend unit tests | `service/src/runtime/__tests__/terminal-manager.test.ts` | ❌ Not started |
| Agent tool tests | `service/src/agent/__tests__/terminal-tools.test.ts` | ❌ Not started |
| Backend integration tests | `service/src/__tests__/integration/terminal.test.ts` | ❌ Not started |
| Bud readiness detector tests | `bud/src/terminal/readiness.rs` | ❌ Not started |
| Frontend component tests | `web/src/__tests__/terminal.test.tsx` | ❌ Not started |

---

## Recent Fixes (This Session)

1. **Removed redundant command input bar** - Users type directly in xterm
2. **Fixed terminal overflow** - Added `min-h-0 overflow-hidden` to flex containers
3. **Improved button UX** - Ctrl+C behind menu, Stop Agent only during streaming
4. **Fixed truncation banner** - Only shows when scrolled to top
5. **Fixed xterm initialization error** - Dynamic import + wait for container dimensions
6. **Added input batching** - 20ms debounce to reduce HTTP overhead

---

## Files Modified in This Branch

### Core Implementation
- `service/src/runtime/terminal-manager.ts` - TerminalManager with SSE streaming
- `service/src/ws/gateway.ts` - WebSocket gateway with terminal frame handling
- `web/src/App.tsx` - Main UI with xterm terminal integration
- `bud/src/terminal/` - Rust terminal module (readiness detection, tmux management)

### Documentation
- `PROGRESS.md` - Phase completion status
- `plan/terminal-tests.md` - Test plan
- `plan/interactive-sessions.md` - Feature spec
- `plan/unified-session-terminal.md` - UI consolidation design
- `docs/proto.md` - Protocol spec updated with terminal frames
- `AGENTS.md` - Agent tools documentation
- `debug/xterm-dimensions-error.md` - xterm initialization debugging
- `design/terminal-input-latency.md` - Input latency solutions

---

## Recommended Next Steps

### Priority 1: Manual Agent Testing
Before any other work, manually test the agent flows to verify the integration works:

```
1. Start dev servers (service + web)
2. Open web UI, select a Bud
3. Send a message: "List the files in the current directory"
4. Observe:
   - Does the agent call terminal.run?
   - Does the command appear in the terminal?
   - Does the output return to the agent?
   - Does readiness detection trigger correctly?
   - Does the agent summarize the output?
```

### Priority 2: Add View Toggle Back
Restore the terminal/web view toggle in `WorkspaceTopBar`:

1. Add `view` state to `App.tsx`: `'terminal' | 'web'`
2. Pass to `WorkspaceTopBar` with toggle callback
3. Conditionally render terminal pane or web preview placeholder
4. Wire up to `RunView` component if needed

### Priority 3: Clarify Thread vs Bud Scoping
Document or implement the decision on terminal scoping:

- **Option A (Current)**: Bud-scoped terminals (one terminal per Bud, shared across threads)
- **Option B (Design)**: Thread-scoped terminals (one terminal per thread)

For PoC, Option A may be acceptable. Document this in `PROGRESS.md`.

### Priority 4: Implement Tests
Follow `plan/terminal-tests.md` to add automated test coverage.

---

## Open Questions

1. **Thread vs Bud scoping**: Is one terminal per Bud acceptable for PoC, or do we need thread-scoped terminals?

2. **Agent tool result format**: Is the current tool result format (with `outputBytes`, truncation notices) correct?

3. **Readiness thresholds**: Are the current confidence thresholds (≥0.8 ready, 0.5-0.8 probably ready, <0.5 observe) appropriate?

4. **View toggle priority**: Is the terminal/web toggle needed for PoC, or can it wait?

---

## Related Documents

- `PROGRESS.md` - Overall phase completion status
- `plan/persistent-terminal.md` - Original implementation plan (Phases 1-5)
- `plan/unified-session-terminal.md` - UI consolidation design
- `plan/interactive-sessions.md` - Full feature spec with tmux durability
- `plan/terminal-tests.md` - Test plan and coverage goals
- `debug/xterm-dimensions-error.md` - xterm initialization fix documentation
- `design/terminal-input-latency.md` - Input latency analysis
