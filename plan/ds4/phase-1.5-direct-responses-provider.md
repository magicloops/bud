# Phase 1.5: Direct Responses Provider

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented for direct service-local provider; live cache validation pending. The temporary Chat Completions fallback described in this phase was removed in [Phase 1.6](./phase-1.6-remove-chat-completions-fallback.md).

---

## Context

Phase 1 implemented a direct local-dev ds4 provider through `/v1/chat/completions`. That path can produce final text and terminal tool calls, but live cache debugging found an endpoint-level replay limitation:

- ds4 streams hidden reasoning as Chat Completions `delta.reasoning_content`
- Bud's next Chat Completions request replays only visible assistant text and tool calls
- ds4 accepts `assistant.reasoning_content` in request history but ignores it when rendering the prompt
- ds4 live KV therefore matches through the previous prompt, then diverges before visible assistant replay

The ds4 server notes in [../../reference/ds4/server.md](../../reference/ds4/server.md) call `/v1/responses` the preferred endpoint for Codex-style clients and say it keeps Responses continuations bound to live state when possible. This phase scopes testing and switching the direct ds4 path to `/v1/responses` before carrying ds4 into daemon capability and data-plane phases.

Related debug note:

- [../../debug/ds4-live-kv-cache-token-mismatch.md](../../debug/ds4-live-kv-cache-token-mismatch.md)

## Objective

Implement the service-local direct ds4 provider on OpenAI Responses compatibility and validate whether that endpoint fixes the Chat Completions live-cache replay boundary.

By the end of this phase:

- direct probes confirm `/v1/responses` request, stream, reasoning, and tool-call shapes
- Bud has a `ds4_openai_responses` request mode (implemented)
- the direct ds4 provider can use `/v1/responses` as the default request surface (implemented)
- Chat Completions remains available only as a fallback/debug mode until removed or explicitly retained (implemented)
- live cache behavior is measured again against ds4 server logs

## Scope

### In Scope

- direct service-local ds4 provider path
- `/v1/responses` fixture/probe capture
- provider-ledger request mode `ds4_openai_responses`
- canonical stream mapping for text, reasoning, tool calls, usage, incomplete/error events
- same-provider replay behavior for ds4 Responses
- local context-drift/debug artifact comparison
- service LLM/provider specs and ds4 plan docs

### Out Of Scope

- daemon `capabilities.llm`
- Bud-scoped model inventory
- hosted-service-to-daemon data-plane streams
- `/v1/messages` implementation
- generic local-runner Responses compatibility
- product UI changes beyond keeping the existing ds4 model selectable

## Design / Approach

### Endpoint Selection

Add an endpoint mode for direct ds4:

```text
DS4_DIRECT_ENDPOINT=responses
```

Default the mode to `responses` for the service-local implementation. Keep `chat_completions` as an explicit fallback while live cache validation is still local-dev/debug only.

Supported values:

| Value | Request mode | Endpoint | Purpose |
| --- | --- | --- | --- |
| `responses` | `ds4_openai_responses` | `POST /v1/responses` | Preferred direct ds4 mode |
| `chat_completions` | `ds4_openai_chat` | `POST /v1/chat/completions` | Temporary fallback/debug mode |

Do not expose endpoint mode through the browser. This is provider configuration, not a user preference.

### Provider Shape

Prefer a ds4-specific Responses provider over reusing `OpenAIProvider` directly:

- use platform `fetch`, not the OpenAI SDK, so local ds4 URL handling stays explicit
- reuse canonical lowering/parsing ideas from the OpenAI Responses adapter where practical
- keep ds4-specific compatibility quirks isolated
- keep provider id `ds4`, even when the HTTP shape is OpenAI-compatible

Candidate class:

```typescript
Ds4ResponsesProvider
```

The existing `Ds4ChatCompletionsProvider` can remain in place temporarily for fallback and comparative tests.

### Request Lowering

Map Bud canonical inputs to ds4 `/v1/responses`:

| Bud canonical | Responses input |
| --- | --- |
| leading system message | `instructions` when possible |
| user text | `input` message item with role `user` |
| assistant text | `input` message item with role `assistant` |
| assistant tool use | `function_call` item with `call_id`, `name`, `arguments` |
| tool result | `function_call_output` item with `call_id`, `output` |
| reasoning block | provider-native Responses item only if ds4 emits a replayable payload |

Open questions for the probe:

- whether ds4 emits provider-native reasoning items or only reasoning summary/text events
- whether ds4 accepts prior reasoning items in `input`
- whether ds4 supports `previous_response_id`, encrypted reasoning, or another continuation field
- whether tool calls require `parallel_tool_calls:false` or are already serialized

### Stream Mapping

Map Responses events into Bud canonical stream events:

| ds4 Responses event | Bud canonical event |
| --- | --- |
| `response.created` | `message_start` |
| `response.output_text.delta` | `content_start` then `text_delta` |
| reasoning summary/text delta event, if present | `reasoning_start` / `reasoning_delta` / `reasoning_done` if replayable; diagnostic-only if not |
| `response.function_call_arguments.delta` | `tool_use_delta` |
| function-call completion event | `tool_use_done` |
| `response.completed` | `message_done` |
| `response.incomplete` | `message_done` with `max_tokens` or provider error, depending reason |
| `response.failed` | `error` or thrown provider error |

The first implementation should preserve enough raw provider payload in `providerData` to debug continuation/cache behavior, even if visible product behavior stays unchanged.

### Replay And Cache Acceptance

The phase is only successful if `/v1/responses` improves the replay boundary that Chat Completions cannot represent.

Run a live comparison:

1. Direct Chat Completions control, as already captured.
2. Direct Responses final-text turn.
3. Direct Responses follow-up user turn.
4. Direct Responses terminal tool-call turn.
5. Direct Responses post-tool continuation.

Record:

- ds4 server `prompt`, `live`, and `common` values for each request
- whether `common` advances through prior generated reasoning/output, not merely to the previous prompt boundary
- provider usage cache counters, if ds4 reports them
- context-drift provider-rendered request snapshots
- providerData diagnostic payloads

If Responses still cannot replay hidden reasoning or bind continuation state in Bud's stateless transcript flow, do not switch the default. Document the blocker and revisit ds4-server behavior instead.

## Implementation Tasks

### Task 1: Capture Responses fixtures

Use the already-running local ds4 server to capture compact fixtures for:

- final text stream
- reasoning stream fields
- terminal tool call stream
- post-tool continuation
- `response.completed`
- `response.incomplete`
- `response.failed` or malformed request error
- usage/cache metadata

Store fixtures where provider tests can consume them.

### Task 2: Add request-mode and config vocabulary

Add:

```text
ds4_openai_responses
DS4_DIRECT_ENDPOINT=responses|chat_completions
```

Keep provider id `ds4`.

Update request-mode diagnostics so provider-ledger rows clearly distinguish Chat Completions from Responses.

### Task 3: Implement `Ds4ResponsesProvider`

Implement the direct local provider using `/v1/responses`.

Responsibilities:

- build Responses request bodies from Bud canonical messages/tools
- stream SSE responses over platform `fetch`
- parse Responses lifecycle events
- emit canonical text, reasoning, tool-call, and done events
- preserve diagnostic providerData for completed/incomplete/failed responses
- normalize context-window and upstream HTTP errors
- respect cancellation through the existing abort signal
- expose provider-rendered debug request snapshots

### Task 4: Wire direct ds4 provider selection

When `DS4_DIRECT_BASE_URL` is configured:

- use `Ds4ResponsesProvider` by default
- use `Ds4ChatCompletionsProvider` only when `DS4_DIRECT_ENDPOINT=chat_completions`
- keep catalog model id `ds4-deepseek-v4-flash`
- keep model selection behavior unchanged for the browser

### Task 5: Update provider-ledger reconstruction

Confirm ledger recording/reconstruction for:

- `ds4_openai_responses`
- text output
- reasoning output, if replayable
- tool calls
- tool results
- provider switches back to OpenAI/Anthropic

If ds4 Responses emits provider-native reasoning payloads that can be replayed, store them as provider-only reasoning blocks. If it emits only output-visible reasoning text with no replay payload, keep it diagnostic-only until a replay contract is clear.

### Task 6: Add tests

Add focused tests for:

- request lowering to `/v1/responses`
- stream text parsing
- stream reasoning parsing or diagnostic capture
- stream tool-call parsing
- post-tool canonical replay
- provider-ledger request mode `ds4_openai_responses`
- config fallback to `chat_completions`
- OpenAI and Anthropic providers unchanged

### Task 7: Run live cache validation

Run the same web-agent flow that exposed Chat Completions misses.

Validation target:

- `common` should advance through the prior generated output/continuation boundary, or ds4 should report a Responses continuation hit rather than a token mismatch at the previous prompt boundary

Record results in:

- [../../debug/ds4-live-kv-cache-token-mismatch.md](../../debug/ds4-live-kv-cache-token-mismatch.md)
- [validation-checklist.md](./validation-checklist.md)

## Spec Files To Update

- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md)
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md)
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md), if replay/diagnostic behavior changes
- [ds4.spec.md](./ds4.spec.md)
- [implementation-spec.md](./implementation-spec.md)

## Impacted Contracts

- [ ] WSS protocol: none in direct mode
- [ ] SSE events: none browser-facing unless reasoning display policy changes
- [ ] DB schema: none expected
- [x] Agent tools: tool-call parsing/replay must stay compatible
- [x] Provider ledger: add `ds4_openai_responses`
- [x] LLM provider contract: direct ds4 provider request mode changes
- [ ] Web UI: no expected changes

## Validation Checklist

- [ ] `/v1/responses` final-text fixture captured
- [ ] `/v1/responses` reasoning fixture captured
- [ ] `/v1/responses` tool-call fixture captured
- [ ] `/v1/responses` post-tool continuation fixture captured
- [x] `ds4_openai_responses` request mode implemented
- [x] direct ds4 defaults to Responses mode
- [x] Chat Completions fallback remains available during transition
- [ ] direct Responses final-text live smoke passes
- [ ] direct Responses terminal tool-call live smoke passes
- [ ] direct Responses cache behavior improves over Chat Completions or blocker is documented
- [x] provider-ledger rows record `ds4_openai_responses`
- [x] build and focused provider tests pass

## Rollout

1. Land fixtures and deterministic parser tests.
2. Implement direct `Ds4ResponsesProvider`.
3. Use Responses as the local-dev default while live final-text, tool-call, and cache validation run.
4. Keep Chat Completions fallback for one iteration while comparing cache behavior.
5. If Responses solves the replay issue, update Phase 2-4 data-plane docs to use `/v1/responses` as the default Bud-backed endpoint.
6. If Responses does not solve it, keep Chat Completions as the functional direct provider and treat the cache miss as a ds4-server compatibility issue.

## Exit Criteria

This phase is done when Bud has an explicit go/no-go decision for switching direct ds4 from `/v1/chat/completions` to `/v1/responses`, backed by fixtures, provider tests, and live cache validation.
