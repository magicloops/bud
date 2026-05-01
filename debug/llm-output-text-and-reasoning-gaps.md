# Debug: LLM Output Text And Reasoning Gaps

## Environment
- Repo: `/Users/adam/bud`
- Date: 2026-04-30
- Primary backend path: `service/src/llm/providers/*`, `service/src/agent/*`
- Primary web path: `web/src/features/threads/*`
- Providers reviewed: OpenAI Responses API adapter and Anthropic Messages API adapter

## Repro Steps
1. Start a normal thread turn with streaming attached in the web UI.
2. Use a reasoning/tool-capable OpenAI or Anthropic model.
3. Let the model emit visible assistant text before a terminal tool call, or between terminal tool calls.
4. Observe the text appear in the live chat timeline.
5. Refresh the page after the tool call has started or after the turn completes.

## Observed
- Live assistant text can appear as a draft message during streaming, then disappear once a tool call starts.
- After refresh, the disappeared text is not in `/api/threads/:threadId/messages`.
- Reasoning/thinking output is normalized internally but is never surfaced in the UI.

## Expected
- Any provider text block shown to the user during streaming should either:
  - become a durable transcript message, or
  - be explicitly treated as non-transcript ephemeral UI with copy/UI that makes that clear.
- Provider output should be consumed as ordered content items, not as "either text or tool call".
- Reasoning/thinking should have an explicit product contract: hidden, summarized in UI, or stored only for provider continuity.

## API Shape Notes
- OpenAI Responses returns an `output` array whose item order and length are model-dependent. The SDK `output_text` helper is an aggregate of all `output_text` content, not proof that text lives at a fixed array position.
- OpenAI reasoning items should be included in later Responses input when the app manually manages conversation state.
- Anthropic Messages responses can contain `thinking`, `text`, and `tool_use` content blocks. With tool use, Anthropic requires the complete thinking blocks to be passed back while continuing the tool turn.
- Anthropic streaming emits separate text, tool input JSON, thinking, and signature deltas. Redacted thinking blocks are also a documented response shape.

References:
- OpenAI Responses response object: https://platform.openai.com/docs/api-reference/responses/retrieve
- OpenAI Responses input items / reasoning: https://platform.openai.com/docs/api-reference/responses/input-items
- Anthropic extended thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- Anthropic streaming: https://docs.anthropic.com/claude/reference/messages-streaming

## Findings

### 1. Text in a tool-call response is streamed, then dropped

`AgentModelRunner.invokeModel(...)` already accumulates text blocks, reasoning blocks, and tool calls from provider stream events. It emits `agent.message_start`, `agent.message_delta`, and `agent.message_done` as soon as text deltas arrive (`service/src/agent/model-runner.ts:210`, `:226`, `:260`, `:286`). It then reconstructs an ordered `CanonicalResponse` containing all text/tool/reasoning blocks (`service/src/agent/model-runner.ts:299`).

The loss happens in `AgentService.runAgentFlow(...)`: it calls `extractToolCall(response)` first, and if any tool call exists it enters the tool path (`service/src/agent/agent-service.ts:163`). That path preserves only reasoning blocks plus the selected `tool_use` in the in-memory conversation (`service/src/agent/agent-service.ts:183`, `:190`). It does not carry the response text blocks forward and does not persist them.

On the web side, the draft is intentionally removed when a tool call arrives: `applyToolCall(...)` calls `removeDraftAssistantMessageForTurn(...)` before adding the pending tool row (`web/src/features/threads/use-thread-messages.ts:204`, `:216`). That explains the observed behavior: the text was live-only draft state, then replaced by a tool row, and no durable assistant row exists after refresh.

This is provider-agnostic. OpenAI and Anthropic both lower text deltas into the same `text_delta` canonical event type, so any mixed text-plus-tool response can trigger this.

### 2. Text between tool calls is also dropped from model context

The same issue repeats after every tool result. A later provider response can contain:
1. assistant text,
2. another tool call.

The UI streams the text, but the tool path still appends only reasoning plus `tool_use` to the next conversation request (`service/src/agent/agent-service.ts:190`). The model therefore also loses its own just-emitted text as context for the remainder of the same agent turn.

### 3. Final assistant persistence only handles the no-tool path

Assistant messages are persisted only through `recordFinalAssistant(...)`, and that is reached only when `extractToolCall(response)` returns null (`service/src/agent/agent-service.ts:235`). The transcript writer inserts exactly one final assistant `message.content` string (`service/src/agent/transcript-writer.ts:160`, `:171`, `:178`) and emits canonical `agent.message` only after that durable insert (`service/src/agent/transcript-writer.ts:253`).

There is no durable representation for an "assistant text segment before tool call" or "assistant text segment between tool calls".

### 4. Reasoning is normalized but not surfaced

The canonical type system has reasoning stream events and reasoning blocks (`service/src/llm/types.ts:82`, `:177`). Both provider adapters emit reasoning events:
- OpenAI handles reasoning output items and `response.reasoning_summary_text.delta` (`service/src/llm/providers/openai.ts:455`, `:522`).
- Anthropic handles `thinking_delta` and signature deltas (`service/src/llm/providers/anthropic.ts:477`, `:517`, `:527`).

`AgentModelRunner` stores completed reasoning blocks in `reasoningBlocks` (`service/src/agent/model-runner.ts:191`, `:277`) but never emits agent SSE events for reasoning deltas, never includes reasoning in `/agent/state`, and never asks the transcript writer to persist displayable reasoning.

The current behavior is therefore "reasoning is provider-continuity data only", but that is not stated as a product contract and the UI has no way to show even summarized reasoning.

### 5. Reasoning continuity is only in-memory during a live tool loop

The live tool loop does preserve reasoning blocks for the immediately following tool result request (`service/src/agent/agent-service.ts:183`). The provider adapters can pass those blocks back:
- OpenAI passes provider reasoning payloads back as input items (`service/src/llm/providers/openai.ts:255`).
- Anthropic passes `thinking` and `reasoning_redacted` provider payloads back into assistant content (`service/src/llm/providers/anthropic.ts:386`, `:395`).

However, `AgentConversationLoader` reconstructs persisted assistant rows as plain text only (`service/src/agent/conversation-loader.ts:165`) and persisted tool rows as synthetic assistant `tool_use` plus user `tool_result` (`service/src/agent/conversation-loader.ts:133`). It has no durable reasoning payload to replay after a service restart, process crash, or later user turn.

This is probably acceptable for final answers if we intentionally do not need prior reasoning, but it is risky for interrupted or resumed tool loops and does not match the provider-continuity comments in the canonical types.

### 6. OpenAI stream ordering is not fully tied to `output_index`

OpenAI text content uses a local `contentIndex` counter (`service/src/llm/providers/openai.ts:401`, `:505`, `:513`, `:517`), while tool calls and reasoning use OpenAI `event.output_index` (`service/src/llm/providers/openai.ts:455`, `:468`, `:486`, `:546`). The model runner later sorts blocks by these mixed indexes (`service/src/agent/model-runner.ts:299`).

If OpenAI emits a message item after a function call, the text block can receive local index `0` while the function call keeps output index `0` or `1`. That can reorder reconstructed content relative to the actual Responses `output` array.

### 7. Multiple tool calls are not robustly handled

The OpenAI streaming adapter tracks only one `currentToolCall` (`service/src/llm/providers/openai.ts:407`). A second function call before the first is completed would overwrite that state. The agent runner then selects only `toolCalls[0]` (`service/src/agent/model-runner.ts:390`), so even correctly parsed multiple tool calls would be ignored.

If Bud's contract is intentionally one terminal gesture at a time, the provider request should disable parallel tool calls where supported and tests should assert single-tool behavior. Otherwise the agent loop needs a multi-tool execution policy.

### 8. Anthropic redacted thinking is not parsed

The canonical type system has `reasoning_redacted`, and `AnthropicProvider.transformMessages(...)` can pass provider redacted thinking back if present (`service/src/llm/types.ts:93`, `service/src/llm/providers/anthropic.ts:395`). But Anthropic stream parsing only starts `thinking`, `text`, and `tool_use` blocks (`service/src/llm/providers/anthropic.ts:478`), and non-stream parsing handles only `text`, `tool_use`, and `thinking` (`service/src/llm/providers/anthropic.ts:601`).

Documented `redacted_thinking` blocks would currently be dropped, which can break continuity when Anthropic expects them to be returned during a tool-use continuation.

### 9. Tool-choice abstraction has a provider mismatch

`ToolChoice` includes `"none"` (`service/src/llm/types.ts:139`), but Anthropic maps `"none"` to `{ type: "auto" }` (`service/src/llm/providers/anthropic.ts:427`). That means callers asking Anthropic for no tools can still receive tool calls. The current chat path uses auto tool choice, so this is not the suspected disappearing-text bug, but it is a provider abstraction gap.

## Strongest Root Cause

The disappearing-message symptom is best explained by a backend transcript boundary bug:

1. Provider streams text.
2. Backend emits draft assistant SSE.
3. Web renders a draft assistant message.
4. Same provider response also contains a tool call.
5. Backend treats the whole response as a tool-call response and drops text blocks.
6. Web removes the draft on `agent.tool_call`.
7. Only the tool result and later final assistant text are persisted.
8. Refresh reloads durable transcript rows, so the draft text is gone.

## Proposed Fix Direction

1. Decide the transcript contract for text emitted before or between tool calls. Since the UI already shows it, the least surprising behavior is to persist it.
2. In `AgentService.runAgentFlow(...)`, when `response.content` contains text blocks and a tool call, persist the text blocks before `emitToolCall(...)` using the same `client_id` that was allocated for the draft assistant.
3. Push the text blocks into the in-memory conversation before the `tool_use` block, preserving provider output order.
4. Add a metadata distinction such as `status: "intermediate"` / `turn_id` / `followed_by_tool_call` so notification and attention code does not treat every intermediate text segment as a completed assistant answer.
5. Add tests for:
   - OpenAI stream with text before tool call.
   - OpenAI stream with tool call, tool result, then text before another tool call.
   - Anthropic stream with `thinking`, `text`, and `tool_use`.
   - Refresh/rebootstrap behavior where intermediate assistant text is present in `/messages`.
6. If we want reasoning in the UI, add explicit `agent.reasoning_*` SSE/state fields and separate display policy from provider-continuity storage. If not, document that reasoning is intentionally hidden.
7. Make provider stream reconstruction output-index based and either disable parallel tool calls or implement a deterministic multi-tool policy.
8. Add Anthropic `redacted_thinking` handling and fix `"none"` tool-choice lowering before relying on those abstraction features.

## Spec Files Affected By A Fix
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md` if `/agent/state` gains reasoning or intermediate assistant fields
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md` if the chat timeline gets distinct intermediate/reasoning presentation

## Validation Notes
- No code changes were made as part of this review.
- No tests were run; this note is based on static code review and provider API docs.
