# Bud PoC Progress — Phase 4 Snapshot

_Last updated: 2025-11-17T09:01:59Z_

## What’s implemented
- **Agent loop**: backend now uses OpenAI Responses tool-calling end-to-end—threads/messages hydrate context, we send `input_text` items, register the `shell.run` function schema, and parse structured `function_call` outputs before dispatching runs to Bud. SSE streams `agent.*` + `exec.*` events interleaved with stdout/stderr.
- **Threaded runs**: Run creation is tied to threads, `run_step` rows and log tails are recorded per tool call, and the event bus assigns ULID IDs for resume.
- **Bud executor**: Rust agent handles enrollment (with optional dev-token bypass), WSS heartbeats, serial shell execution, and base64 log streaming with `run_finished` frames. Bud now owns its working directory, reports `cwd` + `error` in `run_finished`, and keeps running even if the backend omits `cwd`.
- **Web console**: Vite helper now ships a Bud workbench—neo‑brutalist shadcn/Tailwind layout with a Bud rail, thread list, chat timeline, terminal/web viewport toggle, and composer that still speaks to today’s `/api/threads` + SSE stack. Optimistic user messages show instantly, the SSE stream updates messages + current `cwd` as the run finishes, assistant/tool entries render richly (Markdown via `react-markdown` + `remark-breaks`, structured tool call cards with expandable JSON viewer, and per-message collapse toggles for >500 px histories), the terminal pane mirrors a real shell transcript (prompt + command rows, streaming stdout/stderr, exit codes, inline “running…” indicators keyed off tool calls), and operators can choose GPT‑5 reasoning effort (Fast/Thinking/Deep/Max) which threads through to the backend/OpenAI config.
- **Docs/Plans**: `service/README.md`, `docs/proto.md`, `plan/phase-4-agent-loop.md`, and `debug/` notes cover architecture, SSE payloads, and current gaps.

## Known gaps / next phases
- **Phase 5 (Cancel semantics)**: propagate `/api/runs/:id/cancel` through the agent + OpenAI request and send Bud `cancel` (TERM→KILL).
- **Streaming & robustness**: adopt Responses streaming events (`response.output_text.delta`, `response.function_call_arguments.delta`) so we can stream agent tokens, detect tool calls earlier, and capture token usage from `response.completed`.
- **Reliability polish**: SSE replay/`Last-Event-ID`, run log truncation UX/downloads, and queue/backpressure on Bud dispatch.
- **Security & ergonomics**: workspace isolation, richer denylist, friendlier error reporting/testing knobs for mock LLMs.
- **UI schema alignment**: wire the new workbench components to richer Bud metadata (availability, tags), tabbed log panes, and future settings drawers once backend schemas catch up.
- **Rich transcripts**: persist the new shell transcript objects (Markdown/tool metadata + stdout/stderr chunks) downstream so uploads/export keep formatting (ties into upcoming schema doc in `plan/ui-schema-alignment.md`).

## Quick start
1. `pnpm db:migrate && pnpm db:seed` inside `service/` (local Postgres).
2. Provide `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `service/.env`.
3. `pnpm dev` (backend) and `cargo run -- --server ws://localhost:3000/ws --token DEV-ENROLL-0001` (Bud).
4. `pnpm dev` inside `web/`, create a thread, and chat with Bud; watch SSE logs interleave agent chatter + stdout.
5. Alternatively, use `curl` as shown in `service/README.md` to post a thread message and stream `/api/runs/:id/stream`.

## Notes
- LLM cancels are deferred to Phase 5; for now, long-running commands must finish naturally.
- Keep `AGENTS.md` invariants in mind (plan/debug docs, protocol updates, safety posture).
