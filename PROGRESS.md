# Bud PoC Progress — Persistent Terminal

_Last updated: 2025-11-30_

## What’s implemented (recent)
- Terminal data model: new `bud_terminal`, `terminal_output`, `terminal_input_log` tables + migration; terminal config flags (`TERMINAL_ENABLED`, caps) added to service.
- Backend terminal scaffolding: TerminalManager skeleton dispatches `terminal_ensure/input`, persists output with soft caps, emits terminal SSE events; WS gateway accepts `terminal_status/output/ready`.
- Envelope unified: terminal_* frames now use `id`/`ts`/`ext` across backend and Bud; gateway parses terminal proto envelope.
- Bud tmux skeleton: CLI flags to enable terminal + session/log settings; tmux probe surfaces capabilities in `hello`; can ensure/adopt tmux session, pipe-pane log, stream `terminal_output`, handle input/resize/interrupt/close, and send `terminal_status`; readiness detector emits `terminal_ready`.
- Readiness: Bud emits `terminal_ready` with prompt/quiescence-based assessment; backend stores latest readiness and forwards on SSE; agent terminal tools wait for readiness.
- Agent: terminal tools `terminal.run/observe/interrupt` wired to TerminalManager; terminal input uses readiness, tail backfill; terminal REST endpoints for ensure/status/history/input/interrupt added.
- Web UI: simplified terminal panel streams `/api/terminals/:budId/stream`, backfills history, sends input via REST; legacy session UI removed; tmux terminal now visible end-to-end.
- Repo is `cargo check` clean; earlier Rust warnings addressed (only benign reminders remain).

## Next actions
- Validation: end-to-end terminal checks with unified envelope (ensure → input → output/ready → history), and capture any lingering parse/log gaps.
- Agent robustness: add ANSI/binary guards and use readiness confidence to decide observe vs. next input; trim legacy shell path.
- UI polish: show readiness/last-line hints, add explicit input box + interrupt control, surface truncation states, and improve resize/focus stability.
- Docs: update proto/AGENTS/README for terminal proto (`id`/`ts`), tmux requirement, readiness payload.
- Tests: integration path for ensure→input→readiness→history; Bud detector samples for prompts/quiescence; optional cleanup of remaining benign warnings.
