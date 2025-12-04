# Bud PoC Progress — Persistent Terminal

_Last updated: 2025-12-04_

## What's implemented (recent)

### Agent & OpenAI Reliability Fixes (2025-12-04)
- **Session SSE heartbeat**: Added heartbeat to `/api/sessions/:sessionId/stream` to keep connection alive during long OpenAI calls. Without this, the frontend spinner would stop mid-execution because proxies/browsers closed the "stale" connection.
- **OpenAI request timeout**: Added 2-minute timeout to OpenAI client (configurable via `OPENAI_TIMEOUT_MS`). Previously, hanging requests would wait forever.
- **Reasoning effort fix**: Fixed inverted logic in `detectReasoningNoneSupport()` - models like `gpt-5.1-codex` now correctly fall back to "low" instead of unsupported "none".
- **Debug docs**: `debug/agent-progress-indicators.md`, `debug/openai-responses-hanging.md`

### Bud Shell & Input Fixes (2025-12-04)
- **Default shell**: Bud now respects `$SHELL` environment variable instead of hardcoding `/bin/bash`. Users get their preferred shell (zsh, fish, etc.).
- **Enter key handling**: tmux `send-keys` now sends actual Enter key instead of literal `\n`. Fixed by splitting input: text sent with `-l` (literal), then Enter sent separately. This fixes input submission in TUI apps like Claude Code.
- **Files**: `bud/src/main.rs` (default_shell, handle_input)

### Agent Terminal Context Awareness (2025-12-04)
- **Problem**: Agent didn't know when it was inside a REPL (Claude Code, python, node, etc.), causing it to send shell commands instead of REPL-appropriate input.
- **Solution**: Command stack tracking - when agent starts a known REPL program, we track it as "pending" and provide context to subsequent tool calls.
- **Implementation**:
  - Added `KNOWN_PROGRAMS` registry in `service/src/terminal/known-programs.ts` with 20+ programs (claude, python, node, psql, etc.)
  - Added `pendingCommands` tracking to TerminalManager
  - Tool results now include `context` field with mode (shell/repl), program name, and interaction hints
  - System prompt updated with REPL-specific guidance (e.g., "use natural language with Claude Code")
  - Context clears on shell return (high-confidence shell prompt) or interrupt
- **Design:** `design/agent-terminal-context-awareness.md`
- **Plan:** `plan/agent-command-stack-tracking.md`

### Terminal Resize Sync (2025-12-03)
- **Fixed TUI rendering**: Claude Code and other terminal UI applications now render correctly in the web terminal.
- **Root cause**: Terminal dimensions weren't synchronized between xterm.js (80-120 cols) and tmux (default 200x50).
- **Implementation**:
  - Added `TerminalManager.sendResize(budId, cols, rows)` to forward resize frames to Bud
  - Added `POST /api/terminals/:budId/resize` REST endpoint
  - Frontend now sends resize after every `fitAddon.fit()` (on init, window resize, panel toggle)
  - Bud runs `tmux resize-window` which sends SIGWINCH to foreground process
- **Plan:** `plan/terminal-resize-sync.md`

### Message Display & OpenAI Response Fix (2025-12-03)
- **Fixed message fetch ordering**: Changed `/api/threads/:threadId/messages` to order by `createdAt DESC` instead of `ASC`. With `ASC` + `LIMIT 200`, the query returned the oldest 200 messages, cutting off the newest ones when thread exceeded 200 messages.
- **Fixed OpenAI response format**: Added `text: { format: { type: "json_object" } }` to OpenAI Responses API call to force JSON output instead of YAML.
- **Debug script**: `service/scripts/query-messages.ts` for analyzing message storage.

### Terminal Output Storage Fix (2025-12-03)
- **Fixed `seq` collision bug**: Changed `terminal_output` primary key from `(bud_id, seq)` to `(bud_id, byte_offset)`. The `seq` counter resets to 0 when Bud reconnects, causing `onConflictDoNothing` to silently drop ALL new data. `byte_offset` is monotonically increasing (file position) and never collides.
- **Fixed output ordering**: Changed `tailOutput()` to order by `byte_offset DESC` instead of `seq DESC`. After reconnection, `seq` doesn't correlate with chronological order, but `byte_offset` always does.
- **Added byte offset tracking**: Agent now captures `getLastOffset()` before sending input and requests `tailOutput({ sinceOffset })` after readiness to get only new output.
- **Migration**: `0005_terminal_output_pk_byte_offset.sql` changes the PK constraint.
- **Debug script**: `service/scripts/query-terminal-output.ts` for analyzing terminal output storage.

### UI Fixes & View Toggle Restoration (2025-12-02)
- **View toggle restored**: Re-added Terminal/Web view toggle to `WorkspaceTopBar` that was removed during refactor. Terminal pane stays mounted (preserving xterm instance) while web view placeholder overlays on top.
- **Removed redundant command input bar**: Users type directly in xterm terminal.
- **Fixed terminal overflow**: Added `min-h-0 overflow-hidden` to flex containers.
- **Improved button UX**: Moved Ctrl+C behind menu (only enabled when terminal not ready), Stop Agent button only shows during streaming/dispatching with spinner.
- **Fixed truncation banner**: Only shows when scrolled to top of terminal.
- **Fixed xterm initialization error**: Changed to dynamic import + wait for container dimensions before `term.open()`.
- **Added input batching**: 20ms debounce to reduce HTTP overhead for terminal input.

### Agent-Terminal Bug Fix (2025-12-02)
- **Fixed budId lookup**: Corrected Drizzle query syntax in `fetchBudForThread()` from `columns: { budId: threadTable.budId }` to `columns: { budId: true }`. This was causing the agent to look up an undefined budId.
- **Added diagnostic logging**: `getActiveBudIds()` exported from gateway, logged when frame send fails.

### Phase 5: UI Alignment (2025-11-30)
- **Interrupt button**: Added "Ctrl+C" button that sends interrupt signal to terminal via `/api/terminals/:budId/interrupt`.
- **Explicit input box**: Added command input bar with $ prompt, text input, and Send button for typing commands.
- **Readiness display**: Status bar shows readiness indicator (Ready/Waiting/Processing) with hint icons (🔐 password, ❓ confirmation, 📄 pager, ⚠️ error).
- **Truncation hints**: Yellow warning banner when output is truncated, dismissible with X button.

### Phase 4: Readiness + Robustness (2025-11-30)
- **ANSI stripping**: Added `stripAnsi()` method in agent-service to remove escape codes from agent output (UI still receives raw ANSI via SSE).
- **CRLF normalization**: Added `normalizeCRLF()` method to normalize line endings to LF for consistent parsing.
- **Idle/linger timers**: Added configurable idle management:
  - `terminalIdleTimeoutMinutes` (default: 30) - marks terminals idle after no activity
  - `terminalIdleCleanupHours` (default: 24) - closes terminals after extended idle
  - Periodic check job starts on server startup, stops on shutdown
- **Metrics endpoints**: Added REST endpoints for terminal metrics:
  - `GET /api/terminals/:budId/metrics` - per-terminal metrics (bytes, uptime, idle time)
  - `GET /api/terminals/metrics` - aggregate metrics across all terminals

### Phase 1-3 Review & Agent Fixes (2025-11-30)
- **Phase review completed**: Created detailed review docs in `review/` for Phases 1-3 against design doc expectations.
- **Agent readiness fallbacks**: Added `DEFAULT_READINESS_HINTS` constant and `normalizeReadiness()` helper to ensure all readiness objects have proper hints, even when Bud doesn't respond.
- **Enhanced system prompt**: Added detailed guidance on confidence thresholds (≥0.8 ready, 0.5-0.8 probably ready, <0.5 should observe) and hints usage (looks_like_prompt, looks_like_confirmation, etc.).
- **Agent decision logging**: Added `logReadinessDecision()` that logs tool, confidence, trigger, decision classification, and active hints for debugging.
- **output_bytes in tool results**: Added `outputBytes` field to `TerminalCallResult`, SSE events, and recorded messages per design doc spec.

### Terminal Reconnection & Connection Status UI (2025-11-30)
- **Bud pipe-pane fix**: Fixed issue where tmux output watcher stopped working after service restart. Now properly stops existing pipe and starts fresh on reconnect (removed `-o` flag that skipped re-establishment).
- **SSE heartbeat mechanism**: Service sends periodic heartbeat events (1s in dev, 5s in prod) to detect stale connections through Vite proxy.
- **Frontend connection state tracking**: Added `terminalConnection` state (`connected`/`reconnecting`/`disconnected`) with ref for use in callbacks.
- **Connection status UI**: Status bar shows colored dot (green/yellow-pulsing/red) and connection label; terminal dims with "Reconnecting..." overlay after 2s of disconnect.
- **Input blocking during disconnect**: Terminal input is blocked when not connected, preventing lost keystrokes.
- **Automatic reconnection**: Frontend detects stale SSE via heartbeat timeout (3s dev, 15s prod) or failed POST requests (503), polls for service availability, and triggers SSE reconnect.
- **History restoration on reconnect**: After SSE reconnects, fetches terminal history to restore previous output (prevents blank terminal).
- **Session list panel state persistence**: Moved `threadPanelOpen` state to localStorage for persistence across page refreshes.

### Earlier work
- Terminal data model: new `bud_terminal`, `terminal_output`, `terminal_input_log` tables + migration; terminal config flags (`TERMINAL_ENABLED`, caps) added to service.
- Backend terminal scaffolding: TerminalManager skeleton dispatches `terminal_ensure/input`, persists output with soft caps, emits terminal SSE events; WS gateway accepts `terminal_status/output/ready`.
- Envelope unified: terminal_* frames now use `id`/`ts`/`ext` across backend and Bud; gateway parses terminal proto envelope.
- Bud tmux skeleton: CLI flags to enable terminal + session/log settings; tmux probe surfaces capabilities in `hello`; can ensure/adopt tmux session, pipe-pane log, stream `terminal_output`, handle input/resize/interrupt/close, and send `terminal_status`; readiness detector emits `terminal_ready`.
- Readiness: Bud emits `terminal_ready` with prompt/quiescence-based assessment; backend stores latest readiness and forwards on SSE; agent terminal tools wait for readiness.
- Agent: terminal tools `terminal.run/observe/interrupt` wired to TerminalManager; terminal input uses readiness, tail backfill; terminal REST endpoints for ensure/status/history/input/interrupt added.
- Web UI: simplified terminal panel streams `/api/terminals/:budId/stream`, backfills history, sends input via REST; legacy session UI removed; tmux terminal now visible end-to-end.
- Repo is `cargo check` clean; earlier Rust warnings addressed (only benign reminders remain).

## Phase Status

| Phase | Status |
|-------|--------|
| Phase 1: Bud tmux foundation | ✅ Complete |
| Phase 2: Backend terminal manager | ✅ Complete |
| Phase 3: Agent tool refactor | ✅ Complete |
| Phase 4: Readiness + Robustness | ✅ Complete |
| Phase 5: UI alignment | ✅ Complete |

## Known Issues (2025-12-02)

Three critical issues identified during agent testing:

### Issue 1: Agent Messages Not Streaming — ✅ FIXED
- Agent messages don't appear in UI until page refresh
- Web client never opens SSE for agent messages
- Agent emits to `sessionId` but no listener exists
- **Fix:** Wired up web client to connect to `/api/sessions/:sessionId/stream` after POST
- **Plan:** `plan/fix-agent-message-streaming.md`

### Issue 2: Terminal Output Shows Stale/Mixed Data — ✅ FIXED
- `tailOutput()` has no cursor tracking - always returns last N rows
- No way to request "output since sequence X"
- Old session data appears mixed with new commands
- **Fix:** Changed ordering from `seq` to `byte_offset`, added `sinceOffset` parameter
- **Plan:** `plan/fix-agent-terminal-output-race.md`

### Issue 3: Agent Sees Stale Terminal Output — ✅ FIXED
- Race condition: readiness signal fires BEFORE output stored in DB
- Agent reads from DB immediately after readiness, but output hasn't been persisted yet
- Agent responds based on incomplete/stale data
- **Fix:** Changed PK from `(bud_id, seq)` to `(bud_id, byte_offset)`, added in-memory offset tracking
- **Verified:** Diagnostic logs show agent receiving correct output (see `offsetDelta: 1132`, `decodedPreview` matches command output)
- **Plan:** `plan/fix-agent-terminal-output-race.md`

### Issue 4: OpenAI Returns YAML Instead of JSON — ✅ FIXED
- OpenAI (gpt-5-2025-08-07) returned YAML format despite system prompt requesting JSON
- **Fix:** Added `text: { format: { type: "json_object" } }` to OpenAI Responses API call
- **Debug:** `debug/openai-response-format.md`

### Issue 5: Messages Not Showing After Page Refresh — ✅ FIXED
- Newest messages not appearing in UI even after page refresh
- **Root cause:** Message query used `ORDER BY createdAt ASC` with `LIMIT 200`, returning oldest 200 instead of newest
- **Fix:** Changed to `ORDER BY createdAt DESC` in `service/src/routes/threads.ts`
- **Debug:** `debug/missing-messages-in-ui.md`

## Debug Documentation (2025-12-03)
- `debug/agent-terminal-bud-offline.md` - Investigation of "bud_offline" error (fixed)
- `debug/agent-terminal-communication-issues.md` - Comprehensive analysis of agent-terminal issues
- `debug/xterm-dimensions-error.md` - xterm initialization timing fix
- `debug/terminal-output-ordering.md` - Investigation of terminal output storage bug (fixed)
- `debug/agent-stale-output-and-json-parsing.md` - Investigation of Issue 3 + OpenAI JSON parsing
- `debug/openai-response-format.md` - OpenAI returning YAML instead of JSON for final messages (fixed)
- `debug/missing-messages-in-ui.md` - Messages not showing after page refresh (fixed)

## Planning Documents
- `plan/interactive-sessions-status.md` - Current branch status and what's working/missing
- `plan/fix-agent-terminal-output-race.md` - Plan to fix Issues 2 & 3 (byte offset approach) ✅
- `plan/fix-agent-message-streaming.md` - Plan to fix Issue 1 (restore SSE streaming) ✅
- `plan/terminal-resize-sync.md` - Plan for terminal resize synchronization ✅
- `plan/terminal-tests.md` - Test plan for terminal features

## Remaining TODOs

### Critical (Blocking Agent Use)
- [x] Fix agent terminal output UI ordering (Issue 2) - see `plan/fix-agent-terminal-output-race.md`
- [x] Fix agent seeing stale output (Issue 3) - see `plan/fix-agent-terminal-output-race.md`
- [x] Fix agent message streaming (Issue 1) - see `plan/fix-agent-message-streaming.md`
- [x] Fix OpenAI YAML response format (Issue 4) - see `debug/openai-response-format.md`
- [x] Fix messages not showing after refresh (Issue 5) - see `debug/missing-messages-in-ui.md`

### Testing
- [ ] Implement Bud unit tests for readiness detector
- [ ] Add backend integration tests with mock Bud WebSocket
- [ ] Add frontend tests with mocked EventSource
- [ ] Set up E2E tests with real tmux in CI

### Future
- [ ] Terminal history pagination with S3 storage
- [x] Terminal resize handling - see `plan/terminal-resize-sync.md`
- [ ] Multi-terminal support
