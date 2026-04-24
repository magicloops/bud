# Debug: LLM First Visible Token Latency

## Environment

- Service: local Fastify service
- Web: local React route consuming `/api/threads/:thread_id/agent/stream`
- LLM mode: real OpenAI and Anthropic provider integrations, based on supplied logs
- Date: 2026-04-24

## Repro Steps

1. Open an existing thread with an active agent SSE stream.
2. Send a user message through `POST /api/threads/:thread_id/messages`.
3. Compare the `Calling LLM via provider` log timestamp with the first `Agent SSE event emit` for `agent.message_start` or `agent.message_delta`.

## Observed

OpenAI example:

```text
17:25:08.492 Calling LLM via provider
17:25:12.050 Agent SSE event emit agent.message_start
17:25:12.050 Agent SSE event emit agent.message_delta
```

Elapsed from provider-call log to first visible assistant event: about `3.56s`.

Anthropic Haiku example:

```text
17:27:53.692 Calling LLM via provider
17:27:56.028 Agent SSE event emit agent.message_start
17:27:56.028 Agent SSE event emit agent.message_delta
```

Elapsed from provider-call log to first visible assistant event: about `2.34s`.

Both examples show a fast `/agent/state` poll in the middle. That route only reads the in-memory runtime snapshot and is not blocking the model stream.

The examples also show two `Agent SSE event emit` logs for `agent.message_start` with different request ids. That means two active SSE listeners received the same runtime event. This duplicates log lines and outbound event writes, but it is not the cause of the pre-first-event gap.

## Expected

- The service should begin sending browser-visible progress as soon as useful provider activity starts.
- If provider-side first text takes multiple seconds, logs should distinguish:
  - time to provider request dispatch
  - time to first provider stream event
  - time to first reasoning event
  - time to first text delta
  - time to stream completion

## Request-To-Final Walkthrough

### 1. Message Request

`service/src/routes/threads/messages.ts`

The message route:

1. Parses params/body and authorizes thread access.
2. Resolves selected model and reasoning before any write.
3. Checks duplicate `client_id`.
4. If a terminal session exists and no agent is active, runs context sync.
5. Inserts the user message.
6. Updates thread metadata.
7. Calls `agentService.startUserMessage(...)`.
8. Starts best-effort title generation after the agent turn is queued.
9. Returns `201`.

Relevant code:

- `POST /messages` route starts at `service/src/routes/threads/messages.ts:174`.
- Model/reasoning validation is at `service/src/routes/threads/messages.ts:187`.
- Context sync runs before the user insert at `service/src/routes/threads/messages.ts:218`.
- User insert starts at `service/src/routes/threads/messages.ts:254`.
- Agent start is called after thread metadata at `service/src/routes/threads/messages.ts:293`.

Possible latency before the shown log:

- `contextSyncService.checkAndSync(...)` can capture terminal state and, if it detects a state change, call a summary LLM before inserting the user message.
- `agentService.startUserMessage(...)` awaits terminal session get/create/ensure before spawning the async model flow.

This pre-call latency is not what the supplied timestamps are measuring, because `Starting agent run` and `Calling LLM via provider` happen after those steps.

### 2. Agent Turn Start

`service/src/agent/agent-service.ts`

`startUserMessage(...)` resolves model reasoning, starts runtime state, ensures the terminal session, registers cancellation, and then starts `runAgentFlow(...)` asynchronously.

Relevant code:

- Runtime is marked active at `service/src/agent/agent-service.ts:66`.
- Terminal session ensure is awaited at `service/src/agent/agent-service.ts:70`.
- Async agent flow is spawned at `service/src/agent/agent-service.ts:74`.

`runAgentFlow(...)` loads the whole conversation, logs `Starting agent run`, marks the runtime as thinking, and calls the model runner.

Relevant code:

- Conversation load happens at `service/src/agent/agent-service.ts:115`.
- `Starting agent run` is logged at `service/src/agent/agent-service.ts:116`.
- `modelRunner.invokeModel(...)` is awaited at `service/src/agent/agent-service.ts:131`.

Because the log includes `entries: 314` or `316`, the DB conversation load has already completed by the time the measured provider gap starts.

### 3. Model Invocation

`service/src/agent/model-runner.ts`

`invokeModel(...)` logs `Calling LLM via provider`, resolves the provider, builds a `ModelConfig`, and starts iterating the provider stream.

Relevant code:

- `Calling LLM via provider` is logged at `service/src/agent/model-runner.ts:152`.
- Model config uses global `agentMaxOutputTokens` at `service/src/agent/model-runner.ts:161`.
- Provider stream iteration starts at `service/src/agent/model-runner.ts:220`.

Important behavior:

- Provider `message_start` is not emitted to the browser; it only sets `responseId`.
- `reasoning_start`, `reasoning_delta`, and `tool_use_start` are not emitted to the browser.
- `agent.message_start` is emitted only when the first non-empty `text_delta` arrives.
- If the model streams reasoning or tool-call arguments before text, the UI sees no `agent.message_start` yet.

Relevant code:

- Provider `message_start` is swallowed at `service/src/agent/model-runner.ts:222`.
- First visible browser event is created from `text_delta` at `service/src/agent/model-runner.ts:235`.
- `reasoning_done` is stored for replay but not surfaced at `service/src/agent/model-runner.ts:252`.
- The model response is only reconstructed and logged after the stream ends at `service/src/agent/model-runner.ts:315`.

### 4. Provider Adapters

`service/src/llm/providers/openai.ts`

The OpenAI adapter builds Responses API params, awaits `client.responses.create(...)`, then transforms raw stream events.

Relevant code:

- Request params are built at `service/src/llm/providers/openai.ts:134`.
- `max_output_tokens` receives the agent-wide configured value at `service/src/llm/providers/openai.ts:139`.
- `stream: true` is set at `service/src/llm/providers/openai.ts:143`.
- The SDK call is awaited at `service/src/llm/providers/openai.ts:154`.
- Raw `response.created` maps to canonical `message_start` at `service/src/llm/providers/openai.ts:417`.
- Raw `response.output_text.delta` maps to canonical `text_delta` at `service/src/llm/providers/openai.ts:502`.
- Reasoning summary deltas map to `reasoning_delta` at `service/src/llm/providers/openai.ts:512`.

For OpenAI GPT-5 models, non-`none` reasoning sets:

```ts
reasoning: {
  effort,
  summary: "auto"
}
```

Relevant code: `service/src/llm/providers/openai.ts:106`.

`service/src/llm/providers/anthropic.ts`

The Anthropic adapter builds Messages API streaming params and transforms stream events.

Relevant code:

- Request params are built at `service/src/llm/providers/anthropic.ts:228`.
- `max_tokens` receives the min of global request max and model max at `service/src/llm/providers/anthropic.ts:222`.
- `stream: true` is set at `service/src/llm/providers/anthropic.ts:237`.
- SDK stream creation happens at `service/src/llm/providers/anthropic.ts:242`.
- Raw `message_start` maps to canonical `message_start` at `service/src/llm/providers/anthropic.ts:460`.
- Raw thinking deltas map to `reasoning_delta` at `service/src/llm/providers/anthropic.ts:517`.
- Raw text deltas map to `text_delta` at `service/src/llm/providers/anthropic.ts:534`.

For Haiku 4.5, `low` reasoning maps to manual thinking with a `1024` token budget, not to no reasoning.

Relevant code:

- Haiku catalog budget: `service/src/llm/model-catalog.ts:140`.
- Anthropic thinking-budget lowering: `service/src/llm/providers/anthropic.ts:182`.

For Opus 4.6, Sonnet 4.6, and Opus 4.7, enabled reasoning sends adaptive thinking plus `output_config.effort`.

Relevant code: `service/src/llm/providers/anthropic.ts:171`.

### 5. SSE Delivery

`service/src/runtime/agent-runtime-state.ts`

Runtime events are synchronous in-process broadcasts to current SSE listeners plus a bounded in-memory buffer.

Relevant code:

- `runtime.emit(...)` allocates a cursor and broadcasts listeners at `service/src/runtime/agent-runtime-state.ts:193`.
- SSE listener logging and `reply.sse(...)` happen at `service/src/runtime/agent-runtime-state.ts:235`.

This layer is unlikely to explain a 2-4 second pre-first-event gap because it is only invoked after the model runner emits a visible event.

### 6. Response Finish

After provider stream completion:

1. `modelRunner.invokeModel(...)` reconstructs a canonical response.
2. If there is a tool call, the tool event is emitted, terminal execution runs, the tool result is persisted and emitted, then the loop calls the model again.
3. If there is no tool call, final text is parsed.
4. The assistant message is inserted in a DB transaction with thread metadata and push-outbox work.
5. The service emits `agent.message` and `final`.
6. Runtime state returns to idle.

Relevant code:

- Response reconstruction/logging: `service/src/agent/model-runner.ts:305`.
- Final assistant DB transaction: `service/src/agent/transcript-writer.ts:153`.
- Canonical `agent.message` and `final` events: `service/src/agent/transcript-writer.ts:232`.

This can affect time from last text delta to final completion, but it does not affect first visible token latency.

## Findings

### Finding 1: Current logs measure first visible text, not first provider activity

The `Calling LLM via provider` log happens before provider stream iteration, but the first `Agent SSE event emit agent.message_start` log happens only when `text_delta` reaches `AgentModelRunner`.

Provider lifecycle events and reasoning/tool events can arrive earlier without producing an `agent.message_start` SSE event.

Confidence: high.

### Finding 2: The supplied examples are not no-reasoning calls

Both supplied examples show `reasoningEffort: "low"`.

For OpenAI GPT-5.4 Nano, this sends OpenAI reasoning effort `low` plus reasoning summary mode `auto`.

For Claude Haiku 4.5, this sends manual thinking with `budget_tokens: 1024`.

If the model emits reasoning or thinking before text, the service currently hides that work from the browser, so it appears as a silent gap.

Confidence: high.

### Finding 3: The request shape is large even for fast models

The example turns include `314` and `316` canonical entries. Every invocation sends:

- full replayed thread context
- the large Bud system prompt
- two terminal tool schemas
- OpenAI strict-mode transformed schemas for OpenAI calls
- `maxOutputTokens: 128000` by default

The service does not do much synchronous work between the provider-call log and first stream iteration, so most of this cost is likely provider-side prefill/planning time rather than local JavaScript CPU. Still, the request shape is a strong contributor to provider time-to-first-text.

Confidence: medium-high.

### Finding 4: `AGENT_MAX_OUTPUT_TOKENS=128000` is sent on normal turns

The global default is `128000`, and `AgentModelRunner` passes it into every model config. OpenAI receives it as `max_output_tokens`; Anthropic receives it capped by model max.

Large max-token budgets may affect provider scheduling/planning and should be A/B tested with a normal chat cap such as `4096` or `8192`.

Confidence: medium.

### Finding 5: Pre-provider local latency exists, but it is outside the shown gap

Before the provider call, the message route may run context sync. Context sync can:

- call terminal capture with a `3000ms` timeout budget
- update terminal state snapshots
- call a summary LLM if state changed
- insert a system message

`startUserMessage(...)` also awaits terminal session ensure before spawning the agent flow.

These can add to end-to-end user-perceived latency, but they happen before `Starting agent run` / `Calling LLM via provider`, so they are not the cause of the specific 2.3-3.6s window in the supplied logs.

Confidence: high for placement, medium for total-latency impact.

### Finding 6: Duplicate SSE listeners are visible

The same `agent.message_start` event is emitted to two request ids. This is either two tabs/clients or an EventSource lifecycle issue.

It should not create seconds of first-token latency, but it can double event logging/writes and make latency traces noisier.

Confidence: medium.

## Top Hypotheses

### 1. Provider time-to-first-text is the main source

The service appears to be waiting inside provider streaming until the first text delta. With 314+ entries, tool schemas, reasoning enabled in examples, and a large max-output budget, a 2-4 second provider TTFT is plausible.

Priority: highest.

### 2. Hidden reasoning/thinking is making the gap look worse

Provider stream activity may be happening earlier, but Bud only emits browser-visible draft events on text deltas. This is especially likely for Claude thinking and OpenAI reasoning.

Priority: high.

### 3. The global max-output cap is too large for normal turns

Every request advertises up to `128000` output tokens. Even if providers should not always use it, this is worth isolating because it is easy to A/B and may affect routing or planning latency.

Priority: medium-high.

### 4. Large full-thread replay is increasing provider prefill time

The service sends hundreds of entries every turn. That may be correct for quality, but it should be measured separately from model choice and reasoning level.

Priority: medium.

### 5. Context sync and terminal ensure may explain additional end-to-end latency before the shown logs

If the UI feels slower than the logged provider gap, measure the route from HTTP receipt to `Calling LLM via provider`. Context sync and terminal ensure are the likely local contributors.

Priority: medium for full request latency; low for the supplied gap.

## Proposed Instrumentation

Add temporary timing logs around the model path:

1. In `AgentModelRunner.invokeModel(...)`:
   - `llm.invoke.start`
   - `llm.stream.first_event`
   - `llm.stream.first_reasoning_delta`
   - `llm.stream.first_tool_event`
   - `llm.stream.first_text_delta`
   - `llm.stream.done`

2. In each provider adapter:
   - request param summary: provider, model, input item count, tool count, max tokens, reasoning enabled/effort, serialized input byte size, serialized tool byte size
   - OpenAI: duration from entering `invoke()` to `responses.create(...)` returning
   - OpenAI/Anthropic: duration to first raw provider event before canonical transform

3. In `POST /messages`:
   - auth/thread lookup duration
   - reasoning validation duration
   - context sync duration and whether summary LLM ran
   - user insert duration
   - `startUserMessage(...)` duration

4. In `AgentRuntimeStateManager.attach(...)`:
   - active listener count by thread when attaching/detaching to diagnose duplicate EventSource listeners.

## Proposed Experiments

Run the same short prompt on the same thread and compare timings:

1. GPT-5.4 Nano with `reasoning_effort: "none"` vs `"low"`.
2. Claude Haiku 4.5 with `reasoning_effort: "none"` vs `"low"`.
3. `AGENT_MAX_OUTPUT_TOKENS=4096` vs `128000`.
4. A fresh thread with 1-2 entries vs the 314-entry thread.
5. Temporarily omit tools or set `toolChoice: "none"` for a pure-answer diagnostic request.
6. Existing terminal session ready vs no terminal session/context sync path.

## Likely Fix Directions

1. Add model-stream phase instrumentation first. Without it, the current logs cannot distinguish provider TTFT from hidden reasoning.
2. Emit a lightweight `agent.model_start` / `agent.reasoning_start` event, or expose reasoning/progress state in `/agent/state`, so the UI can show real progress before first text.
3. Use per-model/per-turn max output defaults instead of the global `128000` for ordinary chat turns.
4. Consider sending `reasoning.summary` only when the UI or tool-loop replay needs it.
5. Add a context-window policy so old thread history is summarized or windowed instead of replaying hundreds of entries indefinitely.
6. Investigate duplicate agent SSE listeners if they persist with a single visible browser tab.

## Current Assessment

There is no obvious local blocking operation between `Calling LLM via provider` and the first `agent.message_start` SSE event. The most likely issue is that our current first visible event is too late in the provider event lifecycle: it waits for first assistant text and hides earlier provider `message_start`, reasoning, and tool-argument activity.

The fastest next step is instrumentation, followed by A/B tests for reasoning off, lower max output tokens, and a fresh short-context thread.
