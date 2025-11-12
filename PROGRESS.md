# Bud PoC Progress — Phase 4 Snapshot

_Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_

## What’s implemented
- **Agent loop**: `POST /api/threads/:id/messages` now triggers an OpenAI Responses-driven planner that replays thread history, emits `agent.*` SSE events, issues `shell.run` tool calls, and streams stdout/stderr interleaved with agent narration.
- **Threaded runs**: Run creation is tied to threads, `run_step` rows are appended per tool call, and SSE buffers now include ULID-backed IDs for resume.
- **Bud executor**: Rust agent still handles enrollment, WSS heartbeats, and serial shell execution with base64 log chunks and `run_finished` events.
- **Web console**: The Vite playground now creates threads/messages, listens for `agent.message/tool_call/tool_result`, and displays them alongside `exec.*` streams.
- **Docs**: `service/README.md`, `docs/proto.md`, and `plan/phase-4-agent-loop.md` document the agent architecture, SSE payloads, and open TODOs.

## Known gaps / next phases
- **Phase 5 (Cancel semantics)**: wire `/api/runs/:id/cancel`, propagate through the agent + OpenAI request, and forward cancels to Bud (TERM→KILL).
- **Reliability polish**: SSE replay/`Last-Event-ID`, better run log truncation UX, tool-result summaries, and queue/backpressure on Bud dispatch.
- **Security & ergonomics**: workspace isolation, richer denylist, and friendlier error reporting/testing knobs for mock LLMs.

## Quick start
1. `pnpm db:migrate && pnpm db:seed` inside `service/` (local Postgres).
2. Provide `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `service/.env`.
3. `pnpm dev` (backend) and `cargo run -- --server ws://localhost:3000/ws --token DEV-ENROLL-0001` (Bud).
4. `pnpm dev` inside `web/`, create a thread, and chat with Bud; watch SSE logs interleave agent chatter + stdout.
5. Alternatively, use `curl` as shown in `service/README.md` to post a thread message and stream `/api/runs/:id/stream`.

## Notes
- LLM cancels are deferred to Phase 5; for now, long-running commands must finish naturally.
- Keep `AGENTS.md` invariants in mind (plan/debug docs, protocol updates, safety posture).
