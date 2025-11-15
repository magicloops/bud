# Bud PoC Progress — Phase 4 Snapshot

_Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_

## What’s implemented
- **Agent loop**: backend now uses OpenAI Responses tool-calling end-to-end—threads/messages hydrate context, we send `input_text` items, register the `shell.run` function schema, and parse structured `function_call` outputs before dispatching runs to Bud. SSE streams `agent.*` + `exec.*` events interleaved with stdout/stderr.
- **Threaded runs**: Run creation is tied to threads, `run_step` rows and log tails are recorded per tool call, and the event bus assigns ULID IDs for resume.
- **Bud executor**: Rust agent handles enrollment (with optional dev-token bypass), WSS heartbeats, serial shell execution, and base64 log streaming with `run_finished` frames.
- **Web console**: Vite helper creates/reuses threads, shows stored message history, posts new messages, and renders `agent.message/tool_call/tool_result` alongside `exec.*` events.
- **Docs/Plans**: `service/README.md`, `docs/proto.md`, `plan/phase-4-agent-loop.md`, and `debug/` notes cover architecture, SSE payloads, and current gaps.

## Known gaps / next phases
- **Phase 5 (Cancel semantics)**: propagate `/api/runs/:id/cancel` through the agent + OpenAI request and send Bud `cancel` (TERM→KILL).
- **Streaming & robustness**: adopt Responses streaming events (`response.output_text.delta`, `response.function_call_arguments.delta`) so we can stream agent tokens, detect tool calls earlier, and capture token usage from `response.completed`.
- **Reliability polish**: SSE replay/`Last-Event-ID`, run log truncation UX/downloads, and queue/backpressure on Bud dispatch.
- **Security & ergonomics**: workspace isolation, richer denylist, friendlier error reporting/testing knobs for mock LLMs.

## Quick start
1. `pnpm db:migrate && pnpm db:seed` inside `service/` (local Postgres).
2. Provide `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `service/.env`.
3. `pnpm dev` (backend) and `cargo run -- --server ws://localhost:3000/ws --token DEV-ENROLL-0001` (Bud).
4. `pnpm dev` inside `web/`, create a thread, and chat with Bud; watch SSE logs interleave agent chatter + stdout.
5. Alternatively, use `curl` as shown in `service/README.md` to post a thread message and stream `/api/runs/:id/stream`.

## Notes
- LLM cancels are deferred to Phase 5; for now, long-running commands must finish naturally.
- Keep `AGENTS.md` invariants in mind (plan/debug docs, protocol updates, safety posture).
