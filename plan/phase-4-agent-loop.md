# Plan: Phase 4 — Agent Loop & SSE Interleave

## Context
- Link to issue(s): _Phase 4 tracking ticket (TBD)_
- Related docs/sections in `/plan/proof-of-concept.md`: §5 (REST/SSE), §7 (Agent model), §11 Phase 4 TODOs, new TODOs added for thread history + run metadata.

## Objective
- Introduce a provider-agnostic agent loop that uses OpenAI’s Responses API (via `openai-node`) to handle `shell.run` tool calls.
- Persist user + assistant messages per thread, create `run_step` records for each tool call, and interleave SSE events for agent thinking/logs alongside exec output.
- Ensure the UI (and future consumers) can watch a single SSE stream that includes status transitions, agent messages, tool calls/results, stdout/stderr, and the final answer.

## Design / Approach
- **Module layout**
  - `service/src/agent/adapter.ts`: wraps the OpenAI SDK, handling streaming responses, tool-call callbacks, abort/cancel, and mapping raw events into internal types.
  - `service/src/agent/loop.ts`: orchestrates a run: send conversation context (system prompt + thread history) to the adapter, handle tool calls by dispatching `shell.run` via `RunManager`, feed summarized results back to the model until it returns a final answer or hits caps.
  - `service/src/agent/index.ts`: exposes `AgentService.enqueueMessage(threadId, userText)` that the routes call instead of `runManager.createRun` directly.
- **Data flow**
  1. `POST /api/threads/:threadId/messages` (user text) inserts the message, then calls `AgentService.planAndExecute`. Run status goes `planning` while the model deliberates.
  2. When the model emits a tool call: create/append `run_step`, dispatch the run via `RunManager`. SSE emits `agent.tool_call` followed by `exec.*` logs.
  3. When Bud finishes, summarize tail logs (limit bytes) and send back via `agent.tool_result` SSE event; agent loop resumes and eventually posts an assistant message + `final`.
- **SSE interleave**
  - Extend `RunEventBus` event schema to handle `agent.message`, `agent.tool_call`, `agent.tool_result`, `status` transitions (`planning`, `running`, `succeeded`, etc.).
  - Ensure each event carries an `id` (ULID) for resume; keep buffer limit (1000) for now.
- **Thread history**
  - Add `GET /api/threads/:threadId/messages` (and likely `/api/threads/:threadId`) so the agent service (and UI) can fetch existing context.
  - Agent loop loads prior `message` rows ordered by `created_at` and formats them into OpenAI Responses `messages`; the web UI only sends the latest user message and optional metadata (it never sends the full history).
- **Run metadata**
  - Track `run.step_count`, `run.logs_bytes`, `run.log_truncated`. When ingesting `stdout/stderr`, accumulate byte counts, flip `log_truncated` after 100 MB, and stop storing additional chunks (but keep streaming SSE by dropping DB writes).
  - Store summarized stdout/stderr tail blobs per `run_step` (e.g., last 4 KB each) for agent tool-result payloads.
- **Configuration**
  - New env vars: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1` or GPT‑5 placeholder), `MAX_AGENT_STEPS`, `RUN_STEP_TIMEOUT_SEC`.
  - Use Node 22 features if needed but stay TS-compatible.
- **Cancel hooks**
  - Keep placeholder methods: `AgentService.cancelRun(runId)` and `RunManager.requestCancel`. Actual cancel semantics stay Phase 5 but structure the API so we can plug cancellations later.

## Impacted contracts
- [x] WSS protocol (no new frames, but `run` usage same; `cancel` noop still)
- [x] SSE events (new `agent.*` event types, status transitions)
- [x] DB schema (read/write existing tables; no new migrations expected but heavier use)
- [x] Agent adapter/tool registry (introduce adapter abstraction + tool registry)
- [x] Web UI surfaces (display agent messages + tool call metadata)

## Test plan
- **Unit**
  - Adapter: mock OpenAI client stream to ensure tool-call parsing and final message emission.
  - Agent loop: use fake adapter that emits predetermined tool calls/finals; assert `run_step` creation and SSE events.
  - RunManager: verify `logs_bytes` accumulation + truncation flag.
- **Integration**
  - Local run where agent receives “echo hello” prompt (with mock adapter) and ensures SSE events arrive in order.
  - Manual end-to-end with real OpenAI key (optional / behind env flag) to confirm multi-step flow.
- **Manual**
  - Start backend + Bud + web UI; send prompt; observe agent chatter, tool call announcement, stdout/stderr, agent summary, and final answer in console UI.

## Rollout
- Feature flag `AGENT_ENABLED` default true for dev; allow fallback to legacy `POST /api/runs`.
- Update `service/README.md` (agent instructions), `web/README.md` (UI usage), and `/docs/proto.md` (SSE event catalog).
- Document required env vars and how to mock OpenAI (e.g., `OPENAI_API_KEY=fake` + stub adapter).

## Out of scope
- Full cancel semantics (Phase 5).
- Advanced safety filters / denylist tuning beyond basic command heuristics.
- Multi-concurrency Bud runs or run retries.
