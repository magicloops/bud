# Plan: Persistent Terminal Implementation

## Context
- Design doc: `plan/persistent-terminal.md` (v0.2, Nov 2025).
- Current state: unified thread session (non-tmux) with agent tool wrapping commands in sentinels; output garbling observed.
- Related notes: `debug/terminal-garbling.md` for current PTY issues.

## Objective
- Deliver a tmux-backed, persistent terminal per Bud that the agent treats as “the terminal”, with tools `terminal.run`, `terminal.observe`, `terminal.interrupt`, readiness detection, and durable output/history. Replace sentinel-wrapped shell scripts with raw input streams suitable for REPLs/CLIs.

## Design / Approach
- **Phased rollout** (see below) to layer tmux + terminal manager + agent tool refactor + readiness + UI.
- Keep thread-level UX but move the underlying path to a Bud-scoped tmux terminal, with backend mediation (no session IDs exposed to the agent).
- Introduce readiness detection (prompt patterns + quiescence) and output backfill/history to support reconnect and REPL-friendly workflows.

## Impacted contracts
- [x] WSS protocol (Bud⇄Backend: terminal_* frames)
- [x] SSE events (terminal output/status streams)
- [x] DB schema (bud_terminal, terminal_output/input logs)
- [x] Agent adapter/tool registry (new tools, semantics)
- [ ] Web UI surfaces (terminal panel + states)

## Status (2025-11-30)
- **Phase 1 (Bud tmux foundation)**: ✅ COMPLETE - tmux-backed terminal runs with caps advertised; can ensure/adopt tmux, pipe-pane log, stream `terminal_output`, handle input/resize/interrupt/close, and send `terminal_status`; readiness detector emits `terminal_ready`. Envelope uses `id`/`ts` for terminal_* frames. Pipe-pane properly re-establishes on reconnect.
- **Phase 2 (Backend terminal manager)**: ✅ COMPLETE - terminal tables/migration added; TerminalManager dispatches all terminal_* messages, stores output with soft caps, emits terminal SSE; REST endpoints for ensure/status/history/input/interrupt; gateway parses terminal_* frames. SSE heartbeat mechanism (1s dev, 5s prod) detects stale connections.
- **Phase 3 (Agent tool refactor)**: ✅ COMPLETE - terminal.run/observe/interrupt tools wired to TerminalManager; system prompt enhanced with confidence thresholds and hints guidance; `normalizeReadiness()` ensures proper fallbacks with hints; `logReadinessDecision()` logs decisions for debugging; `outputBytes` added to results per design doc.
- **Phase 4 (Readiness + robustness)**: 🔄 IN PROGRESS - Readiness detection works (Bud-side); remaining: ANSI stripping for agent, binary guards, CRLF normalization, idle timers, metrics.
- **Phase 5 (UI alignment)**: 🔄 PARTIAL - Terminal panel streams SSE, backfills history, sends input via REST; connection status UI with reconnect overlay; remaining: explicit input box, interrupt control, readiness display, truncation hints.

## Immediate next steps (Phase 4)
- ANSI stripping: strip escape codes from agent output (keep raw for UI xterm.js).
- Binary output guard: detect and replace binary output with placeholder.
- CRLF normalization: normalize line endings for consistent readiness parsing.
- Idle/linger timers: track terminal activity, implement cleanup.
- Metrics: bytes in/out, readiness events, interrupt counts.

## Immediate next steps (Phase 5)
- UI controls: explicit input box + interrupt (Ctrl+C) button.
- Readiness display: show indicator and last-line hint.
- Truncation hints: surface when output exceeds cap.
- Resize/focus: stabilize behavior.

## Documentation & Cleanup
- Document terminal proto (`id`/`ts`), tmux requirement, readiness payloads in docs/AGENTS/README.
- Remove temporary terminal debug logs once reconnect is fully validated.
- Review docs in `review/` folder for phase completion criteria.

## Phases

1) **Bud tmux foundation**
   - Add tmux-backed terminal manager in Bud: create/detect tmux session, pipe-pane to log file, send-keys for input, Ctrl+C helper, attach output watcher with seq offsets.
   - Wire new WSS frames: `terminal_status`, `terminal_output`, `terminal_ready` (stub), `terminal_close`; update hello to advertise terminal state.
   - Feature flag to keep legacy session path during development.

2) **Backend terminal manager + data model**
   - Add tables `bud_terminal`, `terminal_output` (+ optional `terminal_input_log`) with soft caps; ensure per-Bud terminal auto-ensure on connect and recover after restart.
   - Terminal manager: track output buffers, stream to SSE, expose REST/SSE endpoints (terminal ensure/status/history).
   - Gateway: forward terminal_* frames, enforce one terminal per Bud, map seq/offsets.

3) **Agent tool refactor**
   - Replace sentinel-wrapped `shell.run` with `terminal.run` (raw input, newline-required), `terminal.observe`, `terminal.interrupt`; update system prompt and tool registry.
   - Wire readiness response handling (confidence-driven loop), drop assumptions about per-command exit codes; maintain compatibility switch until stable.

4) **Readiness detection + robustness**
   - Implement prompt-pattern config + quiescence detector; surface `terminal_ready` assessments to agent/UI.
   - Improve output handling: CRLF normalization, ANSI stripping for agent, binary guardrails; tail/backfill on attach.
   - Idle/linger timers and metrics (bytes in/out, readiness events, interrupts).

5) **UI alignment + cleanup**
   - Terminal panel consumes terminal SSE/REST instead of run/session SSE; show terminal state, readiness hints, interrupts, and output backfill.
   - Remove legacy run-terminal UI and sentinel-specific assumptions; document controls (Send/Observe/Interrupt).
   - Deprecate old session tool path once terminal flow is stable; migrate existing threads to Bud-level terminal mapping if needed.

## Test plan
- Unit: tmux manager (create/detect/send-keys/pipe-pane), readiness detector (prompt patterns/quiescence).
- Integration: ensure terminal -> send input -> observe output -> interrupt; restart Bud/backend with terminal persistence; large-output truncation and backfill; binary output guard.
- Manual: REPL flows (python/node), long-running installs with observe, interrupt handling, reconnect with backfilled output.

## Rollout
- Guard with feature flag/env (`TERMINAL_ENABLED`) and staged agent tool choice.
- Migrations: add terminal tables; keep legacy tables untouched.
- Docs: update `AGENTS.md`, `plan/persistent-terminal.md` cross-link, backend/Bud README; describe new endpoints and tools.

## Out of scope
- Multiple terminals per Bud, GUI apps, Windows support, advanced sharing/rosters, long-term output retention policies beyond capped history/optional offload.
