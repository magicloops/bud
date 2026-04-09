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
export { ThreadTitleService, normalizeGeneratedThreadTitle } from "./thread-title-service.js";
```

### `agent-service.ts`

Main agent implementation (~1,400 lines).

#### System Prompt (Lines 64-127)

Defines agent behavior as "Bud Agent" with:
- Tool calling guidelines (when to use each tool)
- Readiness confidence interpretation (≥0.8 ready, 0.5-0.8 probably ready, <0.5 still processing)
- Hint interpretation (`looks_like_prompt`, `looks_like_confirmation`, etc.)
- REPL context awareness (detecting when inside Python/Node/Claude Code vs shell)
- Interactive wait guidance using `wait_for: "changed"` to confirm visible reaction and `wait_for: "settled"` to wait for a short quiet window
- Final-response guidance (direct markdown text, no JSON wrapper)

#### Tool Definitions (Lines 130-191)

Four canonical tool definitions using standard JSON Schema format:

| Tool | Parameters | Description |
|------|------------|-------------|
| `terminal_exec` | `command`, `timeout_ms?` | Run a shell command and return authoritative output |
| `terminal_send` | `text?`, `submit?`, `keys?`, `observe_after_ms?`, `wait_for?`, `timeout_ms?` | Send interactive input with a default fast post-send observation |
| `terminal_observe` | `lines?`, `wait_for?`, `view?`, `timeout_ms?` | Observe the rendered terminal screen or recent scrollback |
| `terminal_interrupt` | none | Send Ctrl+C |

**Note**: Optional parameters (`?`) are simply omitted from the `required` array. The OpenAI provider transforms these to the null-union pattern required by OpenAI strict mode during tool transformation.

#### AgentService Class

**Constructor dependencies**:
- `TerminalSessionManager` (thread-scoped tmux sessions)
- `AgentRuntimeStateManager` (authoritative `/agent/state` snapshots plus bounded agent-stream resume)
- Logger and debug flags

**LLM Provider**: Uses `providerRegistry.getProviderForModel()` to get the appropriate provider based on configured model.

**Key methods**:

| Method | Purpose |
|--------|---------|
| `startUserMessage(threadId, options)` | Entry point - seeds active runtime state, then spawns async agent flow and carries thread-owner stamping |
| `runAgentFlow(...)` | Main loop - invoke model, handle tools, emit events |
| `buildConversation(threadId)` | Load message history into canonical `CanonicalMessage[]` format |
| `invokeModel(threadId, turnId, messages, reasoningEffort, signal)` | Consume provider `invoke()` streams, emit draft assistant SSE, and reconstruct a canonical response |
| `parseResponse(response)` | Extract final assistant text from `CanonicalResponse` |
| `extractFunctionCall(response)` | Extract tool calls from `response.toolCalls` |
| `executeTerminalCall(threadId, toolCall)` | Run terminal tools via TerminalSessionManager and enforce shell-vs-interactive behavior |
| `cancelThread(threadId)` | Abort running agent via AbortController |
| `isThreadActive(threadId)` | Check if thread has active agent run (used by ContextSyncService) |
| `parseCommandFromText(input)` | Extract command name from shell-entered text |

**Agent Loop Flow**:
```
startUserMessage()
    └─► runAgentFlow() [async]
           │
           ├─► buildConversation()
           │
           └─► LOOP (max steps):
                  │
                  ├─► invokeModel()
                  │
                  ├─► emit agent.message_start / delta / done (text responses only)
                  ├─► update `/agent/state` cursor + draft snapshot in lockstep
                  │
                  ├─► extractFunctionCall()
                  │      │
                  │      ├─► tool_call found → executeTerminalCall()
                  │      │                      └─► emit agent.tool_result
                  │      │                      └─► update `/agent/state` pending tool / phase
                  │      │
                  │      └─► no tool → parseResponse()
                  │                    └─► persist assistant row
                  │                    └─► emit agent.message + final
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
- `terminal.send` summaries are now evidence-based rather than optimistic: the agent records fast post-send observation data and avoids claiming program progress when the screen did not visibly change.
- `terminal.observe` guidance now steers the model toward `wait_for: "settled"` instead of the older `screen_stable` mental model, and replay normalization maps any older `screen_stable` tool payloads to `settled`.
- `terminal.send` now derives an explicit evidence-based `state` (`processing`, `waiting_for_input`, `ready_at_shell`, `ambiguous`) and uses that state to drive `follow_up_hint`, summary language, and `context_after`.
- `context_after.source` now distinguishes observed shell return from inferred REPL/session tracking so the model can treat inferred context as a hint rather than proof.

### `terminal-send-outcome.ts`

Small helper module for interpreting `terminal.send` evidence.

**Responsibilities**:
- derive send acceptance states from the fast post-send observation
- derive an explicit next-step send state from acceptance, readiness, and observed/inferred context
- build conservative tool summaries such as "Attempted to send ...; no visible change observed after 150ms"
- generate follow-up hints that steer toward `terminal.observe`, another `terminal.send`, or `terminal.exec` based on evidence

### `terminal-send-outcome.test.ts`

Standalone Node tests for Phase 6 send-result interpretation.

**Current Coverage**:
- unchanged post-send screens map to `acceptance.status = "no_visible_change"`
- summaries remain conservative and mention the `150ms` default observe window
- ambiguous sends recommend `terminal.observe` before the agent assumes the TUI accepted the input
- settled REPL/TUI updates map to `state.status = "waiting_for_input"`
- send results that visibly return to shell map their next step back to `terminal.exec`

**Reasoning Effort Support**:

Supports OpenAI reasoning effort levels: `none`, `low`, `medium`, `high`.
- `normalizeReasoningEffort()` - Validates and normalizes
- `detectReasoningNoneSupport()` - Checks model compatibility (gpt-5.1/o1/o3 don't support "none")

**Cancellation**:

Uses `AbortController` per thread to support mid-flow cancellation:
```typescript
private readonly cancellations = new Map<string, AbortController>();
```

**Ownership Notes**:
- `startUserMessage(..., { ownerUserId })` threads the resolved thread owner through the agent loop
- assistant final messages and tool-result messages are written with `message.created_by_user_id`
- lazily created terminal sessions inherit the same owner via `createSessionForThread(..., ownerUserId)`

### `thread-title-service.ts`

Best-effort thread-title generation for the first durable user message.

**Responsibilities**:
- confirm the just-written user row is still the canonical first user message on the thread
- call Anthropic `claude-haiku-4-5` with a short 3-5 word title prompt
- sanitize the model output into a plain-text title
- persist the title with a conditional `thread.title IS NULL` update
- emit `thread.title` on the existing agent SSE channel and advance the shared runtime cursor

**Notes**:
- runs fire-and-forget after `AgentService.startUserMessage(...)` succeeds, so the assistant turn is never blocked on title generation
- if Anthropic is unavailable, the model times out, or another request wins the conditional update first, the thread simply keeps its existing title state
- normalization now accepts any non-empty cleaned model title rather than rejecting 1-2 word outputs, so concise titles like `Bugfix` or `Assistant Introduction` persist as-is
- the emitted payload is `{ thread_id, title, source, updated_at }`, where `source` is currently `generated_first_user_message`

### `thread-title-service.test.ts`

Standalone Node tests for title normalization and prompt-output cleanup.

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
| `./terminal-send-outcome.js` | Send-result evidence interpretation for summaries and hints |
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
