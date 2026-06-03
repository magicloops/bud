# ds4 Validation Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 1.6 automated cleanup complete; direct Responses live cache validation complete
**Last Updated**: 2026-06-03

---

## Automated Validation

### Service Provider And Catalog

- [x] Catalog accepts provider `ds4`
- [x] Catalog includes `ds4-deepseek-v4-flash`
- [x] OpenAI and Anthropic global defaults are unchanged
- [x] Direct ds4 is absent when `DS4_DIRECT_BASE_URL` is unset
- [x] Direct ds4 is present when `DS4_DIRECT_BASE_URL` is set
- [x] `ds4_openai_chat` request mode is accepted by provider-ledger typing
- [x] Chat Completions text stream fixture parses into canonical text deltas
- [x] Chat Completions tool-call stream fixture parses into canonical tool-call events
- [x] Chat Completions stream diagnostics detect output-only `reasoning_content`
- [x] Direct probe confirms Chat Completions ignores replayed `assistant.reasoning_content`
- [x] Chat Completions malformed/error fixture work retired after provider removal
- [x] `ds4_openai_responses` request mode is accepted by provider-ledger typing
- [x] Responses text stream fixture parses into canonical text deltas
- [x] Responses reasoning fixture is preserved or intentionally diagnostic-only
- [x] Responses tool-call fixture parses into canonical tool-call events
- [ ] Responses post-tool continuation fixture preserves replay continuity
- [x] `DS4_DIRECT_ENDPOINT` is removed
- [x] `Ds4ChatCompletionsProvider` is removed
- [x] direct ds4 provider code cannot call `/v1/chat/completions`
- [x] new ds4 provider-ledger rows use `ds4_openai_responses`
- [x] historical `ds4_openai_chat` rows remain parseable

### Routes And Ownership

- [ ] `GET /api/models` excludes Bud-local ds4 models
- [ ] owned `GET /api/models?bud_id=...` includes healthy Bud-local ds4
- [ ] Bud-local ds4 inventory includes Responses request-mode/compatibility metadata
- [ ] Bud-local ds4 inventory does not expose endpoint or mode selectors
- [ ] owned `GET /api/models?bud_id=...` excludes absent/unhealthy ds4
- [ ] non-owner `GET /api/models?bud_id=...` returns `404`
- [ ] message send rejects unknown ds4 model ids
- [ ] message send rejects unavailable ds4 before user-message insert
- [ ] cloud model sends remain unchanged

### Daemon Capability

- [ ] daemon rejects non-loopback ds4 URLs
- [ ] daemon omits `capabilities.llm` when probe fails
- [ ] daemon advertises `capabilities.llm` when probe succeeds
- [ ] daemon advertises only `openai_responses` compatibility for ds4
- [ ] daemon advertises logical request mode `ds4_openai_responses`
- [ ] daemon advertises logical generation path `/v1/responses`
- [ ] hello payload does not include raw local URL
- [ ] service hello schema preserves `capabilities.llm`

### Data Plane

- [ ] service rejects Bud-backed ds4 when no data-plane carrier is available
- [ ] service rejects Bud-backed ds4 when Bud lacks ds4 capability
- [ ] daemon rejects unknown local LLM server ids
- [ ] daemon rejects disallowed paths
- [ ] daemon rejects disallowed methods
- [ ] daemon allows ds4 generation only through `/v1/responses`
- [ ] daemon strips forbidden headers
- [ ] daemon enforces request body limit
- [ ] daemon enforces response body limit
- [ ] daemon enforces idle/TTL limits
- [ ] daemon enforces concurrency limit
- [ ] cancellation sends stream reset
- [ ] provider-ledger records provider `ds4` and request mode `ds4_openai_responses`
- [ ] Bud-backed provider replays Responses `function_call` / `function_call_output` history after tool calls
- [ ] Bud-backed provider preserves Responses reasoning payloads for replay when available

## Live Validation

Run against an already-running ds4 server. The validation does not require Bud to start ds4.

### Direct Service-Local Mode

- [x] configure `DS4_DIRECT_BASE_URL`
- [x] service-side provider inventory includes `ds4-deepseek-v4-flash` when `DS4_DIRECT_BASE_URL` is set
- [x] one final-text direct-provider stream completes
- [x] one terminal tool-call direct-provider stream completes
- [x] cancellation during direct-provider streaming aborts generation
- [x] Chat Completions agent-turn cache miss cause identified as output-only reasoning replay
- [ ] direct `/v1/responses` final-text stream completes
- [ ] direct `/v1/responses` terminal tool-call stream completes
- [ ] direct `/v1/responses` post-tool continuation completes
- [x] direct `/v1/responses` live cache behavior improves over Chat Completions
- [ ] `GET /api/models` shows `ds4-deepseek-v4-flash`
- [ ] one final-text agent turn completes
- [ ] one terminal tool-call agent turn completes
- [ ] cancellation during streaming stops generation and leaves the turn coherent
- [ ] service restart preserves normal OpenAI/Anthropic behavior when ds4 env is removed

### Bud-Backed Mode

- [ ] configure `BUD_LOCAL_LLM_DS4_URL`
- [ ] daemon hello advertises `capabilities.llm`
- [ ] owned `GET /api/models?bud_id=...` shows ds4
- [ ] non-owner cannot see ds4 for that Bud
- [ ] one final-text agent turn completes through the daemon stream
- [ ] one terminal tool-call loop completes through the daemon stream
- [ ] cancellation resets the daemon stream
- [ ] stopping ds4 before send fails clearly
- [ ] stopping ds4 mid-stream fails clearly
- [ ] reconnect after ds4 starts makes capability available again
- [ ] concurrent requests serialize, reject, or queue according to documented concurrency policy

## Documentation And Handoff

- [ ] `docs/proto.md` documents `capabilities.llm` and `local_llm_http`
- [x] service LLM/provider specs document provider `ds4`
- [ ] service route specs document Bud-scoped model inventory
- [ ] service transport/ws specs document local LLM streams
- [ ] daemon spec documents local LLM config, probe, and forwarding policy
- [ ] web specs document Bud-scoped model inventory usage if web changes land
- [ ] product handoff says local inference still sends prompt context through hosted service
- [ ] [progress-checklist.md](./progress-checklist.md) is final
