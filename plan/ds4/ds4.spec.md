# ds4

Phased implementation planning documents for adding ds4, antirez's local LLM runner, as a Bud-selectable model provider first in local development and then through an owned Bud daemon data-plane path.

## Purpose

This folder turns [../../design/local-ds4-llm-over-bud.md](../../design/local-ds4-llm-over-bud.md) into an actionable implementation plan.

The plan assumes:

- ds4 is already running on the machine; Bud does not install, start, or supervise it.
- ds4 should be represented as provider `ds4`, not as `openai` or `anthropic`, even when using compatible HTTP endpoints.
- OpenAI Chat Completions was the first implementation target.
- OpenAI Responses is now the only active direct service-local endpoint because Chat Completions streams output-only `reasoning_content` that cannot be replayed through request history.
- Anthropic Messages compatibility remains a later validation target.
- Bud-backed ds4 models are Bud environment capabilities and must only appear for the owning user and the owning Bud.
- The hosted service sees prompts and transcript context before forwarding them to the local model; local inference is not end-to-end private from the service.

## Files

### `implementation-spec.md`

Parent implementation spec for the ds4 rollout.

Documents:

- fixed provider, model, and routing decisions
- phase sequencing
- daemon and service contracts
- ownership and security boundaries
- risks, open questions, and definition of done

### `phase-0-contract-baseline-and-fixtures.md`

Foundation phase covering:

- ds4 endpoint fixture capture
- product model id and alias policy
- Chat Completions request/stream contract
- initial reasoning/output-limit decisions
- provider-ledger request-mode naming

### `phase-1-direct-local-dev-provider.md`

Service-only phase covering:

- `ds4` provider vocabulary and catalog entry
- direct local-dev config
- Chat Completions provider adapter
- stream/tool-call parsing
- direct local smoke tests

### `phase-1.5-direct-responses-provider.md`

Direct-provider follow-up phase covering:

- `/v1/responses` fixture capture
- `ds4_openai_responses` request mode
- direct local-dev provider endpoint switch
- Responses stream/reasoning/tool-call parsing
- live cache validation against the Chat Completions `reasoning_content` replay limitation

### `phase-1.6-remove-chat-completions-fallback.md`

Direct-provider cleanup phase covering:

- removed `DS4_DIRECT_ENDPOINT`
- deleted the ds4 Chat Completions provider fallback
- making `/v1/responses` the only active direct ds4 endpoint
- keeping historical `ds4_openai_chat` ledger rows parseable if needed

### `phase-2-daemon-local-llm-capability.md`

Daemon capability phase covering:

- daemon ds4 local API config
- startup probe and loopback validation
- `capabilities.llm` hello payload
- service capability preservation
- protocol and spec updates

### `phase-3-bud-scoped-model-inventory-and-selection.md`

API and selection phase covering:

- `GET /api/models?bud_id=<owned-bud-id>`
- local model visibility by Bud ownership and capability health
- thread/message model validation
- explicit unavailable-local-model failures
- first-party web selector adoption

### `phase-4-local-llm-data-plane-provider.md`

Bud-backed invocation phase covering:

- `local_llm_http` stream family
- service-to-daemon local LLM open/result frames
- daemon loopback allowlist and HTTP forwarding policy
- `BudLocalDs4Provider`
- provider-ledger `ds4` request recording
- cancellation and stream reset behavior

### `phase-5-responses-hardening-and-rollout.md`

Finalization phase covering:

- hardening after the direct Responses decision
- optional `/v1/messages` decision
- limits, audit, concurrency, and reconnect hardening
- live/manual validation
- deployment and product handoff

### `progress-checklist.md`

Running implementation checklist for the ds4 rollout.

### `validation-checklist.md`

Automated and manual validation checklist for the ds4 rollout.

## Dependencies

- [../../design/local-ds4-llm-over-bud.md](../../design/local-ds4-llm-over-bud.md) - source design
- [../../reference/ds4/server.md](../../reference/ds4/server.md) - ds4 server API reference
- [../llm-models/implementation-spec.md](../llm-models/implementation-spec.md) - model catalog and reasoning-control precedent
- [../swappable-transport/implementation-spec.md](../swappable-transport/implementation-spec.md) - WebSocket-first data-plane carrier precedent
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - current service LLM abstraction spec
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - current provider adapter spec
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent model-runner ownership
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - route/API ownership
- [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md) - data-plane router ownership
- [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md) - daemon WebSocket protocol parsing
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon source ownership
- [../../docs/proto.md](../../docs/proto.md) - daemon-service wire protocol
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Fixed Decisions

- Use provider id `ds4` for catalog, provider registry, diagnostics, and provider-ledger rows.
- `ds4_openai_chat` was the first implemented ds4 request mode and remains parseable for historical local ledger rows.
- Use `ds4_openai_responses` as the only active direct service-local request mode.
- Phase 1.6 removed the Chat Completions fallback because thinking-enabled ds4 cannot replay Chat `reasoning_content`.
- Add only `ds4-deepseek-v4-flash` as the first product model; the `deepseek-v4-pro` alias is deferred because ds4 currently maps both names to the same loaded GGUF.
- Register direct service-local ds4 only when explicit `DS4_DIRECT_*` config is present.
- Advertise Bud-backed ds4 only when the daemon probes a configured loopback ds4 API successfully.
- Route hosted-service ds4 calls through a narrow local LLM stream family, not through browser proxy sessions.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
