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
```

### `agent-service.ts`

Main agent implementation (~1,100 lines).

#### System Prompt (Lines 64-127)

Defines agent behavior as "Bud Agent" with:
- Tool calling guidelines (when to use each tool)
- Readiness confidence interpretation (≥0.8 ready, 0.5-0.8 probably ready, <0.5 still processing)
- Hint interpretation (`looks_like_prompt`, `looks_like_confirmation`, etc.)
- REPL context awareness (detecting when inside Python/Node/Claude Code vs shell)
- Final-response guidance (direct markdown text, no JSON wrapper)

#### Tool Definitions (Lines 130-191)

Three canonical tool definitions using standard JSON Schema format:

| Tool | Parameters | Description |
|------|------------|-------------|
| `terminal_run` | `input`, `timeout_ms?` | Send input to terminal (include `\n` for Enter) |
| `terminal_interrupt` | none | Send Ctrl+C |
| `terminal_capture` | `wait?`, `lines?`, `timeout_ms?` | Capture terminal screen with optional readiness wait |

**Note**: Optional parameters (`?`) are simply omitted from the `required` array. The OpenAI provider transforms these to the null-union pattern required by OpenAI strict mode during tool transformation.

#### AgentService Class

**Constructor dependencies**:
- `TerminalSessionManager` (thread-scoped tmux sessions)
- `AgentEventBus` (SSE event emission for agent events)
- Logger and debug flags

**LLM Provider**: Uses `providerRegistry.getProviderForModel()` to get the appropriate provider based on configured model.

**Key methods**:

| Method | Purpose |
|--------|---------|
| `startUserMessage(threadId, options)` | Entry point - spawns async agent flow and carries thread-owner stamping |
| `runAgentFlow(...)` | Main loop - invoke model, handle tools, emit events |
| `buildConversation(threadId)` | Load message history into canonical `CanonicalMessage[]` format |
| `invokeModel(threadId, turnId, messages, reasoningEffort, signal)` | Consume provider `invoke()` streams, emit draft assistant SSE, and reconstruct a canonical response |
| `parseResponse(response)` | Extract final assistant text from `CanonicalResponse` |
| `extractFunctionCall(response)` | Extract tool calls from `response.toolCalls` |
| `executeTerminalCall(threadId, toolCall)` | Run terminal.* tools via TerminalSessionManager (uses `runCommand()` for terminal.run) |
| `cancelThread(threadId)` | Abort running agent via AbortController |
| `isThreadActive(threadId)` | Check if thread has active agent run (used by ContextSyncService) |
| `parseCommandFromInput(input)` | Extract command name from terminal input |

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
                  │
                  ├─► extractFunctionCall()
                  │      │
                  │      ├─► tool_call found → executeTerminalCall()
                  │      │                      └─► emit agent.tool_result
                  │      │
                  │      └─► no tool → parseResponse()
                  │                    └─► persist assistant row
                  │                    └─► emit agent.message + final
                  │
                  └─► continue or return
```

**Streaming Notes**:
- The agent no longer asks the model to wrap final answers in JSON.
- Provider `invoke()` streams are now the primary path; `AgentService` reconstructs a `CanonicalResponse` from provider text/tool/reasoning events.
- Draft assistant text is emitted live over SSE via `agent.message_start`, `agent.message_delta`, and `agent.message_done`.
- The persisted assistant transcript row is still created only once the turn resolves, then emitted as `agent.message`.
- Reasoning blocks are preserved inside the in-memory conversation on tool-call loops so providers that require multi-turn reasoning context do not lose those items.

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

## Events Emitted

Via `AgentEventBus`, using `threadId` as the channel:

| Event | Data | When |
|-------|------|------|
| `agent.message_start` | `{ turn_id }` | First visible assistant-text chunk for a turn |
| `agent.message_delta` | `{ turn_id, delta }` | Incremental assistant-text append |
| `agent.message_done` | `{ turn_id, text }` | Draft assistant text complete, before canonical persistence |
| `agent.tool_call` | `{ turn_id, call_id, name, args }` | Before executing tool |
| `agent.tool_result` | `{ turn_id, call_id, message_id, name, output, ..., message }` | After tool execution, including the persisted canonical tool row |
| `agent.message` | `{ turn_id, message_id, text, message }` | Canonical persisted assistant row after draft streaming has completed |
| `final` | `{ turn_id, status, message_id?, text? }` or `{ turn_id, status, error }` | Flow complete |

Events are consumed via SSE at `GET /api/threads/:threadId/agent/stream`.

**Reconciliation Notes**:
- `turn_id` groups all live events for one agent turn
- `agent.message_start` / `agent.message_delta` / `agent.message_done` describe a client-side draft, not a persisted transcript row
- `call_id` on `agent.tool_call` / `agent.tool_result` matches the persisted tool row `metadata.call_id`
- `message.message_id` lets clients upsert canonical transcript rows without inventing assistant/tool ids locally
- `agent.message` is the canonical persisted assistant row; clients should replace any draft for that `turn_id` when it arrives
- `final` still matters for completion status, but successful turns no longer require a mandatory transcript refetch just to learn the assistant/tool row IDs
- replay resume is keyed off the SSE frame `id:` rather than the JSON payload; if the requested resume id is no longer buffered, clients should treat reconnect as drift recovery and refetch canonical history

**Buffer Management**: The event buffer is cleared at the start of each new agent run (`startUserMessage`). This prevents stale events (especially `final` from previous runs) from being replayed to new SSE connections, which would cause the stream to close prematurely.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../llm/index.js` | Provider registry and canonical types |
| `ulid` | Message ID generation |
| `../db/client.js` | Database access |
| `../db/schema.js` | Table schemas |
| `../runtime/terminal-session-manager.js` | Thread-scoped terminal sessions |
| `../runtime/event-bus.js` | SSE event emission |
| `../terminal/types.js` | Readiness hints types |
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
