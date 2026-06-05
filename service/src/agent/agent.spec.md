# agent

Agent orchestration layer for AI-assisted terminal interactions using the LLM provider abstraction.

## Purpose

The agent service coordinates AI-assisted terminal interactions. When a user sends a message, it:
1. Builds conversation context from thread history (canonical format)
2. Resolves the current Bud environment for the provider request
3. Calls the LLM provider (OpenAI, Anthropic, direct local ds4, or Bud-local ds4) via `providerRegistry`
4. Executes terminal tool calls on the connected bud daemon, product web-view tool calls through service-side proxied-site routes/helpers, and structured `ask_user_questions` pauses through the thread response route
5. Loops until a final response or max steps reached

## Files

### `index.ts`

Simple barrel export:
```typescript
export { AgentService } from "./agent-service.js";
export { buildContextBudgetSnapshot, getThreadContextBudgetSnapshot } from "./context-budget-snapshot.js";
export { buildContextBudgetDecision, buildContextBudgetStateFromConversation } from "./context-budget-state.js";
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
- define the normalized `terminal.send`, `terminal.observe`, `web_view.*`, and `ask_user_questions` directive unions used across the split agent seams
- centralize readiness defaults plus tool-argument serialization
- expose effective client-facing wait modes for terminal tools (`terminal.send` defaults to `wait_for: "settled"`, `terminal.observe` defaults to `wait_for: "none"`)
- serialize `terminal.send` as exactly one model-facing gesture: `command`, `raw_text`, or `key`
- normalize legacy wait/key inputs reused during transcript replay and model-tool parsing
- keep web-view tool args/result payloads separate from terminal wait/readiness defaults
- keep user-question request/result payloads separate from terminal and web-view result contracts

### `contracts.test.ts`

Direct tests for shared contract helpers.

**Current Coverage**:
- public wait modes parse as themselves
- compatibility-only `shell_ready` remains accepted below the model-facing schema
- legacy `screen_stable` payloads normalize to canonical `settled`
- web-view tool args do not gain terminal `wait_for` defaults
- web-view tool results include HTTP proxy transport plus separate WebSocket proxy capability/transport metadata when available

### `failure-message.ts`

Client-safe non-cancel agent failure formatter.

**Responsibilities**:
- preserve stable error codes when present on provider/data-plane errors
- map local LLM stream-limit and idle-timeout failures to bounded, user-visible copy
- mark retryability from the source error when available, otherwise from known stable codes
- avoid exposing raw provider payloads, daemon transport messages, local URLs, request bodies, or stack traces in browser-visible errors

### `failure-message.test.ts`

Direct coverage for local model stream-limit, local model idle-timeout, and generic fallback sanitization.

### `conversation-loader.ts`

Conversation-building ownership extracted from `AgentService`.

**Responsibilities**:
- seed the canonical system prompt
- load the latest completed context checkpoint and prepend its replacement history after the fresh system prompt
- filter transcript rows and provider-ledger rows after the checkpoint boundary so compacted history is not replayed twice
- load persisted thread messages into canonical provider input order
- load same-provider provider-ledger assistant output blocks when a target provider is known
- derive assistant text phase from provider-ledger payloads or product transcript metadata for OpenAI manual replay
- gate Anthropic reasoning-bearing provider-ledger replay on the current target model and reasoning config
- return reconstruction diagnostics that distinguish provider-native replay, canonical fallback, mixed degraded replay, omitted provider-only items, and provider switches
- include checkpoint diagnostics such as checkpoint id, replacement-history count, and compacted-through boundaries without logging raw summary text
- return same-provider incompatibility diagnostics when Anthropic thinking/redacted-thinking blocks are omitted for canonical fallback
- skip duplicate product assistant rows whose `metadata.llm_call_id` is already represented by provider-ledger output
- normalize historical tool rows, including legacy `terminal.interrupt` replay, web-view tool rows, and `screen_stable` wait values
- preserve user preferred-cwd hints during replay

### `conversation-loader.test.ts`

Direct tests for transcript normalization in the extracted conversation loader.

**Current Coverage**:
- preferred-cwd metadata is appended to user messages
- same-provider reconstruction can prefer durable provider-ledger assistant blocks over product assistant rows
- checkpointed reconstruction uses fresh system prompt, checkpoint replacement history, and post-checkpoint transcript delta
- provider switches are reconstructed through canonical transcript fallback with explicit degradation diagnostics
- persisted legacy interrupt rows replay as canonical `terminal_send` with `key: "ctrl+c"`
- stored `screen_stable` waits replay as canonical `settled`
- the system prompt documents only public `wait_for` modes: `settled`, `changed`, and `none`
- the system prompt scopes `ask_user_questions` to durable, skippable, structured decisions, steers multiple needed questions away from markdown lists, and excludes one-off simple freeform text prompts plus secrets

### `user-question-contracts.ts`

Shared validation and normalization for the `ask_user_questions` tool.

**Responsibilities**:
- define v1 request, response, and tool-result schema constants
- normalize model-supplied question requests into a client-renderable form
- tolerate OpenAI strict-mode `null` values for optional request fields by treating them as omitted
- force every v1 question to be skippable
- validate client responses against the stored request, not client-supplied labels
- build the single structured tool result that repeats each question before each answer
- build a markdown Q/A summary used by restart fallback user messages

### `user-question-contracts.test.ts`

Standalone tests for mixed request normalization, duplicate-id rejection, invalid answer rejection, skipped answers, and self-contained tool-result summaries.

### `user-question-registry.ts`

In-memory waiter registry for live `ask_user_questions` continuations.

**Responsibilities**:
- register one pending response promise per durable question request id
- resolve a live waiter when the authorized response route accepts an answer
- resolve a live waiter with a superseded outcome when a normal follow-up message closes the prompt instead of continuing the old turn
- reject waiting prompts on agent cancel or terminal/service failure cleanup
- let the response route distinguish live continuation from restart fallback

### `user-question-repository.ts`

Persistence and route/service helpers for `agent_question_request`.

**Responsibilities**:
- create durable pending question request rows before exposing prompts to clients
- load owned request rows for a thread/question id pair
- validate and atomically accept client responses with `client_response_id` idempotency
- generate all-skipped responses for follow-up supersession of pending prompts
- persist generated response and tool-result payloads on the request row
- mark pending rows canceled during turn cancellation
- shape completed user-question tool results for transcript persistence

### `user-question-repository.integration.test.ts`

Integration-style repository tests for durable `agent_question_request` acceptance and validation.

**Current Coverage**:
- accepted responses persist status, response payload, generated tool result, idempotency key, and acting user stamp
- duplicate `client_response_id` submissions return idempotent success
- already-answered, canceled, and missing request rows reject with stable request errors
- stored-request validation rejects unknown questions, wrong answer kinds, and unknown choice ids

### `agent-service.ts`

Thin agent orchestrator over the extracted conversation/model/tool/transcript ownership units.

The prompt/tool-definition ownership now lives in the extracted modules:
- `conversation-loader.ts` owns the canonical Bud Agent system prompt used for every turn
- `tool-definitions.ts` owns the canonical `terminal_send`, `terminal_observe`, `web_view_open`, `web_view_close`, `web_view_list`, and `ask_user_questions` JSON Schema definitions passed to providers, the Bud-offline tool-catalog resolver, plus the normal agent-turn tool-schema token estimate

**System Prompt Highlights**:
- tool-calling guidance for `terminal.send` and `terminal.observe`
- product web-view guidance for opening, listing, and closing thread web views
- structured human-question guidance for asking skippable questions only when a normal answer or assumption would be risky
- ask-user policy that batches currently needed decisions, converts multiple questions or long question checklists into `ask_user_questions`, avoids secret collection, treats skipped answers as conservative-assumption opportunities, and reserves normal markdown questions for exactly one simple freeform answer
- readiness confidence interpretation (`>= 0.8` ready, `0.5-0.8` probably ready, `< 0.5` still processing)
- hint interpretation (`looks_like_prompt`, `looks_like_confirmation`, etc.)
- REPL context awareness (Python/Node/Claude Code vs shell)
- settled-by-default `terminal.send` guidance plus explicit `wait_for` usage rules
- direct markdown final-response guidance (no JSON wrapper)

**Canonical Tool Definitions**:

| Tool | Parameters | Description |
|------|------------|-------------|
| `terminal_send` | `command?`, `raw_text?`, `key?`, `observe_after_ms?`, `wait_for?` | Primary terminal input tool for shell commands, multiline shell input, and interactive input, with `command` meaning text plus Enter and a settled-by-default synchronous result |
| `terminal_observe` | `lines?`, `wait_for?`, `view?` | Observe terminal deltas by default, with explicit full-screen/history modes |
| `web_view_open` | `target_port`, `target_host?`, `path?`, `title?` | Create/reuse a Bud-scoped proxied site and attach it to the current thread; omitted `target_host` defaults to `localhost`, and explicit loopback hosts must be preserved exactly |
| `web_view_close` | `proxied_site_id?`, `disable?` | Detach the current thread web view and optionally disable the proxied site |
| `web_view_list` | none | List owned proxied sites for the current Bud and current thread attachment |
| `ask_user_questions` | `title?`, `body?`, `submit_label?`, `skip_all_label?`, `questions[]` | Pause the current turn and ask the owning user skippable structured questions; v1 supports boolean, single-choice, multi-choice, text, and number questions |

Model-facing `wait_for` enums advertise only `none`, `changed`, and `settled`. The lower service/daemon parsers still tolerate compatibility-only `shell_ready` and legacy `screen_stable` where needed for replay and older clients.

When the current agent environment is `bud_offline`, provider calls use a Bud-specific denylist that removes terminal and web-view tools while keeping service-level tools, including `ask_user_questions`, available by default.

#### AgentService Class

**Constructor dependencies**:
- `TerminalSessionManager` (thread-scoped tmux sessions)
- `AgentRuntimeStateManager` (authoritative `/agent/state` snapshots plus bounded agent-stream resume)
- optional `ContextSyncService` for post-terminal-tool snapshot refresh after state-changing tool calls
- logger and debug flags

**Internal collaborators**:
- `AgentConversationLoader`
- `AgentModelRunner`
- `TerminalToolExecutor`
- `WebViewToolExecutor`
- `AgentTranscriptWriter`
- `AgentContextCompactor`
- `AgentCancellationRegistry`
- `AgentUserQuestionRegistry`
- terminal visibility watermark helpers from `terminal/freshness.ts`

**Key methods**:

| Method | Purpose |
|--------|---------|
| `startUserMessage(threadId, options)` | Entry point - seeds active runtime state, captures the resolved Bud environment, then spawns async agent flow while carrying thread-owner stamping plus the resolved model-selection source |
| `runAgentFlow(...)` | Main loop - delegates conversation/model/tool/transcript work across the extracted ownership seams, refreshing Bud environment before provider/tool steps |
| `getEnvironmentForThread(threadId)` / `getEnvironmentForBud(budId)` | Client-safe environment resolvers used by send routes, `/agent/state`, and active turns to distinguish normal vs `bud_offline` mode |
| `submitQuestionResponse(...)` | Validate an owned question response, resolve a live waiter, or persist a fallback user message and start a follow-up turn |
| `supersedePendingUserQuestionsForFollowUp(...)` | Close pending question requests as skipped before a normal follow-up message starts a fresh turn |
| `cancelThread(threadId)` | Abort running agent via AbortController |
| `isThreadActive(threadId)` | Check if thread has active agent run |

**Agent Loop Flow**:
```
startUserMessage()
    └─► runAgentFlow() [async]
           │
           ├─► resolve provider for selected model
           ├─► conversationLoader.load(provider, target model/reasoning)
           ├─► maybe auto-compact pre-turn if active context exceeds the selected model threshold
           │
           └─► LOOP (max steps):
                  │
                  ├─► maybe compact/retry if provider reports context-window overflow
                  ├─► refresh Bud environment
                  ├─► inject transient offline environment instructions when applicable
                  ├─► modelRunner.invokeModel()
                  │
                  ├─► emit agent.message_start / delta / done (text responses only)
                  ├─► update `/agent/state` cursor + draft snapshot in lockstep
                  ├─► persist visible intermediate assistant text when output also contains tools
                  ├─► persist provider output ledger for text/reasoning/tool-call items
                  │
                  ├─► modelRunner.extractToolCalls()
                  │      │
                  │      ├─► tool calls found → for each provider-ordered call:
                  │      │                  └─► transcriptWriter.emitToolCall()
                  │      │                  └─► terminalToolExecutor.execute(), webViewToolExecutor.execute(), or durable ask-user response wait
                  │      │                  └─► transcriptWriter.recordToolResult()
                  │      │                  └─► persist provider tool-result item
                  │      │                  └─► maybe auto-compact mid-turn before the next provider call
                  │      │
                  │      └─► no tool → modelRunner.parseFinalResponse()
                  │                    └─► persist provider output ledger
                  │                    └─► transcriptWriter.recordFinalAssistant()
                  │                    └─► reset `/agent/state` to idle after final durable state
                  │
                  └─► continue or return
```

**Streaming Notes**:
- The agent no longer asks the model to wrap final answers in JSON.
- Provider `invoke()` streams are now the primary path; `AgentService` reconstructs a `CanonicalResponse` from provider text/tool/reasoning events.
- Draft assistant text is emitted live over SSE via `agent.message_start`, `agent.message_delta`, and `agent.message_done`.
- Visible assistant text in a response that also contains tool calls is now persisted as an intermediate assistant transcript row before tool execution and emitted as `agent.message`.
- Final persisted assistant rows are still emitted as `agent.message` once the turn resolves.
- OpenAI assistant text is replayed with canonical `assistantPhase`: provider-returned phase wins, pre-tool text falls back to `commentary`, and final no-tool text falls back to `final_answer`.
- Assistant product rows persist `metadata.assistant_phase` (`commentary` for intermediate segments, `final_answer` for final rows) so canonical fallback can preserve OpenAI replay semantics.
- Assistant/tool `client_id` values are now allocated before the first live runtime/SSE event that refers to them, and the persisted assistant/tool rows reuse those same values at insert time.
- Assistant rows are stamped with cached terminal cwd `path_context` when available; terminal tool rows are stamped with `path_context_before` and `path_context_after`.
- Reasoning blocks are preserved in the provider ledger and then reconstructed for same-provider future calls, so reasoning continuity is no longer only in memory.
- Anthropic thinking and redacted-thinking blocks are replayed provider-natively only when the next Anthropic model/reasoning request is compatible; incompatible same-provider ranges fall back to canonical visible transcript rows with explicit degradation metadata.
- Multiple provider tool calls are parsed and executed serially in provider output order across terminal and web-view tools.
- `ask_user_questions` tool calls are normalized and persisted before `agent.tool_call` is emitted; live answers resolve the waiter and continue the same provider tool-call loop, answers submitted after a service restart become a self-contained follow-up user message, and normal follow-up messages close pending prompts as skipped before starting a fresh turn.
- While waiting on `ask_user_questions`, `/agent/state.phase` is `waiting_for_user` and `/agent/state.pending_tool` exposes the normalized request with `request_id`.
- Follow-up supersession records a skipped `ask_user_questions` tool result, emits `final` with `status: "succeeded"` and `reason: "superseded_by_user_message"`, and returns from the old turn without another provider call.
- Conversation reconstruction diagnostics are logged when degraded and persisted on each `llm_call.cache_metadata`, making provider switches distinguishable from cache misses or missing same-provider ledger ranges.
- Automatic context compaction is service-owned and invisible to the visible transcript. When estimated model-visible context exceeds the selected model threshold, the agent emits `agent.compaction_start`, writes an `agent_context_checkpoint` row, emits `agent.compaction_done` with an optional post-compaction `context_budget`, reloads context from fresh system prompt plus checkpoint replacement history, and continues the turn. A per-turn boundary guard avoids writing duplicate checkpoints for the same replay cutoff.
- Automatic compaction decisions write the latest client-safe context budget into runtime state and log sanitized budget diagnostics, including skipped decisions, the active estimate basis, threshold, ratio, model, provider, snapshot provenance, and replay-boundary duplicate suppression without logging message contents, checkpoint summaries, or provider request bodies.
- Failed automatic compaction emits `agent.compaction_failed` with a sanitized error code and retryability flag; raw checkpoint summaries, replacement histories, provider requests, and provider error messages are never exposed on the stream.
- If a provider returns a normalized context-window error, the agent attempts one forced compaction/retry while the automatic-compaction kill switch is enabled. If compaction cannot recover, the turn fails clearly instead of silently dropping transcript history.
- Non-cancel agent failures are formatted through `failure-message.ts`, emitted on `final(status: "failed")` with sanitized `error`, `error_code`, and `retryable`, and stored in runtime `/agent/state.last_error`; they are not persisted as transcript rows and are not replayed to future model calls.
- Empty final responses now fail with a structured diagnostic error that includes the canonical response and any provider completion payload attached by the LLM adapter, so normal agent failure logs show the model result without requiring the OpenAI debug flag.
- OpenAI debug response logging emits `llm_response` as a structured canonical response object rather than a pre-stringified JSON blob, so log viewers can pretty-print nested fields without escaped newline formatting.
- `startUserMessage()` now allocates the turn id and seeds `/agent/state` before terminal session ensure returns, so clients can bootstrap with a resumable cursor even before the first visible event; turn startup, explicit question responses, follow-up supersession, and cancel use a short per-thread transition guard for state handoffs.
- If the resolved environment is `bud_offline`, startup skips context sync, path context, and terminal ensure, then runs the provider with a request-time offline instruction plus the Bud-specific tool denylist. The user message still succeeds so the assistant can explain recovery or ask follow-up questions without terminal/web-view tools.
- Active turns refresh the Bud environment before provider calls and before Bud-specific tool dispatch, allowing a reconnect during a turn to restore normal tool availability on a later step.
- Normal online provider calls no longer inject terminal freshness notes because toggling a transient top-of-context system message disrupts prompt-cache reuse for local providers such as ds4. The agent can still call `terminal.observe` explicitly when current terminal output, readiness, or cwd matters.
- Terminal tool rows still persist `message.metadata.terminal_visibility` watermarks so a future append-only freshness prompt can be reintroduced without losing visibility state.
- Agent SSE frame ids are now the same opaque runtime cursors used by `/agent/state.stream_cursor`.
- `terminal.send` summaries are now evidence-based rather than optimistic: the agent uses the settled/default result or timeout delta and avoids claiming program progress when no visible delta appears.
- `terminal.send` is now modeled as one gesture at a time: `command` for text plus Enter, `raw_text` for literal text without implicit Enter, or one semantic `key` such as `ctrl+c`.
- historical persisted `terminal.send` rows with `text`/`submit` and `terminal.interrupt` rows are normalized during replay into the current `terminal_send` shape, so old transcripts still round-trip through the current provider/tool format.
- `terminal.observe` guidance now steers the model toward `wait_for: "settled"` instead of the older `screen_stable` mental model, and replay normalization maps any older `screen_stable` tool payloads to `settled`.
- `terminal.observe` now defaults to `view: "delta"` and exposes `view: "screen"` / `view: "history"` only when the model explicitly needs broader context.
- model-facing terminal tool schemas no longer advertise `timeout_ms`; the service owns effective timeout policy and ignores legacy model-supplied timeout values during normal agent tool execution.
- model-facing terminal tool schemas no longer advertise compatibility-only `shell_ready`; the public `wait_for` set is `none`, `changed`, and `settled`.
- settled `terminal.send` and `terminal.observe(wait_for: "settled")` requests now receive the one-hour service-owned wait budget before dispatching to Bud, while non-settled modes keep shorter budgets.
- client-facing tool-call args now include the effective `wait_for` mode even when the model omitted it, so web/mobile can detect settled terminal waits directly from `agent.tool_call.args` or `/agent/state.pending_tool.args`.
- client-facing `terminal.send` tool-call args now expose `command`, `raw_text`, or `key`, not the lower-level Bud `text`/`submit` wire shape.
- human terminal interrupts reject the currently pending terminal wait as `interrupted`; `TerminalToolExecutor` turns that into a conservative tool result with `readiness.trigger: "error"` so the model regains control without treating the original command as completed.
- model-facing tool-result payloads now center on readiness, context, additive `delta` content, and explicit `terminal.send` gesture metadata (`input_dispatched`, `command_sent`, `raw_text_sent`, `key_sent`, `enter_requested`) instead of relying on `submitted` alone.
- terminal tool rows persist `message.metadata.terminal_visibility` with the model-visible output byte watermark, cwd, readiness version, timestamp, session id, and source (`terminal_send` or `terminal_observe`); the canonical tool `message.content` remains the replay payload and does not include this metadata-only watermark.
- `context_after.source` now distinguishes observed shell return from inferred REPL/session tracking so the model can treat inferred context as a hint rather than proof.
- `web_view.open`, `web_view.close`, and `web_view.list` are product-level tools backed by owner-scoped proxied-site helpers; they do not expose viewer grants, cookies, or daemon stream ids to the model.
- `web_view.open` keeps `target_host` optional for simple port-only requests, but the model-facing schema and prompt define the omitted-host default as `localhost` and instruct the model to preserve explicit user-provided `localhost`, `127.0.0.1`, or `::1` hosts exactly.
- web-view tool payloads now include `websocket_transport` and `capabilities.websocket` so the model/client can distinguish static HTTP preview support from full WebSocket/HMR support.
- web-view tool summaries now explicitly call out whether static HTTP preview is available separately from WebSocket/HMR support, including offline/unsupported transport messages when either carrier family is unavailable.
- the main `AgentService` file now delegates conversation loading, model invocation, terminal tool execution, and transcript persistence/runtime emission to dedicated modules instead of bundling those concerns inline

### `web-view-tool-executor.ts`

Product web-view tool execution ownership extracted from `AgentService`.

**Responsibilities**:
- resolve the owning thread/Bud/user before any web-view mutation
- run `web_view.open`, `web_view.close`, and `web_view.list`
- create/reuse owner-private `proxied_site` rows and attach them through `thread_web_view`
- detach thread web views by default and only disable proxied sites when explicitly requested
- shape tool summaries and persisted payloads without exposing viewer grants, cookies, or daemon stream ids
- include separate WebSocket proxy transport/capability metadata in tool payloads
- phrase `web_view.open` and `web_view.list` summaries as static HTTP vs WebSocket/HMR availability rather than treating all proxied sites as equivalent
- map proxy transport failures, including Bud disconnects, into retryable structured tool results instead of failing the whole agent turn

### `terminal-send-outcome.ts`

Small helper module for interpreting `terminal.send` evidence.

**Responsibilities**:
- derive send acceptance states from the settled/default send result delta
- derive optional next-step state from acceptance, readiness, and observed/inferred context
- build direct tool summaries such as "Send ...; no visible delta observed"
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
- `cancelThread()` aborts the active turn, rejects any pending terminal waits for that thread, and marks pending user-question rows canceled
- final no-tool responses record exactly one provider-ledger `llm_call` row before final assistant persistence
- automatic compaction emits sanitized runtime start/done/failure events and advances the runtime stream cursor for resume

### `ask-user-questions-continuation.integration.test.ts`

Integration-style tests for `AgentService.submitQuestionResponse(...)` and the live/fallback continuation boundary.

**Current Coverage**:
- accepted live responses resolve the in-memory question waiter
- follow-up supersession resolves a live waiter as skipped and waits for the old turn closeout callback
- fallback responses after a missing live waiter persist a self-contained user message and start a follow-up agent turn
- scoped fake OpenAI provider registration covers the default `gpt-5.5` model path in continuation tests
- cancel while waiting rejects pending question waiters and marks durable pending question rows canceled

### `tool-definitions.ts`

Canonical normal-agent tool schema registry shared by provider invocation and context-budget accounting.

**Exports**:
- `AGENT_CANONICAL_TOOLS` - the JSON Schema tool definitions passed to providers for ordinary agent turns
- `resolveAgentToolsForEnvironment(environment)` - filters provider tools for the current Bud environment, using a Bud-specific denylist in offline mode so future non-Bud service tools remain available by default
- `AGENT_TOOL_SCHEMA_TOKENS` - model-agnostic estimate of those serialized tool schemas, included in normal agent-turn context budgets

Compaction-summary calls intentionally do not use these normal-agent tools and therefore do not add `AGENT_TOOL_SCHEMA_TOKENS` to their temporary summary budget.

### `environment.ts`

Client-safe agent environment helpers.

**Responsibilities**:
- define `normal` vs `bud_offline` agent environment snapshots
- expose tool availability for terminal, web-view, and `ask_user_questions` in `/agent/state`
- build request-time offline instructions that are injected into provider calls without becoming transcript rows

### `model-runner.ts`

Model invocation ownership extracted from `AgentService`.

**Responsibilities**:
- resolve provider/model aliases for the selected request model
- resolve model-specific reasoning through `llm/reasoning-policy.ts`, using catalog defaults and rejecting unsupported combinations before provider invocation
- cap provider request `maxOutputTokens` to the lower of
  `config.agentMaxOutputTokens` and the selected model/provider capability,
  using product-model capabilities before provider-model fallback
- optionally capture local model-context drift prompt/response snapshots, plus provider-rendered request snapshots when supported and enabled, when `AGENT_CONTEXT_DRIFT_DEBUG=true`
- consume provider `invoke()` streams and emit draft assistant runtime events
- pass thread/Bud/owner invocation context into environment-scoped providers
  such as Bud-local ds4 while leaving cloud providers free to ignore it
- reconstruct canonical responses and normalize provider tool-call payloads
- keep text blocks before and between tool calls in canonical output order
- expose all parsed tool calls through `extractToolCalls()` while retaining `extractToolCall()` as a first-call compatibility helper
- throw structured `AgentModelResponseError` diagnostics when a completed response cannot be parsed into final text or a tool call

### `model-runner.test.ts`

Direct tests for the extracted model runner.

**Current Coverage**:
- reasoning-effort normalization follows selected model policy, including Claude 4.6/4.7 and GPT-5.4 differences
- terminal tool schemas advertise only public `wait_for` modes and omit `timeout_ms`
- web-view tool schemas advertise product-level `web_view_open`, `web_view_close`, and `web_view_list`
- user-question tool schema advertises `ask_user_questions` with skippable question kinds and no hard question-count cap
- offline environment tool resolution removes Bud-specific terminal/web-view tools while preserving service-level tools such as `ask_user_questions`
- user-question request normalization treats strict-mode `null` optionals as omitted
- streamed text blocks around multiple tool calls are retained in provider order
- legacy `keys` arrays normalize into canonical semantic key strings during tool-call parsing
- web-view tool calls parse into product `web_view.*` directives
- user-question tool calls parse into normalized `ask_user_questions` directives
- malformed user-question tool payloads fail closed before client-visible prompts are emitted
- empty final responses include bounded canonical/provider response diagnostics on the thrown error
- injected context-drift recorders receive prompt capture data before provider invocation and response capture data after canonical response reconstruction

### `model-context-drift-recorder.ts`

Local-only model context drift instrumentation for comparing consecutive provider inputs.

**Responsibilities**:
- activate only when the service is started with `AGENT_CONTEXT_DRIFT_DEBUG=true`
- load optional JSON settings from `.bud-debug/model-context-drift.config.json`
- write redacted-by-default prompt snapshots, response snapshots, and markdown diffs under per-thread `.bud-debug/model-context-drift/thread_*` directories with sequence numbers scoped to each thread
- optionally write provider-rendered request snapshots such as selected ds4 endpoint bodies when `providerRenderedSnapshots` is enabled in local JSON config
- compare consecutive canonical model contexts for append-only continuity, message drift, tool-schema drift, model-config drift, and prior response replay continuity
- log sanitized drift summaries without raw prompt text unless local config explicitly enables full text in artifacts
- support optional thread/provider/model filters from the JSON config without adding more env vars

### `model-context-drift-recorder.test.ts`

Standalone tests for local drift instrumentation.

**Current Coverage**:
- default config loading when no local JSON config exists
- invalid local JSON config disables recorder creation safely
- full prompt text is omitted by default while bounded previews remain available
- semantic hashes ignore object key order while exact hashes preserve order
- prompt, response, and append-only diff artifacts are written for a tool-call continuation
- provider-rendered request artifacts are written only when the local config enables them
- artifact sequence numbers restart per thread directory
- provider filters skip non-matching captures without creating artifact directories

### `terminal-tool-executor.ts`

Terminal tool execution ownership extracted from `AgentService`.

**Responsibilities**:
- resolve/ensure the thread terminal session before tool execution
- run `terminal.observe` and `terminal.send`
- adapt model-facing `terminal.send.command` / `rawText` / `key` directives into the current Bud `terminal_send{text|key, submit?}` wire frame
- derive readiness/context-after snapshots from runtime state plus observed shell evidence
- shape conservative tool summaries and persisted tool payloads
- map user-triggered `interrupted` terminal waits into normal tool results with `error: "interrupted"` and conservative readiness
- map Bud transport failures into structured retryable tool results, including canonical `BUD_DISCONNECTED` codes for offline/disconnected cases

### `terminal-tool-executor.test.ts`

Direct tests for the extracted terminal tool executor.

**Current Coverage**:
- interrupt-style `terminal.send` remains conservative when no visible delta is observed
- command and raw-text gestures map to the expected Bud wire `text`/`submit` combinations
- user-interrupted pending send/observe waits return conservative tool results instead of failing the agent turn
- ambiguous mixed terminal-send gestures fail before touching the terminal runtime
- terminal transport failures return structured retryable tool results instead of throwing out of the agent turn

### `transcript-writer.ts`

Transcript persistence and runtime-emission ownership extracted from `AgentService`.

**Responsibilities**:
- emit `agent.tool_call` and synchronize `/agent/state.pending_tool`, including the tool `started_at` timestamp and effective client-facing terminal `wait_for` args
- set `/agent/state.phase` to `waiting_for_user` for pending `ask_user_questions` tool calls
- persist assistant/tool transcript rows with stable `client_id`
- persist intermediate assistant text segments that precede or appear between tool calls
- persist assistant phase metadata for intermediate and final assistant rows so OpenAI replay fallback can recover it
- stamp thread attention metadata for final attention-worthy assistant output
- enqueue durable push-outbox rows for final assistant output when the owning user has mobile push registrations
- add authoritative tool timing to canonical tool `message.metadata` while keeping replayed tool `message.content` timing-free
- add the resolved `model`, `reasoning_effort`, and `model_selection_source` to assistant/tool `message.metadata`
- add cached cwd path context to assistant rows and before/after path context to terminal tool rows
- add metadata-only terminal visibility watermarks to terminal tool rows for later freshness decisions
- emit web-view tool results with a `web_view` runtime payload instead of terminal `output` / `readiness` fields
- emit user-question tool results with a `user_questions` runtime payload instead of terminal `output` / `readiness` fields
- emit `agent.tool_result`, `agent.message`, and `final` after durable writes
- advance runtime cursors only after the durable transcript boundary is visible

**Reasoning Effort Support**:

`AgentModelRunner` delegates selected-model reasoning validation to the LLM catalog policy. Current first-party levels include:
- OpenAI GPT-5.4/GPT-5.5: `none`, `low`, `medium`, `high`, `xhigh`
- Anthropic Opus 4.6/Sonnet 4.6: `low`, `medium`, `high`, `max`
- Anthropic Opus 4.7: `low`, `medium`, `high`, `xhigh`, `max`
- Anthropic Haiku 4.5: `none`, `low`, `medium`, `high`
- ds4 DeepSeek V4 direct local-dev path: `none`

Omitted `reasoning_effort` uses the selected model's catalog default, not the global env default.

Thread/message routes now resolve the effective thread selection before starting the agent, so normal turns enter `AgentService.startUserMessage(...)` with a concrete model, reasoning effort, and source (`explicit_request`, `thread`, or `service_default`). Assistant and tool rows persist that selection metadata for later debugging and client reconciliation.

**Cancellation**:

`AgentService` now delegates per-thread `AbortController` ownership to `AgentCancellationRegistry`, and explicit cancel also rejects any pending terminal wait through `TerminalSessionManager.rejectPendingRequestsForThread(...)`, rejects pending `ask_user_questions` waiters, and marks durable pending question requests canceled.

Human terminal interrupt is intentionally separate from agent cancel: the terminal route sends `ctrl+c` and rejects the current terminal wait as `interrupted`, allowing the active agent turn to record a tool result and continue.

**Follow-Up Supersession**:

Normal `POST /api/threads/:threadId/messages` calls ask `AgentService` to close all pending `ask_user_questions` rows for the thread after duplicate `client_id` checks and before the new user row is persisted. The generated response marks every question skipped with `skip_reason: "user_skipped"`. Live waiters finish the old turn with a skipped tool result and a successful `final` event carrying `reason: "superseded_by_user_message"`; stale durable rows are closed and get a canonical tool row when enough metadata is available.

**Ownership Notes**:
- `startUserMessage(..., { ownerUserId })` threads the resolved thread owner through the agent loop
- assistant final messages and tool-result messages are written with `message.created_by_user_id`
- lazily created terminal sessions inherit the same owner via `ensureSessionRecordForThread(..., ownerUserId)`
- web-view tools use the owning thread user to create/list/attach/detach `proxied_site` and `thread_web_view` rows
- question request rows inherit the owning thread user in `agent_question_request.created_by_user_id`; response submissions authorize the thread before reading or accepting the request

### `transcript-writer.test.ts`

Direct tests for transcript-writer persistence and stream emission boundaries.

**Current Coverage**:
- tool timing is emitted on `agent.tool_call` / `agent.tool_result`
- intermediate assistant text segments persist with `segment_kind` / `llm_call_id` metadata and emit `agent.message` without finalizing the turn
- emitted intermediate assistant `agent.message` payloads include the serialized commentary phase metadata
- canonical tool `message.metadata` receives timing fields while `message.content` remains the timing-free replay payload
- canonical assistant/tool rows receive cached cwd path context metadata when available
- terminal tool rows can persist metadata-only `terminal_visibility` watermarks without changing replay content
- pending `ask_user_questions` tool calls set runtime state to `waiting_for_user`
- completed `ask_user_questions` results persist Q/A payload rows and emit `user_questions` runtime data

### `context-checkpoint-repository.ts`

Service-only repository for durable agent context checkpoints.

**Responsibilities**:
- load the latest completed checkpoint for a thread
- record completed and failed checkpoint attempts
- store canonical replacement history outside the visible `message` transcript
- resolve thread owner/tenant stamps for automatic checkpoint writes
- capture compacted-through message and provider-ledger boundaries
- bound failed-attempt error diagnostics so provider request bodies and credentials are not stored

### `context-checkpoint-repository.test.ts`

Standalone tests for checkpoint normalization and ownership/boundary stamping.

### `context-budget.ts`

Token-estimation helper for automatic compaction and browser-visible context budget reporting.

**Responsibilities**:
- estimate canonical message tokens using a conservative character-based fallback
- estimate canonical tool-schema tokens from serialized `CanonicalTool[]` definitions
- resolve the selected model's catalog hard context window, Bud usable context
  window, output reserve, and usable input window
- default `reservedOutputTokens` to `maxOutputTokens` unless a catalog entry
  overrides it
- apply automatic-compaction enablement and ratio configuration, clamped to
  `0.95`
- expose request-kind budget semantics so normal agent turns use the proactive
  threshold while compaction-summary calls can use the larger usable input window
- decide whether a candidate provider request should compact before invocation

### `context-budget.test.ts`

Direct tests for usable context policy and automatic-compaction threshold math.

**Current Coverage**:
- default usable-context/output-reserve derivation from model catalog entries
- GPT-5.5 usable input threshold at the `0.95` clamp
- lower `AGENT_AUTO_COMPACTION_RATIO` overrides, including the 40% test path
- compaction-summary requests using the larger usable input window
- invalid context policy detection when output reserve exceeds usable window
- serialized canonical tool-schema estimates used by normal agent-turn budgets

### `context-budget-snapshot.ts`

Browser-facing context budget snapshot builder used by the owned `/agent/state` route.

**Responsibilities**:
- resolve the thread's effective model/reasoning selection and selected-model compaction budget
- load context through `AgentConversationLoader` using the same latest completed checkpoint boundary as the agent loop
- delegate primary budget math to `context-budget-state.ts` so durable snapshots and active compaction decisions agree
- include the normal agent tool-schema estimate by default so durable snapshots match provider requests for ordinary agent turns
- expose hard model window, Bud usable context window, output reserve, usable
  input window, compaction threshold, and effective budget fields
- expose the effective budget as the auto-compaction threshold when compaction
  is enabled, or the usable input window when compaction is disabled
- load the latest same-provider completed `llm_call.usage` anchor after the checkpoint boundary and add estimated delta messages after that call as optional provider diagnostics
- include both provider input and output tokens from the usage anchor because output tokens are part of the visible conversation before the next request
- keep `estimated_input_tokens` and `percent_of_context_budget` aligned with the backend trigger estimate rather than provider diagnostics, with `message_estimated_tokens` and `tool_schema_tokens` exposing the current split
- return an `unknown` snapshot instead of failing `/agent/state` when model-window metadata is missing, context policy is invalid, or counting fails
- mark snapshots stale while an agent turn is active so clients can avoid treating them as live intra-turn telemetry

### `context-budget-state.ts`

Shared context budget state builder for active agent decisions and durable agent-state snapshots.

**Responsibilities**:
- build client-safe available/unknown context budget snapshots from resolved `ContextBudget` plus `CanonicalMessage[]`
- keep the primary estimate on the model-agnostic canonical-message estimator plus normal agent tool-schema overhead used by the automatic compaction trigger
- expose provenance fields (`source`, `phase`, `reason`, `turn_id`, `checked_at`) so clients can distinguish durable reconstruction, active decisions, and post-compaction snapshots
- expose `message_estimated_tokens` and `tool_schema_tokens` alongside total `estimated_input_tokens`
- attach optional provider usage diagnostics without letting those diagnostics drive compaction threshold percentages
- return `{ snapshot, shouldCompact, estimatedTokens }` for agent compaction decisions without exposing raw conversation content

### `context-budget-snapshot.test.ts`

Direct tests for snapshot math and fallback behavior.

**Current Coverage**:
- unknown model context windows return an `unknown` snapshot
- disabled compaction uses the usable input window as the effective budget
- invalid context policy returns an `unknown` snapshot
- provider-usage diagnostics include output tokens but do not change primary budget math
- provider-usage diagnostics above threshold do not make the primary percent exceed the backend trigger estimate
- normal agent tool-schema overhead contributes to `estimated_input_tokens`
- checkpoint ids and stale state are carried into the snapshot

### `context-compactor.ts`

Local summary compaction collaborator used by `AgentService`.

**Responsibilities**:
- call the selected LLM provider with no tools and a fixed checkpoint-summary prompt
- build replacement history from a checkpoint summary note, recent real user messages, and optional current terminal context
- persist completed and failed checkpoint rows
- trim the temporary compaction request against the model's usable input window
  rather than the normal proactive auto-compaction threshold
- retry provider context-window errors by trimming the temporary compaction request while preserving tool-use/tool-result pairs where possible
- keep summaries and replacement history out of normal browser transcript routes

### `thread-title-service.ts`

Best-effort thread-title generation for the first durable user message.

**Responsibilities**:
- confirm the just-written user row is still the canonical first user message on the thread
- use Anthropic `claude-haiku-4-5` as the only title-generation model
- wrap the first user message as quoted text to summarize so the title model does not answer or follow instructions inside it
- sanitize the model output into a plain-text title
- persist the title with a conditional `thread.title IS NULL` update
- emit `thread.title` on the existing agent SSE channel and advance the shared runtime cursor

**Notes**:
- runs fire-and-forget after `AgentService.startUserMessage(...)` succeeds, so the assistant turn is never blocked on title generation
- if the Anthropic provider is not configured, Haiku is unavailable, the model times out, model output is invalid, or another request wins the conditional update first, the thread simply keeps its existing title state
- logs eligibility skips, unavailable Haiku, model title candidates, invalid generated output with a bounded Haiku response summary, conditional update misses, and successful persistence under the `thread_title` component
- preserves line breaks from the Haiku response before normalization so a valid first-line title can survive even if the model continues with extra text
- normalization now accepts any non-empty cleaned model title rather than rejecting 1-2 word outputs, so concise titles like `Bugfix` or `Assistant Introduction` persist as-is
- the emitted payload is `{ thread_id, title, source, updated_at }`, where `source` is currently `generated_first_user_message`
- streamed title reconstruction now updates the active text block through a locally narrowed `text` reference so canonical non-text blocks remain type-safe during `tsc`

### `thread-title-service.test.ts`

Standalone Node tests for title normalization, Anthropic-Haiku-only model selection, provider-less handling, and streamed title text accumulation.

**Current Coverage**:
- generated titles strip labels and trailing punctuation
- longer descriptive titles remain intact
- short 1-2 word titles remain valid
- title output uses the first response line before any extra model continuation
- the original first user message is wrapped as text to summarize instead of forwarded as a direct instruction
- title model selection requires configured Anthropic Haiku 4.5 and does not fall back to OpenAI-only availability
- provider-less and Anthropic-less title generation returns `null` instead of throwing
- streamed title-response collection keeps accumulating `text_delta` chunks through a narrowed text block instead of widening back to the full canonical content union

## Events Emitted

Via `AgentRuntimeStateManager`, using `threadId` as the channel:

| Event | Data | When |
|-------|------|------|
| `agent.message_start` | `{ turn_id, client_id }` | First visible assistant-text chunk for a turn |
| `agent.message_delta` | `{ turn_id, client_id, delta }` | Incremental assistant-text append |
| `agent.message_done` | `{ turn_id, client_id, text }` | Draft assistant text complete, before canonical persistence |
| `agent.tool_call` | `{ turn_id, client_id, call_id, name, args, started_at }` | Before executing tool |
| `agent.tool_result` | `{ turn_id, client_id, call_id, message_id, name, summary, output, output_truncation_reason, started_at, finished_at, duration_ms, ..., message }` | After tool execution, including the persisted canonical tool row |
| `agent.message` | `{ turn_id, client_id, message_id, text, message }` | Canonical persisted assistant row after draft streaming has completed |
| `agent.compaction_start` | `{ turn_id, trigger, reason, phase, tokens_before, threshold_tokens, context_window_tokens, usable_context_window_tokens, reserved_output_tokens, usable_input_window_tokens, effective_budget_tokens, started_at }` | Automatic context compaction begins |
| `agent.compaction_done` | start payload plus `{ checkpoint_id, tokens_after, finished_at, context_budget? }` | Completed context checkpoint is persisted; optional context budget is the post-compaction snapshot |
| `agent.compaction_failed` | start payload plus `{ error_code, retryable, finished_at }` | Context checkpoint attempt failed and the failure was recorded when possible |
| `thread.title` | `{ thread_id, title, source, updated_at }` | Best-effort first-message thread title became durable |
| `agent.resync_required` | `{ error, provided_cursor }` | Resume cursor was too old or unknown; client must refetch `/messages` plus `/agent/state` |
| `final` | `{ turn_id, status, message_id?, text?, reason? }` or `{ turn_id, status, error, error_code?, retryable? }` | Flow complete |

Events are consumed via SSE at `GET /api/threads/:threadId/agent/stream`.

**Reconciliation Notes**:
- `turn_id` groups all live events for one agent turn
- `agent.message_start` / `agent.message_delta` / `agent.message_done` describe a client-side draft, not a persisted transcript row
- `client_id` on `agent.message_start` / `agent.message_delta` / `agent.message_done` matches `/agent/state.draft_assistant.client_id` and the later persisted assistant row
- `call_id` on `agent.tool_call` / `agent.tool_result` matches the persisted tool row `metadata.call_id`
- `client_id` on `agent.tool_call` / `agent.tool_result` matches `/agent/state.pending_tool.client_id` and the later persisted tool row
- `/agent/state.pending_tool.started_at` matches `agent.tool_call.started_at`, so reconnecting clients can show elapsed time for long pending waits
- `/agent/state.pending_tool.args.wait_for` and `agent.tool_call.args.wait_for` expose the effective terminal wait mode, including implicit `terminal.send` settled waits and implicit `terminal.observe` non-waits
- `/agent/state.pending_tool.args` and `agent.tool_call.args` expose the model-facing `terminal.send` gesture fields (`command`, `raw_text`, or `key`) rather than the Bud wire `text`/`submit` fields
- web-view pending/tool-call args expose only product fields such as `target_port`, `path`, `proxied_site_id`, and `disable`
- user-question pending/tool-call args expose the normalized `ask_user_questions_request_v1` payload, including `request_id`, labels, and skippable question definitions
- omitted `web_view.open.target_host` means `localhost`; when present, `target_host` is the exact loopback host the model requested
- `started_at` on `agent.tool_call` is the service-side tool-start timestamp captured immediately before execution begins
- tool-result payloads now include a compact `summary` plus an explicit `output_truncation_reason` when the raw output was partial
- terminal-send tool-result payloads include `input_dispatched`, `command_sent`, `raw_text_sent`, `key_sent`, and `enter_requested` alongside the legacy low-level `submitted` dispatch acknowledgement
- tool-result payloads now also include authoritative `started_at`, `finished_at`, and `duration_ms` values derived in the service agent loop
- web-view tool-result payloads include `web_view` data instead of terminal readiness/output fields
- user-question tool-result payloads include `user_questions` data with the structured `ask_user_questions_tool_result_v1` result and Q/A summary
- canonical persisted tool rows expose the same timing fields under `message.metadata`, while `message.content` remains the replay payload and intentionally does not gain timing-only fields
- canonical persisted terminal tool rows may expose `path_context_before` / `path_context_after` under `message.metadata`; assistant rows may expose `path_context`
- `message.message_id` lets clients upsert canonical transcript rows without inventing assistant/tool ids locally
- `message.client_id` is the same stable public identity already exposed on the top-level assistant/tool runtime and stream payloads
- `agent.message` is the canonical persisted assistant row; clients should replace any draft for that `turn_id` when it arrives
- `agent.message` may represent an intermediate visible text segment before later tool calls; successful final turn status still arrives separately as `final`
- `agent.compaction_*` events are live activity markers only and do not correspond to persisted transcript rows
- compaction event payloads expose token counts, phase, reason, checkpoint id on success, optional post-compaction context budget, and sanitized failure metadata; they intentionally exclude raw summaries and replacement history
- `thread.title` shares the same SSE frame-id cursor space as the agent events, so bounded resume covers title changes without opening a second stream
- `final` still matters for completion status, but successful turns no longer require a mandatory transcript refetch just to learn the assistant/tool row IDs
- superseded question turns may emit successful `final` events with `reason: "superseded_by_user_message"` and no assistant `message_id` or `text`
- failed `final` events use sanitized browser-visible error text plus stable `error_code` and `retryable`; the same payload is exposed as `/agent/state.last_error` until the next turn starts
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
| `../terminal/freshness.js` | Terminal visibility watermark helpers for terminal tool rows |
| `./conversation-loader.js` | Canonical transcript/context assembly |
| `./context-budget.js` | Automatic compaction budget estimates and thresholds |
| `./context-budget-state.js` | Shared client-safe budget snapshot and compaction-decision builder |
| `./context-budget-snapshot.js` | Browser-facing context budget snapshots for `/agent/state` |
| `./context-checkpoint-repository.js` | Durable checkpoint persistence and replay-boundary lookup |
| `./context-compactor.js` | Local summary compaction and replacement-history construction |
| `./failure-message.js` | Client-safe agent failure formatting for runtime/UI error surfacing |
| `./model-runner.js` | Provider invocation + draft assistant streaming |
| `./model-context-drift-recorder.js` | Local-only model-context drift snapshots and canonical diff artifacts |
| `./tool-definitions.js` | Normal agent tool schema registry and tool-schema token estimate |
| `./terminal-tool-executor.js` | Terminal tool orchestration |
| `./web-view-tool-executor.js` | Product web-view tool orchestration |
| `./transcript-writer.js` | Durable assistant/tool persistence + runtime emission |
| `./terminal-send-outcome.js` | Send-result delta interpretation for conservative summaries |
| `./user-question-contracts.js` | `ask_user_questions` request/response/result validation and summary building |
| `./user-question-registry.js` | Live `ask_user_questions` waiter resolution and supersession callbacks |
| `./user-question-repository.js` | Durable `agent_question_request` persistence, response acceptance, and generated skipped closeouts |
| `../db/thread-metadata.js` | Thread activity tracking |

## Configuration Used

From `../config.js`:
- `config.defaultModel` - Product model to use when requests omit `model` (default: `gpt-5.5`)
- `config.agentMaxSteps` - Max tool calls per request (default: 30)
- `config.agentMaxOutputTokens` - Global upper bound for response tokens before selected-model capability caps are applied (default: 128000)
- `config.agentReasoningEffortDefault` - Compatibility fallback for non-catalog model overrides (default: `low`)
- `config.agentAutoCompactionEnabled` - Enables automatic context compaction (default: enabled)
- `config.agentAutoCompactionRatio` - Usable-input threshold ratio for automatic compaction, clamped to at most `0.95`
- `config.agentDebug` - Enable debug logging
- `config.agentOpenaiDebug` - Log raw OpenAI responses
- `config.agentContextDriftDebug` - Enable local-only model context drift artifact capture under `.bud-debug/`

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Consider: Move tool definitions to a shared location if multiple agents need them

<!-- SPEC:TODO -->
- `human_input_requested` attention is designed into the notification schema/routes, but attention stamping/push enqueue for `ask_user_questions` prompts is deferred until the prompt visibility/read-watermark boundary is finalized.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
