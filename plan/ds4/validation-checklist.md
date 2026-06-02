# ds4 Validation Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed
**Last Updated**: 2026-06-02

---

## Automated Validation

### Service Provider And Catalog

- [ ] Catalog accepts provider `ds4`
- [ ] Catalog includes `ds4-deepseek-v4-flash`
- [ ] OpenAI and Anthropic global defaults are unchanged
- [ ] Direct ds4 is absent when `DS4_DIRECT_BASE_URL` is unset
- [ ] Direct ds4 is present when `DS4_DIRECT_BASE_URL` is set
- [ ] `ds4_openai_chat` request mode is accepted by provider-ledger typing
- [ ] Chat Completions text stream fixture parses into canonical text deltas
- [ ] Chat Completions tool-call stream fixture parses into canonical tool-call events
- [ ] Chat Completions malformed/error fixture normalizes to a provider error

### Routes And Ownership

- [ ] `GET /api/models` excludes Bud-local ds4 models
- [ ] owned `GET /api/models?bud_id=...` includes healthy Bud-local ds4
- [ ] owned `GET /api/models?bud_id=...` excludes absent/unhealthy ds4
- [ ] non-owner `GET /api/models?bud_id=...` returns `404`
- [ ] message send rejects unknown ds4 model ids
- [ ] message send rejects unavailable ds4 before user-message insert
- [ ] cloud model sends remain unchanged

### Daemon Capability

- [ ] daemon rejects non-loopback ds4 URLs
- [ ] daemon omits `capabilities.llm` when probe fails
- [ ] daemon advertises `capabilities.llm` when probe succeeds
- [ ] hello payload does not include raw local URL
- [ ] service hello schema preserves `capabilities.llm`

### Data Plane

- [ ] service rejects Bud-backed ds4 when no data-plane carrier is available
- [ ] service rejects Bud-backed ds4 when Bud lacks ds4 capability
- [ ] daemon rejects unknown local LLM server ids
- [ ] daemon rejects disallowed paths
- [ ] daemon rejects disallowed methods
- [ ] daemon strips forbidden headers
- [ ] daemon enforces request body limit
- [ ] daemon enforces response body limit
- [ ] daemon enforces idle/TTL limits
- [ ] daemon enforces concurrency limit
- [ ] cancellation sends stream reset
- [ ] provider-ledger records provider `ds4` and request mode `ds4_openai_chat`

## Live Validation

Run against an already-running ds4 server. The validation does not require Bud to start ds4.

### Direct Service-Local Mode

- [ ] configure `DS4_DIRECT_BASE_URL`
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
- [ ] service LLM/provider specs document provider `ds4`
- [ ] service route specs document Bud-scoped model inventory
- [ ] service transport/ws specs document local LLM streams
- [ ] daemon spec documents local LLM config, probe, and forwarding policy
- [ ] web specs document Bud-scoped model inventory usage if web changes land
- [ ] product handoff says local inference still sends prompt context through hosted service
- [ ] [progress-checklist.md](./progress-checklist.md) is final
