# ds4 Progress Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 2-5 implementation hardening complete; Bud-backed live validation pending
**Last Updated**: 2026-06-03

---

## Phase 0: Contract Baseline And Fixtures

- [x] Retire remaining Chat Completions fixture capture from the active plan after Phase 1.6
- [ ] Probe `/v1/responses`
- [ ] Probe `/v1/messages`
- [ ] Confirm first product id `ds4-deepseek-v4-flash`
- [ ] Confirm `deepseek-v4-pro` alias deferral
- [ ] Decide first-pass reasoning mapping
- [ ] Confirm initial context/output/concurrency limits

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

- [ ] Capture `/v1/responses` final-text fixture
- [ ] Capture `/v1/responses` reasoning fixture
- [ ] Capture `/v1/responses` tool-call fixture
- [ ] Capture `/v1/responses` post-tool continuation fixture
- [x] Add `ds4_openai_responses` request mode
- [x] Add `DS4_DIRECT_ENDPOINT=responses|chat_completions` for the temporary Phase 1.5 transition
- [x] Implement direct `Ds4ResponsesProvider`
- [x] Preserve Chat Completions fallback during transition
- [x] Add Responses provider tests
- [ ] Run direct Responses final-text live smoke
- [ ] Run direct Responses terminal tool-call live smoke
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
- [ ] Run Bud-backed final-text live smoke
- [ ] Run Bud-backed terminal tool-loop live smoke

## Phase 5: Responses Hardening And Rollout

- [ ] Validate stopped-ds4-before-send behavior
- [ ] Validate stopped-ds4-mid-stream behavior
- [ ] Validate Bud reconnect health behavior
- [ ] Validate concurrent request behavior
- [x] Confirm `/v1/responses` rollout status from Phase 1.5
- [x] Decide `/v1/messages` support
- [x] Finalize audit/log coverage
- [x] Update product/deployment handoff text
- [x] Complete final docs/spec updates
- [ ] Complete validation checklist
