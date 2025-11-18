# Debug: Responses tool loop without `required_action`

## Context
- Environment: local dev (Bud + service + web), real OpenAI Responses API.
- After switching to official tool-calling, we still relied on `response.output_text` to drive the loop. When the model returns only structured tool calls (no text), the backend now emits `assistant returned no output_text` and fails the run.

## Observations from docs
- `docs/openai/responses-api.md` does **not** mention `required_action` (that’s an Assistants-only concept).
- Tool calls come back as `function_call` items within the `response.output` array (and via streaming events if enabled).
- Expected flow:
  1. Model returns `function_call` (possibly without any `output_text`).
  2. Client executes the tool (Bud shell command).
  3. Client sends a **follow-up** Responses request with:
     - Original conversation history.
     - The new `function_call_output` item describing the tool result.
  4. Model continues, possibly returning more tool calls or final assistant text.
- Therefore, lack of `output_text` is normal mid-run; we should not treat it as failure.

## Current issues
- `AgentService.parseResponse` throws when `output_text` is empty and no tool_call was extracted → causes 500s instead of continuing the loop.
- After executing a tool, we currently push a synthetic `user` message containing `TOOL_RESULT` JSON, but we **do not** re-invoke the model. Instead, we expect the same response to include final text, which is incorrect for multi-step tool usage.
- We are effectively stuck after the first tool execution because the agent never calls OpenAI again with the tool output.

## Proposed fix
1. Treat “no output_text + tool_call extracted” as the normal path (already handled). When no tool is found **and** there’s no text, we should hold the loop until the next Responses call instead of failing outright.
2. Represent the ongoing conversation exactly as the API expects:
   - Start with the historical `message` items (system/user/assistant).
   - When the model emits a `function_call`, capture `{ type: "function_call", call_id, name, arguments }` and append a matching `{ type: "function_call_output", call_id, output }` once Bud finishes executing the command.
   - Re-invoke `responses.create` with this expanded list so the model can continue reasoning with the tool output. No more fake user messages containing `TOOL_RESULT`.
3. Loop until one of these conditions:
   - Model emits another `function_call` → run tool again (respecting `MAX_STEPS`).
   - Model emits assistant text (`response.output_text` / `ResponseOutputMessage`) → treat as final directive (`type: "final"`). Optionally, persist assistant text in the `message` table.
   - Safety net: if the model returns neither tool calls nor text for several iterations (should not happen), surface a controlled failure after `MAX_STEPS`.
4. Emit SSE updates for each stage: `planning` (model call in flight), `agent.tool_call` (before Bud dispatch), `exec.*` during Bud execution, `agent.tool_result`, and `agent.message` for final assistant output.
5. (Future) consider enabling streaming so we can surface `response.output_text.delta` tokens and `response.function_call_arguments.delta` events, then update SSE to include incremental agent messages.

## Next steps
- Implement follow-up Responses calls after each tool execution, passing the tool output as `function_call_output`.
- Stop throwing on missing `output_text`; keep the loop alive until we hit max steps or receive `final` text.
- Update SSE/status handling to reflect planning vs. running states during multi-turn interactions.

## Update 2025-11-15 — call_id mismatch
- **Observed**: Second Responses call now fails with `400 No tool call found for function call output with call_id ...`.
- **Hypothesis**: When we reconstruct history, we only inject `function_call_output` items for persisted tool rows, so the follow-up request lacks the preceding `function_call` item that introduced the matching `call_id`.
- **Plan**:
  1. Update `buildConversation` to emit both a `function_call` (with `call_id`, `name: shell_run`, `arguments`) and the `function_call_output` for every stored tool payload.
  2. Continue storing the same structured payload (command/cwd/exit/status/stdout) so we can faithfully rebuild both items for future turns.
  3. Re-test the multi-turn loop; Responses should now accept the tool output because the input contains the matching call definition.
