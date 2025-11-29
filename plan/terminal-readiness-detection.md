# Plan: Terminal Readiness Detection (Bud → Backend → Agent/UI)

## Context
- Design docs: `plan/persistent-terminal.md` (v0.2), `plan/persistent-terminal-implementation.md`.
- Current state: Bud sends `terminal_status`/`terminal_output`; `terminal_ready` is stubbed. Backend forwards frames and exposes terminal SSE/REST, but agent/UI are not yet using readiness.

## Objective
- Implement a readiness detector in Bud that infers when the terminal is waiting for input vs. still processing, emit `terminal_ready` with confidence and prompt type, and surface it end-to-end (backend SSE + agent consumption).
- Keep it REPL- and pager-friendly; avoid sentinels or exit-code dependence.

## Design / Approach
- **Detection layers**:
  - Pattern match last line against prompt signatures (shell, python, node, confirmation, password, pager, db) with high confidence.
  - Quiescence timer: if no output for `QUIESCENCE_MS` (e.g., 1500ms) and no prompt match, score heuristically (line ending, length, special chars, progress indicators).
  - Timeout cap (e.g., 30s) to emit a low-confidence “timeout” readiness when nothing conclusive.
- **Trigger points**:
  - After each `terminal_input`/`terminal_interrupt` (await_ready enabled) → wait for output, then run detector.
  - On attach/startup: optional one-shot assessment after tail backfill.
  - Manual observe: agent can call `terminal.observe` (later) to request readiness without sending input.
- **Data surfaced** (`terminal_ready` frame):
  - `assessment: { ready, confidence, trigger, prompt_type?, hints{}, quiet_for_ms }`
  - `output_since_input` (base64), `output_bytes`, `last_line` (UTF-8 best-effort).
- **Noise handling**:
  - Strip trailing ANSI for detection; keep raw bytes for output.
  - Normalize line endings to `\n` for detection only.
  - Guard against binary output (skip prompt matching if non-UTF8; emit low-confidence).
- **Configurability**:
  - Defaults baked in; allow overrides via env/flags later (`BUD_TERMINAL_QUIESCENCE_MS`, `BUD_TERMINAL_MAX_WAIT_MS`).

## Impacted contracts
- [x] WSS protocol (Bud→Backend: `terminal_ready` payload shape)
- [ ] SSE events (already emit terminal.*; payload gains assessment fields)
- [ ] Agent adapter/tool registry (consumes assessment later)
- [ ] Web UI surfaces (display readiness hints later)
- [ ] DB schema (no change)

## Test plan
- Unit-ish (Bud): feed detector sample transcripts (shell prompt, python REPL, [Y/n], pager, long output) and assert `ready/confidence/prompt_type`.
- Integration: run command with deliberate delay; ensure quiescence triggers readiness; REPL start shows prompt; pager (`less`) yields pager prompt; binary output yields low confidence.
- Manual: run `pip install` → observe low confidence until quiet, then prompt; start `python3` → prompt_type=python; `yes/no` prompts detected; Ctrl+C returns to shell prompt with high confidence.

## Rollout
- Behind existing terminal feature flag; enable `terminal_ready` emission once detector is stable.
- Document payload in `docs/proto.md` (follow-up).
- No DB migrations; backend already forwards `terminal_ready`.

## Out of scope
- Agent policy changes (handled in separate agent tool refactor).
- UI rendering of readiness hints (follow-up task).
- Multi-terminal support or tmux control-mode prompts.
