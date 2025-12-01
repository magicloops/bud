# Bud PoC Progress — Persistent Terminal

_Last updated: 2025-11-30_

## What's implemented (recent)

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

## Next actions (Phase 4: Readiness + Robustness)
- ANSI stripping: strip ANSI escape codes from output sent to agent (keep raw for UI).
- Binary output guard: detect binary output and return placeholder instead of raw bytes.
- CRLF normalization: normalize line endings in output for consistent parsing.
- Idle/linger timers: implement terminal idle detection and cleanup.
- Metrics: track bytes in/out, readiness events, interrupts.

## Next actions (Phase 5: UI Polish)
- UI controls: add explicit input box + interrupt (Ctrl+C) button.
- Readiness display: show readiness indicator and last-line hint in terminal panel.
- Truncation hints: surface when output is truncated.
- Resize/focus: stabilize terminal resize and focus behavior.

## Cleanup & Docs
- Remove temporary terminal debug logs once reconnect behavior is fully validated.
- Docs: update proto/AGENTS/README for terminal proto (`id`/`ts`), tmux requirement, readiness payload.
- Tests: integration path for ensure→input→readiness→history; Bud detector samples for prompts/quiescence.
