# Bud PoC Progress — Unified Session Terminal

_Last updated: 2025-11-18_

## What’s implemented (recent)
- Thread-scoped sessions: `thread.current_session_id`, long TTL defaults, auto-create/attach per thread; pointer clears on close/fail.
- Agent runs via session writer (no `run_id`): inject commands with sentinels, capture 200-line tails with truncation markers, emit agent events on session SSE; cancel endpoint aborts agent turn (session stays alive).
- UI consolidation: single always-on terminal per thread, no run history/start button; stop cancels agent turn, composer stays enabled (queues one message). Session attach backfills recent output so the prompt is visible immediately.
- Migration added for `current_session_id`; xterm fitting stabilized, attach backfill implemented.

## Next actions
- Split stdout/stderr tails and harden sentinel parsing; expose truncation counts.
- Timeline markers (agent commands/manual input) in UI using `session_log`; show “canceled/in-progress” banners and optional manual session restart.
- Doc updates: new endpoints (`/api/threads/:id/session`, `/api/threads/:id/cancel`), tail policy, and updated setup.
- Add basic integration tests: ensure session per thread + agent command roundtrip.
- Optional: throttle/timeout guardrails for agent log polling; manual “close session” control for crash recovery.
