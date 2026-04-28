# Debug: OpenAI Empty Agent Response Diagnostics

## Environment
- Repo: `/Users/adam/bud`
- Service agent path: `service/src/agent/model-runner.ts`
- LLM provider path: `service/src/llm/providers/openai.ts`
- Date: 2026-04-28

## Repro Steps
1. Run an agent turn with an OpenAI model.
2. Let the model response stream complete without a parsed text block or tool call.

## Observed
- The agent fails with:
  ```text
  Error: model returned no text or tool call
  ```
- The normal `Agent flow failed` log only carries the generic error message and stack.
- The canonical response payload is only logged when `agentOpenaiDebug` is enabled.
- Follow-up logs showed OpenAI did return a `terminal_send` function call, but the canonical `tool_use` and `toolCalls` entries had no `name` and used the output item id (`fc_...`) instead of the function call id (`call_...`).

## Expected
- Empty final responses should still fail the turn, but the error should carry enough model-response detail to diagnose whether OpenAI returned reasoning-only output, an unrecognized output item, a failed/incomplete status, or another response shape.

## Hypotheses
- The OpenAI Responses stream may be completing with a response shape that the provider adapter does not lower into text or a tool call.
- The provider may have raw completion data that is currently dropped before `parseFinalResponse()` throws.
- The OpenAI `response.function_call_arguments.done` stream event does not reliably carry the tool `name`; the adapter must reuse the metadata captured from `response.output_item.added`.

## Proposed Fix
- Preserve provider completion data on the canonical response when the provider exposes it.
- Throw a structured model-response error for empty final responses, with a bounded diagnostic copy of the canonical response and provider payload.
- Add model-runner coverage for the diagnostic error path.
- Update agent/LLM specs to document the diagnostic metadata.

## Implemented
- `OpenAIProvider` now attaches the raw `response.completed` payload to `message_done.providerData` and `CanonicalResponse.providerData`.
- `AgentModelRunner` carries provider data through streamed responses and throws `AgentModelResponseError` for empty or max-token final responses.
- The error message and `modelResponse` property include a bounded diagnostic response payload suitable for normal agent failure logs.
- `OpenAIProvider` now emits streamed `tool_use_done` events with the captured `call_id` and tool `name` from `response.output_item.added`, while using `response.function_call_arguments.done` only for the completed arguments JSON.
