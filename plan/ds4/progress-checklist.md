# ds4 Progress Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 1 complete; Phase 1.5 service implementation complete, live cache validation pending
**Last Updated**: 2026-06-03

---

## Phase 0: Contract Baseline And Fixtures

- [ ] Capture Chat Completions final-text fixture
- [ ] Capture Chat Completions streaming final-text fixture
- [ ] Capture Chat Completions tool-call fixture
- [ ] Capture Chat Completions error fixture
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
- [x] Add `DS4_DIRECT_ENDPOINT=responses|chat_completions`
- [x] Implement direct `Ds4ResponsesProvider`
- [x] Preserve Chat Completions fallback during transition
- [x] Add Responses provider tests
- [ ] Run direct Responses final-text live smoke
- [ ] Run direct Responses terminal tool-call live smoke
- [ ] Compare Responses live cache behavior against Chat Completions
- [x] Decide whether direct ds4 defaults to Responses

## Phase 2: Daemon Local LLM Capability

- [ ] Add daemon `BUD_LOCAL_LLM_DS4_*` config
- [ ] Validate daemon ds4 URL is loopback-only
- [ ] Probe `GET /v1/models` before hello
- [ ] Add `capabilities.llm` hello payload
- [ ] Keep raw local URL out of hello
- [ ] Preserve `capabilities.llm` in service hello parsing
- [ ] Persist local LLM capability metadata with Bud capabilities
- [ ] Update protocol and spec docs

## Phase 3: Bud-Scoped Model Inventory And Selection

- [ ] Add `GET /api/models?bud_id=<owned-bud-id>`
- [ ] Authorize Bud ownership before local model projection
- [ ] Append healthy Bud-local ds4 model metadata
- [ ] Keep global `/api/models` behavior unchanged
- [ ] Validate ds4 model selection against the thread Bud
- [ ] Reject unavailable ds4 before user-message insert
- [ ] Update web model loading to request Bud-scoped inventory
- [ ] Add route/model-selection tests

## Phase 4: Local LLM Data-Plane Provider

- [ ] Add `local_llm_http` stream family
- [ ] Add service-to-daemon local LLM open/result frames
- [ ] Extend provider invocation context with thread/Bud/owner routing data
- [ ] Implement `BudLocalDs4Provider`
- [ ] Implement daemon local LLM HTTP forwarding
- [ ] Enforce daemon target, path, header, body, response, TTL, and concurrency limits
- [ ] Reset daemon stream on cancellation
- [ ] Record provider-ledger calls with the selected ds4 request mode
- [ ] Add daemon/service deterministic tests
- [ ] Run Bud-backed final-text live smoke
- [ ] Run Bud-backed terminal tool-loop live smoke

## Phase 5: Responses Hardening And Rollout

- [ ] Validate stopped-ds4-before-send behavior
- [ ] Validate stopped-ds4-mid-stream behavior
- [ ] Validate Bud reconnect health behavior
- [ ] Validate concurrent request behavior
- [ ] Confirm `/v1/responses` rollout status from Phase 1.5
- [ ] Decide `/v1/messages` support
- [ ] Finalize audit/log coverage
- [ ] Update product/deployment handoff text
- [ ] Complete final docs/spec updates
- [ ] Complete validation checklist
