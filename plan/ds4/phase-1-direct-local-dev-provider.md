# Phase 1: Direct Local Dev Provider

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; Chat Completions path removed by Phase 1.6

---

## Objective

Add a service-local ds4 provider path for development machines where `service` and ds4 run on the same host.

By the end of this phase:

- `ds4` exists in the service provider/catalog vocabulary
- `ds4-deepseek-v4-flash` can be selected when `DS4_DIRECT_BASE_URL` is configured
- ds4 Chat Completions streaming maps into Bud's canonical provider stream
- provider-ledger rows can record provider `ds4` and request mode `ds4_openai_chat`
- OpenAI and Anthropic defaults remain unchanged

## Scope

### In Scope

- `service/src/config.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/llm/registry.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/providers/`
- `service/src/agent/model-runner.ts` only as needed for provider/request-mode type widening
- `service/src/routes/models.ts`
- service LLM/provider tests
- service environment docs

### Out Of Scope

- daemon capability advertisement
- Bud-scoped inventory
- hosted-service-to-daemon data-plane calls
- Responses or Anthropic Messages ds4 provider modes
- making ds4 a global production default

## Configuration

```text
DS4_DIRECT_BASE_URL=http://127.0.0.1:8000/v1
DS4_DIRECT_MODEL=deepseek-v4-flash
DS4_DIRECT_CONTEXT_TOKENS=100000
DS4_DIRECT_MAX_OUTPUT_TOKENS=384000
```

Register the provider only when `DS4_DIRECT_BASE_URL` is present.

## Implementation Tasks

### Task 1: Extend provider and ledger types

Add provider id `ds4` to:

- catalog provider vocabulary
- provider registry typing
- canonical provider-ledger provider ids
- request-mode typing

Add `ds4_openai_chat` as the initial request mode.

### Task 2: Add catalog metadata

Add a product catalog entry:

```text
id: ds4-deepseek-v4-flash
provider: ds4
provider_model: deepseek-v4-flash
display_name: ds4 DeepSeek V4
```

Expose it only when a ds4 provider is registered.

### Task 3: Implement direct Chat Completions provider

Implement either:

- `Ds4ChatCompletionsProvider`, or
- a reusable OpenAI-compatible Chat Completions provider configured for ds4

Responsibilities:

- build Chat Completions request bodies from Bud canonical messages/tools
- request streaming responses
- parse text deltas
- parse tool-call deltas and completion boundaries
- normalize provider errors
- respect cancellation via the existing abort signal

Keep ds4-specific compatibility handling isolated from the existing OpenAI Responses provider.

### Task 4: Add direct local model inventory shape

When direct ds4 is configured, `/api/models` may include the ds4 model with source metadata identifying it as service-local development.

Suggested source shape:

```json
{
  "kind": "service_local_dev"
}
```

This direct model is not tied to a Bud and should not be enabled in hosted production environments.

### Task 5: Add tests

Add focused tests for:

- catalog includes `ds4` without changing global default
- direct ds4 is absent when `DS4_DIRECT_BASE_URL` is unset
- direct ds4 appears when configured
- Chat Completions stream parser handles final text
- Chat Completions stream parser handles tool-call deltas
- provider ledger records `ds4_openai_chat`
- OpenAI/Anthropic request modes still work

### Task 6: Run live direct smoke

Against the already-running ds4 server, validate:

- one simple final-text response
- one tool-call turn through the agent loop
- canceling a streaming generation

Record live smoke status in [validation-checklist.md](./validation-checklist.md).

## Validation Checklist

- [x] service config parses `DS4_DIRECT_*`
- [x] provider id `ds4` exists
- [x] request mode `ds4_openai_chat` exists
- [x] catalog entry `ds4-deepseek-v4-flash` exists
- [x] direct provider registers only with explicit config
- [x] direct provider parses text streams
- [x] direct provider parses tool-call streams
- [x] direct provider cancellation works
- [x] live final-text smoke passes
- [x] live tool-call smoke passes

Live direct-provider smoke on 2026-06-02 used `DS4_DIRECT_BASE_URL=http://127.0.0.1:8000/v1` against the already-running ds4 server. Final text, Chat Completions tool-call deltas, and abort-signal cancellation all exercised the service `Ds4ChatCompletionsProvider`. A lower `maxOutputTokens: 32` final-text attempt stopped during ds4 `reasoning_content` before visible text; `maxOutputTokens: 128` produced the expected text.

## Exit Criteria

This phase completed the first direct local-dev ds4 path. The active direct
local-dev path now uses `/v1/responses`; the Chat Completions provider from this
phase is historical and was removed in Phase 1.6.
