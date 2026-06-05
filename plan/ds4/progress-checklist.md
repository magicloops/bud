# ds4 Progress Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Core implementation complete; lifecycle validation follow-ups pending
**Last Updated**: 2026-06-04

---

## Phase 0: Contract Baseline And Fixtures

- [x] Retire remaining Chat Completions fixture capture from the active plan after Phase 1.6
- [x] Probe and select `/v1/responses` as the active ds4 endpoint
- [x] Decide `/v1/messages` support is deferred
- [x] Confirm first product id `ds4-deepseek-v4-flash`
- [x] Confirm `deepseek-v4-pro` alias deferral
- [x] Decide first-pass reasoning mapping: `Fast` / `Thinking`, with `max` deferred
- [x] Confirm initial context/output/concurrency limits

## Phase 1: Direct Local Dev Provider

- [x] Add `ds4` provider vocabulary
- [x] Add `ds4_openai_chat` request mode
- [x] Add `ds4-deepseek-v4-flash` catalog entry
- [x] Add `DS4_DIRECT_*` config parsing
- [x] Register direct provider only when configured
- [x] Implement Chat Completions request lowering
- [x] Implement Chat Completions SSE parser
- [x] Add direct provider tests
- [x] Run direct final-text live smoke
- [x] Run direct tool-call live smoke

## Phase 1.5: Direct Responses Provider

- [x] Cover `/v1/responses` final-text stream shape in provider tests
- [x] Cover `/v1/responses` reasoning stream shape in provider tests
- [x] Cover `/v1/responses` tool-call stream shape in provider tests
- [x] Cover `/v1/responses` post-tool continuation/replay shape in provider tests
- [x] Add `ds4_openai_responses` request mode
- [x] Add `DS4_DIRECT_ENDPOINT=responses|chat_completions` for the temporary Phase 1.5 transition, then remove it in Phase 1.6
- [x] Implement direct `Ds4ResponsesProvider`
- [x] Preserve Chat Completions fallback during transition, then remove it in Phase 1.6
- [x] Add Responses provider tests
- [x] Validate Responses final-text behavior through direct/local and Bud-backed smoke coverage
- [x] Validate Responses terminal tool-call behavior through direct/local and Bud-backed smoke coverage
- [x] Compare Responses live cache behavior against Chat Completions
- [x] Decide whether direct ds4 defaults to Responses

## Phase 1.6: Remove Chat Completions Fallback

- [x] Remove `DS4_DIRECT_ENDPOINT`
- [x] Delete `Ds4ChatCompletionsProvider`
- [x] Remove active `/v1/chat/completions` ds4 request path
- [x] Make direct ds4 always use `Ds4ResponsesProvider`
- [x] Make new ds4 ledger rows always use `ds4_openai_responses`
- [x] Preserve historical `ds4_openai_chat` parsing
- [x] Remove Chat Completions provider tests
- [x] Update LLM/provider/config specs
- [x] Run focused provider/ledger/init tests
- [x] Run service build

## Phase 2: Daemon Local LLM Capability

- [x] Add daemon `BUD_LOCAL_LLM_DS4_*` config
- [x] Validate daemon ds4 URL is loopback-only
- [x] Probe `GET /v1/models` before hello
- [x] Add `capabilities.llm` hello payload
- [x] Advertise only `openai_responses` compatibility for ds4
- [x] Include logical `ds4_openai_responses` request mode and `/v1/responses` generation path
- [x] Keep raw local URL out of hello
- [x] Preserve `capabilities.llm` in service hello parsing
- [x] Persist local LLM capability metadata with Bud capabilities
- [x] Update protocol and spec docs

## Phase 3: Bud-Scoped Model Inventory And Selection

- [x] Add `GET /api/models?bud_id=<owned-bud-id>`
- [x] Authorize Bud ownership before local model projection
- [x] Append healthy Responses-backed Bud-local ds4 model metadata
- [x] Avoid endpoint/mode selectors for Bud-local ds4
- [x] Keep global `/api/models` behavior unchanged
- [x] Validate ds4 model selection against the thread Bud
- [x] Reject unavailable ds4 before user-message insert
- [x] Update web model loading to request Bud-scoped inventory
- [x] Add route/model-selection tests

## Phase 4: Local LLM Data-Plane Provider

- [x] Add `local_llm_http` stream family
- [x] Add service-to-daemon local LLM open/result frames
- [x] Extend provider invocation context with thread/Bud/owner routing data
- [x] Implement Responses-backed `BudLocalDs4Provider`
- [x] Replay Responses `function_call` / `function_call_output` history across tool loops
- [x] Preserve ds4 Responses reasoning payloads for same-provider replay where available
- [x] Implement daemon local LLM HTTP forwarding
- [x] Enforce daemon target, path, header, body, response, and concurrency limits
- [x] Reset daemon stream on cancellation
- [x] Record provider-ledger calls with `ds4_openai_responses`
- [x] Add daemon/service deterministic tests
- [x] Run Bud-backed final-text live smoke
- [x] Run Bud-backed terminal tool-loop live smoke

## Phase 5: Responses Hardening And Rollout

- [x] Validate Bud-backed cancellation behavior
- [x] Validate Bud-backed Responses cache behavior
- [ ] Validate stopped-ds4-before-send behavior
- [ ] Validate stopped-ds4-mid-stream behavior
- [ ] Validate Bud reconnect health behavior
- [x] Validate concurrent request behavior rejects excess local LLM streams instead of interrupting the active thread
- [x] Confirm `/v1/responses` rollout status from Phase 1.5
- [x] Decide `/v1/messages` support
- [x] Finalize audit/log coverage
- [x] Update product/deployment handoff text
- [x] Complete final docs/spec updates
- [ ] Complete remaining lifecycle validation checklist items

## Phase 6: Generic Agent Failure Messages

- [ ] Deferred: decide whether durable failure artifacts belong in transcript, model context, both, or neither
- [ ] Add generic client-safe agent failure formatter
- [ ] Persist failed assistant transcript rows for non-cancel failures
- [ ] Emit failed rows through existing `agent.message` and `final` events
- [ ] Keep canceled turns from creating failed assistant rows
- [ ] Avoid assistant-completed push/outbox side effects for failed rows unless explicitly chosen
- [ ] Add focused agent/transcript/runtime tests
- [ ] Update agent/runtime/route/web specs

## Phase 6.1: Runtime Agent Error Surfacing

- [x] Add generic client-safe runtime failure formatter
- [x] Add runtime-state `last_error` to `/agent/state`
- [x] Set `last_error` on non-cancel agent failures
- [x] Clear `last_error` on new accepted sends, success, and cancellation
- [x] Pipe refreshed `last_error` to the existing composer error slot
- [x] Keep runtime failures out of transcript rows and model replay
- [x] Add service runtime/route and web feature tests

## Phase 7: ds4 Output Budget And Request Caps

- [x] Decide and apply ds4 `maxOutputTokens = 384000` with `reservedOutputTokens = 20000`
- [x] Update service catalog, ds4 provider, and direct config defaults
- [x] Update daemon ds4 advertised max-output default
- [x] Cap agent request `maxOutputTokens` from selected model/provider capabilities
- [x] Normalize Bud-local ds4 projection so daemon metadata cannot widen product caps
- [x] Update ds4 env examples and capability examples
- [x] Add catalog, models route, provider, model-runner, and daemon tests

## Phase 8: ds4 Thinking Mode Controls

- [x] Add ds4-specific catalog reasoning control metadata
- [x] Expose ds4 `Fast` and `Thinking` options through `/api/models`
- [x] Keep ds4 `max` hidden for the current 100k context profile
- [x] Lower ds4 `Fast` to explicit `reasoning.effort = "none"`
- [x] Reject explicit ds4 `max` before durable message side effects
- [x] Add catalog, model route, reasoning-policy, provider, and message route tests
