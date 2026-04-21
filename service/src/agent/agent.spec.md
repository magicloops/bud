# agent

Agent orchestration layer for AI-assisted terminal interactions using the LLM provider abstraction.

## Purpose

The agent service coordinates AI-assisted terminal interactions. When a user sends a message, it:
1. Builds conversation context from thread history (canonical format)
2. Calls the LLM provider (OpenAI, Anthropic) via `providerRegistry`
3. Executes tool calls on the connected bud daemon
4. Loops until a final response or max steps reached

## Files

### `index.ts`

Simple barrel export:
```typescript
export { AgentService } from "./agent-service.js";
export { ThreadTitleService, normalizeGeneratedThreadTitle, resolveThreadTitleModel } from "./thread-title-service.js";
```

### `cancellation-registry.ts`

Small ownership unit for per-thread cancellation controllers.

**Responsibilities**:
- register active `AbortController`s by thread id
- abort and remove the controller during explicit cancel
- clear finished controllers after success/failure/cancel paths

### `cancellation-registry.test.ts`

Direct tests for cancel-vs-clear behavior in the extracted cancellation registry.

### `contracts.ts`

Shared agent-facing tool/result contracts.

**Responsibilities**:
- define the normalized `terminal.send` / `terminal.observe` directive unions used across the split agent seams
- centralize readiness defaults plus tool-argument serialization
- normalize legacy wait/key inputs reused during transcript replay and model-tool parsing

### `conversation-loader.ts`

Conversation-building ownership extracted from `AgentService`.

**Responsibilities**:
- seed the canonical system prompt
- load persisted thread messages into canonical provider input order
- normalize historical tool rows, including legacy `terminal.interrupt` replay and `screen_stable` wait values
- preserve user preferred-cwd hints during replay

### `conversation-loader.test.ts`

Direct tests for transcript normalization in the extracted conversation loader.

**Current Coverage**:
- preferred-cwd metadata is appended to user messages
- persisted legacy interrupt rows replay as canonical `terminal_send` with `key: "ctrl+c"`
- stored `screen_stable` waits replay as canonical `settled`

### `agent-service.ts`

Thin agent orchestrator over the extracted conversation/model/tool/transcript ownership units.

The prompt/tool-definition ownership now lives in the extracted modules:
- `conversation-loader.ts` owns the canonical Bud Agent system prompt used for every turn
- `model-runner.ts` owns the canonical `terminal_send` / `terminal_observe` JSON Schema definitions passed to providers

**System Prompt Highlights**:
- tool-calling guidance for `terminal.send` and `terminal.observe`
- readiness confidence interpretation (`>= 0.8` ready, `0.5-0.8` probably ready, `< 0.5` still processing)
- hint interpretation (`looks_like_prompt`, `looks_like_confirmation`, etc.)
- REPL context awareness (Python/Node/Claude Code vs shell)
- settled-by-default `terminal.send` guidance plus explicit `wait_for` usage rules
- direct markdown final-response guidance (no JSON wrapper)

**Canonical Tool Definitions**:

| Tool | Parameters | Description |
|------|------------|-------------|
| `terminal_send` | `text?`, `submit?`, `key?`, `observe_after_ms?`, `wait_for?`, `timeout_ms?` | Primary terminal input tool for shell commands, multiline shell input, and interactive input, with a settled-by-default synchronous result |
| `terminal_observe` | `lines?`, `wait_for?`, `view?`, `timeout_ms?` | Observe terminal deltas by default, with explicit full-screen/history modes |

#### AgentService Class

**Constructor dependencies**:
- `TerminalSessionManager` (thread-scoped tmux sessions)
- `AgentRuntimeStateManager` (authoritative `/agent/state` snapshots plus bounded agent-stream resume)
- optional `ContextSyncService` for post-send refresh after state-changing tool calls
- logger and debug flags

**Internal collaborators**:
- `AgentConversationLoader`
- `AgentModelRunner`
- `TerminalToolExecutor`
- `AgentTranscriptWriter`
- `AgentCancellationRegistry`

**Key methods**:

| Method | Purpose |
|--------|---------|
| `startUserMessage(threadId, options)` | Entry point - seeds active runtime state, then spawns async agent flow and carries thread-owner stamping |
| `runAgentFlow(...)` | Main loop - delegate conversation/model/tool/transcript work across the extracted ownership seams |
| `cancelThread(threadId)` | Abort running agent via AbortController |
| `isThreadActive(threadId)` | Check if thread has active agent run (used by ContextSyncService) |

**Agent Loop Flow**:
```
startUserMessage()
    └─► runAgentFlow() [async]
           │
           ├─► conversationLoader.load()
           │
           └─► LOOP (max steps):
                  │
                  ├─► modelRunner.invokeModel()
                  │
                  ├─► emit agent.message_start / delta / done (text responses only)
                  ├─► update `/agent/state` cursor + draft snapshot in lockstep
                  │
                  ├─► modelRunner.extractToolCall()
                  │      │
                  │      ├─► tool_call found → transcriptWriter.emitToolCall()
                  │      │                  └─► toolExecutor.execute()
                  │      │                  └─► transcriptWriter.recordToolResult()
                  │      │
                  │      └─► no tool → modelRunner.parseFinalResponse()
                  │                    └─► transcriptWriter.recordFinalAssistant()
                  │                    └─► reset `/agent/state` to idle after final durable state
                  │
                  └─► continue or return
```

**Streaming Notes**:
- The agent no longer asks the model to wrap final answers in JSON.
- Provider `invoke()` streams are now the primary path; `AgentService` reconstructs a `CanonicalResponse` from provider text/tool/reasoning events.
- Draft assistant text is emitted live over SSE via `agent.message_start`, `agent.message_delta`, and `agent.message_done`.
- The persisted assistant transcript row is still created only once the turn resolves, then emitted as `agent.message`.
- Assistant/tool `client_id` values are now allocated before the first live runtime/SSE event that refers to them, and the persisted assistant/tool rows reuse those same values at insert time.
- Reasoning blocks are preserved inside the in-memory conversation on tool-call loops so providers that require multi-turn reasoning context do not lose those items.
- `startUserMessage()` now allocates the turn id and seeds `/agent/state` before session ensure returns, so clients can bootstrap with a resumable cursor even before the first visible event.
- Agent SSE frame ids are now the same opaque runtime cursors used by `/agent/state.stream_cursor`.
- `terminal.send` summaries are now evidence-based rather than optimistic: the agent uses the settled/default result or timeout delta and avoids claiming program progress when no visible delta appears.
- `terminal.send` is now modeled as one gesture at a time: `text` with optional `submit`, or one semantic `key` such as `ctrl+c`.
- historical persisted `terminal.interrupt` tool rows are normalized during replay into `terminal_send` with `key: "ctrl+c"`, so old transcripts still round-trip through the current provider/tool format.
- `terminal.observe` guidance now steers the model toward `wait_for: "settled"` instead of the older `screen_stable` mental model, and replay normalization maps any older `screen_stable` tool payloads to `settled`.
- `terminal.observe` now defaults to `view: "delta"` and exposes `view: "screen"` / `view: "history"` only when the model explicitly needs broader context.
- model-facing tool-result payloads now center on readiness, context, and additive `delta` content instead of low-level send-observation metadata.
- `context_after.source` now distinguishes observed shell return from inferred REPL/session tracking so the model can treat inferred context as a hint rather than proof.
- the main `AgentService` file now delegates conversation loading, model invocation, terminal tool execution, and transcript persistence/runtime emission to dedicated modules instead of bundling those concerns inline

### `terminal-send-outcome.ts`

Small helper module for interpreting `terminal.send` evidence.

**Responsibilities**:
- derive send acceptance states from the settled/default send result delta
- derive optional next-step state from acceptance, readiness, and observed/inferred context
- build conservative tool summaries such as "Attempted to send ...; no visible delta observed"
- keep the send-summary logic separate from the larger agent loop

### `terminal-send-outcome.test.ts`

Standalone Node tests for Phase 6 send-result interpretation.

**Current Coverage**:
- unchanged post-send deltas map to `acceptance.status = "no_visible_change"`
- summaries remain conservative when no visible delta was observed
- timeout summaries remain conservative when the settled wait expires before completion
- ambiguous sends recommend `terminal.observe` before the agent assumes the TUI accepted the input
- settled REPL/TUI updates still map to `state.status = "waiting_for_input"`
- send results that visibly return to shell map their next step back to another `terminal.send`

### `agent-service.test.ts`

Standalone Node tests for `AgentService` orchestration behavior.

**Current Coverage**:
- `cancelThread()` aborts the active turn and rejects any pending terminal waits for that thread

### `model-runner.ts`

Model invocation ownership extracted from `AgentService`.

**Responsibilities**:
- resolve provider/model aliases for the selected request model
- normalize reasoning effort against the actual selected model rather than a startup-time default-model snapshot
- consume provider `invoke()` streams and emit draft assistant runtime events
- reconstruct canonical responses and normalize provider tool-call payloads

### `model-runner.test.ts`

Direct tests for the extracted model runner.

**Current Coverage**:
- reasoning-effort normalization follows the selected model (`none` downgraded for `o3`-style models)
- legacy `keys` arrays normalize into canonical semantic key strings during tool-call parsing

### `terminal-tool-executor.ts`

Terminal tool execution ownership extracted from `AgentService`.

**Responsibilities**:
- resolve/ensure the thread terminal session before tool execution
- run `terminal.observe` and `terminal.send`
- derive readiness/context-after snapshots from runtime state plus observed shell evidence
- shape conservative tool summaries and persisted tool payloads

### `terminal-tool-executor.test.ts`

Direct tests for the extracted terminal tool executor.

**Current Coverage**:
- interrupt-style `terminal.send` remains conservative when no visible delta is observed
- ambiguous mixed text+key terminal sends fail before touching the terminal runtime

### `transcript-writer.ts`

Transcript persistence and runtime-emission ownership extracted from `AgentService`.

**Responsibilities**:
- emit `agent.tool_call` and synchronize `/agent/state.pending_tool`
- persist assistant/tool transcript rows with stable `client_id`
- emit `agent.tool_result`, `agent.message`, and `final` after durable writes
- advance runtime cursors only after the durable transcript boundary is visible

**Reasoning Effort Support**:

`AgentModelRunner` supports OpenAI reasoning effort levels: `none`, `low`, `medium`, `high`, and now resolves compatibility against the actual selected model id/alias.

**Cancellation**:

`AgentService` now delegates per-thread `AbortController` ownership to `AgentCancellationRegistry`, and explicit cancel also rejects any pending terminal wait through `TerminalSessionManager.rejectPendingRequestsForThread(...)`.

**Ownership Notes**:
- `startUserMessage(..., { ownerUserId })` threads the resolved thread owner through the agent loop
- assistant final messages and tool-result messages are written with `message.created_by_user_id`
- lazily created terminal sessions inherit the same owner via `ensureSessionRecordForThread(..., ownerUserId)`

### `thread-title-service.ts`

Best-effort thread-title generation for the first durable user message.

**Responsibilities**:
- confirm the just-written user row is still the canonical first user message on the thread
- choose a usable title model from the configured default, the preferred fast title model, or any other registered provider model
- sanitize the model output into a plain-text title
- persist the title with a conditional `thread.title IS NULL` update
- emit `thread.title` on the existing agent SSE channel and advance the shared runtime cursor

**Notes**:
- runs fire-and-forget after `AgentService.startUserMessage(...)` succeeds, so the assistant turn is never blocked on title generation
- if no provider is configured, the chosen model is unavailable, the model times out, or another request wins the conditional update first, the thread simply keeps its existing title state
- normalization now accepts any non-empty cleaned model title rather than rejecting 1-2 word outputs, so concise titles like `Bugfix` or `Assistant Introduction` persist as-is
- the emitted payload is `{ thread_id, title, source, updated_at }`, where `source` is currently `generated_first_user_message`
- streamed title reconstruction now updates the active text block through a locally narrowed `text` reference so canonical non-text blocks remain type-safe during `tsc`

### `thread-title-service.test.ts`

Standalone Node tests for title normalization, model fallback selection, provider-less handling, and streamed title text accumulation.

**Current Coverage**:
- generated titles strip labels and trailing punctuation
- longer descriptive titles remain intact
- short 1-2 word titles remain valid
- configured-default and fallback title-model selection behave as expected
- provider-less title generation returns `null` instead of throwing
- streamed title-response collection keeps accumulating `text_delta` chunks through a narrowed text block instead of widening back to the full canonical content union

## Events Emitted

Via `AgentRuntimeStateManager`, using `threadId` as the channel:

| Event | Data | When |
|-------|------|------|
| `agent.message_start` | `{ turn_id, client_id }` | First visible assistant-text chunk for a turn |
| `agent.message_delta` | `{ turn_id, client_id, delta }` | Incremental assistant-text append |
| `agent.message_done` | `{ turn_id, client_id, text }` | Draft assistant text complete, before canonical persistence |
| `agent.tool_call` | `{ turn_id, client_id, call_id, name, args }` | Before executing tool |
| `agent.tool_result` | `{ turn_id, client_id, call_id, message_id, name, summary, output, output_truncation_reason, ..., message }` | After tool execution, including the persisted canonical tool row |
| `agent.message` | `{ turn_id, client_id, message_id, text, message }` | Canonical persisted assistant row after draft streaming has completed |
| `thread.title` | `{ thread_id, title, source, updated_at }` | Best-effort first-message thread title became durable |
| `agent.resync_required` | `{ error, provided_cursor }` | Resume cursor was too old or unknown; client must refetch `/messages` plus `/agent/state` |
| `final` | `{ turn_id, status, message_id?, text? }` or `{ turn_id, status, error }` | Flow complete |

Events are consumed via SSE at `GET /api/threads/:threadId/agent/stream`.

**Reconciliation Notes**:
- `turn_id` groups all live events for one agent turn
- `agent.message_start` / `agent.message_delta` / `agent.message_done` describe a client-side draft, not a persisted transcript row
- `client_id` on `agent.message_start` / `agent.message_delta` / `agent.message_done` matches `/agent/state.draft_assistant.client_id` and the later persisted assistant row
- `call_id` on `agent.tool_call` / `agent.tool_result` matches the persisted tool row `metadata.call_id`
- `client_id` on `agent.tool_call` / `agent.tool_result` matches `/agent/state.pending_tool.client_id` and the later persisted tool row
- tool-result payloads now include a compact `summary` plus an explicit `output_truncation_reason` when the raw output was partial
- `message.message_id` lets clients upsert canonical transcript rows without inventing assistant/tool ids locally
- `message.client_id` is the same stable public identity already exposed on the top-level assistant/tool runtime and stream payloads
- `agent.message` is the canonical persisted assistant row; clients should replace any draft for that `turn_id` when it arrives
- `thread.title` shares the same SSE frame-id cursor space as the agent events, so bounded resume covers title changes without opening a second stream
- `final` still matters for completion status, but successful turns no longer require a mandatory transcript refetch just to learn the assistant/tool row IDs
- replay resume is keyed off the SSE frame `id:` / runtime cursor rather than the JSON payload
- no-cursor attaches are live-only; bounded replay only happens when the client resumes from an explicit cursor
- stale or unknown cursors now surface explicit `agent.resync_required` instead of silent live-only fallback
- runtime state only returns to idle after the final durable state is observable and the runtime cursor has advanced past that completion boundary

## Dependencies

| Import | Purpose |
|--------|---------|
| `../llm/index.js` | Provider registry and canonical types |
| `ulid` | Message ID generation |
| `../db/message-client-id.js` | UUIDv7 generation for persisted message `client_id` values |
| `../db/client.js` | Database access |
| `../db/schema.js` | Table schemas |
| `../runtime/terminal-session-manager.js` | Thread-scoped terminal sessions |
| `../runtime/agent-runtime-state.js` | Agent runtime snapshot + bounded-resume emission |
| `../terminal/types.js` | Readiness hints types |
| `./conversation-loader.js` | Canonical transcript/context assembly |
| `./model-runner.js` | Provider invocation + draft assistant streaming |
| `./terminal-tool-executor.js` | Terminal tool orchestration |
| `./transcript-writer.js` | Durable assistant/tool persistence + runtime emission |
| `./terminal-send-outcome.js` | Send-result delta interpretation for conservative summaries |
| `../db/thread-metadata.js` | Thread activity tracking |

## Configuration Used

From `../config.js`:
- `config.openaiModel` - Model to use (default: `gpt-4.1-mini`)
- `config.agentMaxSteps` - Max tool calls per request (default: 30)
- `config.agentMaxOutputTokens` - Max tokens per response (default: 128000)
- `config.agentReasoningEffortDefault` - Default reasoning effort (default: `none`)
- `config.agentDebug` - Enable debug logging
- `config.agentOpenaiDebug` - Log raw OpenAI responses

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Consider: Move tool definitions to a shared location if multiple agents need them

---

*Referenced by: [../src.spec.md](../src.spec.md)*
