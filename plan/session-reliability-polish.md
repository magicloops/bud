# Plan: Session Reliability & Polish

## Context
- Link to issue(s): _TBD_
- Related docs/sections in `/plan/proof-of-concept.md`: Interactive sessions (Phase 4.7+) reliability goals.

## Objective
- Harden the PTY interactive session MVP so long-lived sessions behave predictably across disconnects, multiple viewers, and storage limits.
- Acceptance: attach tokens rotate safely, session status/metrics surface via SSE, logs respect caps with clear UX, and tmux durability groundwork is ready.

## Design / Approach
- **Bud agent**: add backpressure + per-session byte counters, expose session heartbeat/linger timers, and emit richer `session_status` frames (idle vs running vs closed). Track writer leases (single active input) with future tmux adoption in mind.
- **Backend service**: extend `SessionManager` to store attach tokens (rotate on TAKE WRITER), emit session SSE events (`session.status`, `session.final`, `session.writer_changed`), enforce log soft caps (100 MB) with `logs_blob_url` fallback, and add GC sweeps for idle sessions. `/term` should validate writer leases and reject writes from spectators.
- **Web UI**: integrate SSE for session status, display log truncation warnings, and surface controls for “Take writer”, “Detach”, and “Download transcript”. Switch the beta pane to xterm.js for accurate PTY rendering + copy support.
- **Telemetry**: add metrics counters (sessions_open, bytes_in/out, attach_token_rotations) and structured logs for session lifecycle.

## Impacted contracts
- [x] WSS protocol (new session status/error frames)
- [x] SSE events (session status stream)
- [x] DB schema (attach token table or columns)
- [x] Agent adapter/tool registry (future-proof for more tools)
- [x] Web UI surfaces (xterm.js + controls)

## Test plan
- Unit tests for SessionManager attach token rotation + log cap behavior.
- Integration flow: start session, rotate writer, simulate detach/attach, verify SSE + UI updates.
- Manual tmux smoke test (when available) to ensure graceful fallback when unsupported.
- Manual session recipe:
  1. Launch service (`pnpm dev`), Bud (`cargo run -- --server ws://localhost:3000/ws --token DEV-LOCAL-ONLY`), and web (`pnpm dev`).
  2. Start a PTY session, type commands, and confirm `/term` WS plus `/api/sessions/:id/stream` both show `session.status` ➜ `open`.
  3. Click **Take writer** in a second browser window, ensure the original writer socket closes (code `4401`) and SSE emits `session.writer_changed` with `writer_present:false`.
  4. Resize the terminal, watch `session_resize` hit Bud and confirm the PTY responds.
  5. Stop the session; verify `session.final` SSE payload includes `exit_code`, `bytes_in/out`, and the UI badge switches to “Session closed”.

## Rollout
- Update `/docs/proto.md` with new `session_status` frame schema.
- Document SSE endpoints + UI controls in `service/README.md` and `web/README.md`.
- Report progress regularly in `PROGRESS.md`.

## Out of scope
- Multi-tenant auth beyond attach tokens.
- Full tmux durability implementation (handled in next phase).
