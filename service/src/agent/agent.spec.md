# agent

LLM integration layer using OpenAI's Responses API to orchestrate tool-calling agent loops.

## Purpose

The agent service coordinates AI-assisted terminal interactions. When a user sends a message, it:
1. Builds conversation context from thread history
2. Calls OpenAI with terminal tools
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
- Output format requirements (JSON with `type`, `status`, `message`)

#### Tool Definitions (Lines 140-209)

Three strict JSON schema tools for OpenAI function calling:

| Tool | Parameters | Description |
|------|------------|-------------|
| `terminal_run` | `input`, `timeout_ms` | Send input to terminal (include `\n` for Enter) |
| `terminal_interrupt` | none | Send Ctrl+C |
| `terminal_capture` | `wait`, `lines`, `timeout_ms` | Capture terminal screen with optional readiness wait |

#### AgentService Class

**Constructor dependencies**:
- `OpenAI` client
- `TerminalSessionManager` (thread-scoped tmux sessions)
- `TerminalEventBus` (SSE event emission)
- Logger and debug flags

**Key methods**:

| Method | Purpose |
|--------|---------|
| `startUserMessage(threadId, options)` | Entry point - spawns async agent flow |
| `runAgentFlow(...)` | Main loop - invoke model, handle tools, emit events |
| `buildConversation(threadId)` | Load message history into OpenAI format |
| `invokeModel(input, reasoningEffort, signal)` | Call OpenAI Responses API |
| `parseResponse(response)` | Extract directive (tool_call or final) |
| `extractFunctionCall(response)` | Parse function_call items from output |
| `executeTerminalCall(threadId, toolCall)` | Run terminal.* tools via TerminalSessionManager |
| `cancelThread(threadId)` | Abort running agent via AbortController |

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
                  ├─► extractFunctionCall()
                  │      │
                  │      ├─► tool_call found → executeTerminalCall()
                  │      │                      └─► emit agent.tool_result
                  │      │
                  │      └─► no tool → parseResponse()
                  │                    └─► emit agent.message + final
                  │
                  └─► continue or return
```

**Reasoning Effort Support**:

Supports OpenAI reasoning effort levels: `none`, `low`, `medium`, `high`.
- `normalizeReasoningEffort()` - Validates and normalizes
- `detectReasoningNoneSupport()` - Checks model compatibility (gpt-5.1/o1/o3 don't support "none")

**Cancellation**:

Uses `AbortController` per thread to support mid-flow cancellation:
```typescript
private readonly cancellations = new Map<string, AbortController>();
```

## Events Emitted

Via `TerminalEventBus`:

| Event | Data | When |
|-------|------|------|
| `agent.tool_call` | `{ id, name, args }` | Before executing tool |
| `agent.tool_result` | `{ name, output, readiness, ... }` | After tool execution |
| `agent.message` | `{ text }` | Final response text |
| `final` | `{ status, text }` or `{ status, error }` | Flow complete |

## Dependencies

| Import | Purpose |
|--------|---------|
| `openai` | OpenAI SDK for Responses API |
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
- Some type assertions (`as Record<string, unknown>`) could be improved with proper OpenAI response types

---

*Referenced by: [../src.spec.md](../src.spec.md)*
