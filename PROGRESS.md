# Bud PoC Progress — Persistent Terminal

_Last updated: 2025-11-27_

## What’s implemented (recent)
- Terminal data model: new `bud_terminal`, `terminal_output`, `terminal_input_log` tables + migration; terminal config flags (`TERMINAL_ENABLED`, caps) added to service.
- Backend terminal scaffolding: TerminalManager skeleton dispatches `terminal_ensure/input`, persists output with soft caps, emits terminal SSE events; WS gateway accepts `terminal_status/output/ready`.
- Bud tmux skeleton: CLI flags to enable terminal + session/log settings; tmux probe surfaces capabilities in `hello`; can ensure/adopt tmux session, pipe-pane log, stream `terminal_output`, handle input/resize/interrupt/close, and send `terminal_status`.
- Readiness: Bud emits `terminal_ready` with prompt/quiescence-based assessment; backend stores latest readiness and forwards on SSE; agent terminal tools wait for readiness.
- Agent: terminal tools `terminal.run/observe/interrupt` wired to TerminalManager; terminal input uses readiness, tail backfill; terminal REST endpoints for ensure/status/history/input/interrupt added.
- Web UI: simplified terminal panel streams `/api/terminals/:budId/stream`, backfills history, sends input via REST; legacy session UI removed.
- Repo is `cargo check` clean; earlier Rust warnings addressed (only benign reminders remain).

## Next actions
- Agent robustness: add ANSI/binary guards and use readiness confidence to decide when to observe vs. send; trim legacy shell path.
- UI polish: show readiness/last-line hints, add explicit input box + interrupt control, surface truncation states.
- Docs: update proto/AGENTS.md for terminal_ready payload, new endpoints/flags, tmux requirement.
- Tests: integration path for ensure→input→readiness→history; Bud detector samples for prompts/quiescence.
- Optional cleanups: silence remaining benign warnings (`exit_status`, unused helper) and trim unused fields once legacy shell path is dropped.
