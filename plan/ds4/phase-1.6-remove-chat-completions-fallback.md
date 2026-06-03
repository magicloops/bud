# Phase 1.6: Remove Chat Completions Fallback

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Context

Phase 1 added direct ds4 support through `/v1/chat/completions`. That path proved local connectivity, model selection, streaming text, and terminal tool calls.

Phase 1.5 moved direct ds4 to `/v1/responses` because ds4's Chat Completions endpoint streams thinking as output-only `reasoning_content`, and direct probes confirmed replayed `assistant.reasoning_content` is ignored on input. For thinking-enabled ds4, Chat Completions cannot preserve the generated reasoning tail and repeatedly misses the live KV continuation boundary.

We do not plan to support ds4 with thinking disabled. That makes the Chat Completions adapter a historical/debug fallback rather than a viable product path.

Related docs:

- [phase-1.5-direct-responses-provider.md](./phase-1.5-direct-responses-provider.md)
- [../../debug/ds4-live-kv-cache-token-mismatch.md](../../debug/ds4-live-kv-cache-token-mismatch.md)
- [../../reference/ds4/server.md](../../reference/ds4/server.md)

## Objective

Remove the ds4 Chat Completions fallback and make `/v1/responses` the only supported direct ds4 endpoint.

By the end of this phase:

- `DS4_DIRECT_ENDPOINT` is removed
- `Ds4ChatCompletionsProvider` is deleted
- `createDs4ProviderFromConfig()` always returns `Ds4ResponsesProvider`
- `ds4_openai_chat` is no longer emitted by new provider-ledger rows
- tests/docs no longer preserve Chat Completions as an active code path
- historical `ds4_openai_chat` ledger rows can still be parsed for diagnostics/reconstruction where needed

## Scope

### In Scope

- direct service-local ds4 provider code
- provider-ledger request-mode typing and parsing
- agent request-mode recording
- provider tests and initialization tests
- direct ds4 env docs
- LLM/provider specs and ds4 plan docs

### Out Of Scope

- daemon local LLM capability work
- Bud-backed data-plane forwarding
- `/v1/messages` support
- deleting historical debug notes about Chat Completions failures
- database migrations for historical `llm_call.request_mode` values

## Design / Approach

### Endpoint Policy

Use exactly one direct ds4 endpoint:

```text
POST /v1/responses
```

Remove:

```text
DS4_DIRECT_ENDPOINT
Ds4ChatCompletionsProvider
ds4_openai_chat as a newly recorded request mode
```

Keep `ds4_openai_chat` only as a historical parse value if existing local debug rows or fixtures need to load. The provider ledger should not generate new `ds4_openai_chat` rows.

### Provider Code

`service/src/llm/providers/ds4.ts` should contain the Responses provider and shared ds4 helpers only.

Remove Chat-specific types and helpers:

- `ChatMessage`
- `ChatToolCall`
- `ChatCompletionTool`
- `ChatToolChoice`
- `ChatCompletionRequest`
- `ChatCompletionChunk`
- Chat stream diagnostics
- `toChatMessages()`
- `toChatTools()`
- `toChatToolChoice()`
- `mapStopReason()` if only used by Chat

Keep shared helpers used by Responses:

- base URL normalization
- SSE reader
- tool argument parsing
- context-window error detection
- capability metadata

### Config

Remove `DS4_DIRECT_ENDPOINT` from:

- `service/src/config.ts`
- `service/.env.example`
- config specs

`DS4_DIRECT_BASE_URL` remains the only direct-provider enable switch.

### Provider Ledger

Change `buildRequestMode("ds4")` to unconditionally return:

```text
ds4_openai_responses
```

Keep `parseRequestMode()` accepting `ds4_openai_chat` for historical rows unless we verify no persisted/local rows need it.

### Tests

Remove tests that assert Chat Completions request construction or Chat stream parsing.

Keep/add tests for:

- ds4 direct initialization creates a Responses provider
- Responses request construction
- Responses reasoning/text/tool/error stream parsing
- `buildRequestMode("ds4")` returns `ds4_openai_responses`
- historical `ds4_openai_chat` request-mode parsing does not break ledger reconstruction, if testable without DB complexity
- service build

## Implementation Tasks

### Task 1: Remove endpoint config

- Delete `Ds4DirectEndpoint` type and `toDs4DirectEndpoint()`.
- Delete `config.ds4DirectEndpoint`.
- Remove `DS4_DIRECT_ENDPOINT` from `.env.example`.
- Update specs that mention endpoint selection.

### Task 2: Delete Chat Completions provider code

- Delete `Ds4ChatCompletionsProvider`.
- Delete Chat request/stream types and helpers.
- Rename generic ds4 provider references where useful so `Ds4ResponsesProvider` is the only implementation.
- Ensure `createDs4ProviderFromConfig()` always returns `Ds4ResponsesProvider`.

### Task 3: Simplify request-mode recording

- Remove `ds4Endpoint` argument from `buildRequestMode()`.
- Update `AgentService` to call `buildRequestMode(providerName)` without ds4 options.
- Keep historical parser compatibility for `ds4_openai_chat`.

### Task 4: Prune tests

- Delete Chat Completions provider tests.
- Update provider-ledger tests.
- Update provider initialization tests.
- Keep Responses coverage for reasoning and tool calls.

### Task 5: Update docs and checklists

- Update [llm.spec.md](../../service/src/llm/llm.spec.md).
- Update [providers.spec.md](../../service/src/llm/providers/providers.spec.md).
- Update [src.spec.md](../../service/src/src.spec.md).
- Update ds4 plan docs and validation checklist.
- Leave historical debug docs intact, but add a note that Chat is now removed from active code.

## Impacted Contracts

- [ ] WSS protocol: no change
- [ ] SSE events: no browser-facing change
- [ ] DB schema: no change
- [x] Provider ledger: new ds4 rows use only `ds4_openai_responses`
- [x] LLM provider contract: ds4 has one direct endpoint implementation
- [ ] Web UI: no change

## Validation Checklist

- [x] `DS4_DIRECT_ENDPOINT` no longer exists in config or `.env.example`
- [x] direct ds4 still registers with `DS4_DIRECT_BASE_URL`
- [x] direct ds4 posts only to `/v1/responses`
- [x] no new code path can call `/v1/chat/completions` for provider `ds4`
- [x] `buildRequestMode("ds4")` returns `ds4_openai_responses`
- [x] historical `ds4_openai_chat` rows remain parseable
- [x] focused provider tests pass
- [x] focused ledger/init tests pass
- [x] service build passes

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Responses live cache still has unresolved issues | Medium | High | Complete Phase 1.5 live validation before daemon/data-plane rollout; fixes should target Responses, not restore Chat |
| Historical local ledger rows with `ds4_openai_chat` become unreadable | Low | Medium | Keep parser compatibility for historical request modes |
| Debugging loses a known baseline endpoint | Low | Low | Debug notes and direct `curl` probes can still use ds4 Chat outside Bud code |

## Exit Criteria

This phase is done when Bud's service code has no active ds4 Chat Completions provider path, all new ds4 provider-ledger rows use `ds4_openai_responses`, and the service builds with Responses-only ds4 tests.
