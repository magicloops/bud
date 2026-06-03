# Implementation Spec: ds4 Local LLM Over Bud

**Status**: Proposed
**Created**: 2026-06-02
**Folder Spec**: [ds4.spec.md](./ds4.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-contract-baseline-and-fixtures.md](./phase-0-contract-baseline-and-fixtures.md)
**Phase 1**: [phase-1-direct-local-dev-provider.md](./phase-1-direct-local-dev-provider.md)
**Phase 1.5**: [phase-1.5-direct-responses-provider.md](./phase-1.5-direct-responses-provider.md)
**Phase 2**: [phase-2-daemon-local-llm-capability.md](./phase-2-daemon-local-llm-capability.md)
**Phase 3**: [phase-3-bud-scoped-model-inventory-and-selection.md](./phase-3-bud-scoped-model-inventory-and-selection.md)
**Phase 4**: [phase-4-local-llm-data-plane-provider.md](./phase-4-local-llm-data-plane-provider.md)
**Phase 5**: [phase-5-responses-hardening-and-rollout.md](./phase-5-responses-hardening-and-rollout.md)
**Related Design**: [../../design/local-ds4-llm-over-bud.md](../../design/local-ds4-llm-over-bud.md)

---

## Context

Bud currently invokes LLMs from the service through OpenAI and Anthropic provider adapters. ds4 changes the topology: the model server is expected to run on the same machine as the Bud daemon, while the service may be cloud-hosted.

The implementation therefore needs two paths:

- a direct local-development path where `service` and ds4 run on the same host
- a Bud-backed path where the hosted service reaches ds4 through the authenticated daemon data plane

The direct path proves provider behavior without protocol changes. The Bud-backed path makes ds4 a Bud-scoped capability that is only available to the Bud owner.

## Objective

Make ds4 selectable as an additional model option when and only when a configured ds4 server is available.

By the end of this plan:

- local development can opt into a direct ds4 provider with `DS4_DIRECT_BASE_URL`
- Bud daemons can advertise a healthy local ds4 server through `capabilities.llm`
- `/api/models?bud_id=<owned-bud-id>` can include Bud-local ds4 models
- explicit ds4 selections fail clearly when the owning Bud lacks a healthy ds4 capability
- the hosted service can invoke Bud-local ds4 through a narrow authenticated data-plane stream
- ds4 calls use Bud's canonical streaming, tool-call, transcript, and provider-ledger pipeline

## Fixed Decisions

- ds4 provider identity is `ds4`; it is not registered as `openai` or `anthropic`.
- Chat Completions was the first implemented ds4 request surface.
- Responses is now the only active direct service-local endpoint because Chat Completions streams output-only `reasoning_content` that cannot be replayed in assistant history.
- The first product model id is `ds4-deepseek-v4-flash`.
- The provider model is `deepseek-v4-flash`.
- The `deepseek-v4-pro` alias is deferred until there is product value in exposing two aliases for the same loaded GGUF.
- Direct local-dev ds4 is service-local and opt-in only.
- Bud-backed ds4 uses logical server id `ds4`; the browser and service never supply raw localhost URLs.
- The daemon validates and owns local target resolution.
- No silent fallback from ds4 to a cloud model is allowed.

## Non-Goals

- Starting or installing `ds4-server`.
- Supervising ds4 health beyond startup probe/reconnect in the first release.
- Exposing arbitrary localhost HTTP proxying through the model provider.
- Making ds4 a production global default.
- Supporting remote LAN LLM servers.
- Replacing OpenAI Responses or Anthropic Messages providers.

## Provider And Model Contract

Initial catalog entry:

| Field | Value |
| --- | --- |
| Product id | `ds4-deepseek-v4-flash` |
| Provider | `ds4` |
| Provider model | `deepseek-v4-flash` |
| Display name | `ds4 DeepSeek V4` |
| Direct request mode | `ds4_openai_responses` |
| Historical request mode | `ds4_openai_chat` remains parseable for old local ledger rows only |
| Source, direct mode | `service_local_dev` |
| Source, Bud-backed mode | `bud_local` |

Reasoning controls remain a Phase 0 decision gate. The conservative first pass should expose no extra reasoning selector for ds4 unless fixtures confirm a stable parameter mapping to Bud's existing `reasoning_effort` values.

## Configuration

Direct service-local development:

```text
DS4_DIRECT_BASE_URL=http://127.0.0.1:8000/v1
DS4_DIRECT_MODEL=deepseek-v4-flash
DS4_DIRECT_CONTEXT_TOKENS=100000
DS4_DIRECT_MAX_OUTPUT_TOKENS=128000
```

Bud daemon local LLM discovery:

```text
BUD_LOCAL_LLM_DS4_URL=http://127.0.0.1:8000
BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS=100000
BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS=128000
```

The daemon config points at the local API origin without `/v1`. The daemon probes `GET /v1/models` and stores the exact loopback target locally.

## Target Capability Shape

```json
{
  "llm": {
    "local_api": true,
    "servers": [
      {
        "id": "ds4",
        "provider": "ds4",
        "compatibility": ["openai_chat_completions", "openai_responses", "anthropic_messages"],
        "models": [
          {
            "id": "deepseek-v4-flash",
            "display_name": "ds4 DeepSeek V4",
            "context_window_tokens": 100000,
            "max_output_tokens": 128000
          }
        ],
        "concurrency": 1,
        "healthy": true
      }
    ]
  }
}
```

## Bud-Backed Data-Plane Contract

The Bud-backed provider uses a dedicated local LLM stream family instead of browser proxy sessions.

Initial service-to-daemon open frame:

```json
{
  "type": "local_llm_open",
  "stream_type": "local_llm_http",
  "local_llm_server_id": "ds4",
  "method": "POST",
  "path": "/v1/responses",
  "headers": {
    "content-type": "application/json",
    "accept": "text/event-stream"
  },
  "request_body_bytes": 12345
}
```

`/v1/responses` is the active path after Phase 1.6. Reintroducing `/v1/chat/completions` for Bud-backed use would require a new design decision because the active service-local fallback has been removed.

The daemon resolves `local_llm_server_id` to configured local state, forwards only allowlisted loopback ds4 requests, and streams response bytes back through normal stream lifecycle frames.

## Ownership And Permission Boundaries

This plan changes browser-facing model inventory and message-send validation.

- `GET /api/models` without `bud_id` returns global service providers as today.
- `GET /api/models?bud_id=<id>` must authorize the Bud before appending local models.
- A signed-in non-owner requesting another user's Bud-local models gets `404`.
- Message send resolves the authorized thread, derives its Bud, and validates ds4 availability before persisting a user message.
- Thread model preferences may store `ds4-deepseek-v4-flash`, but each send must revalidate local availability.
- The browser never sends a local LLM host, port, URL, or API key.
- Prompt and transcript data transit through the hosted service before local inference; product copy must not imply end-to-end local privacy.

No database schema change is required unless implementation chooses to persist capability health separately from existing Bud capabilities.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 0 | [phase-0-contract-baseline-and-fixtures.md](./phase-0-contract-baseline-and-fixtures.md) | Urgent | Lock ds4 request/stream fixtures, model id policy, and request-mode names |
| 1 | [phase-1-direct-local-dev-provider.md](./phase-1-direct-local-dev-provider.md) | Urgent | Service can invoke a same-machine ds4 server as an opt-in local-dev model |
| 1.5 | [phase-1.5-direct-responses-provider.md](./phase-1.5-direct-responses-provider.md) | Urgent | Implement direct ds4 `/v1/responses` and validate whether it fixes Chat Completions reasoning replay/cache misses |
| 1.6 | [phase-1.6-remove-chat-completions-fallback.md](./phase-1.6-remove-chat-completions-fallback.md) | Urgent | Remove the ds4 Chat Completions fallback so Responses is the only active direct endpoint |
| 2 | [phase-2-daemon-local-llm-capability.md](./phase-2-daemon-local-llm-capability.md) | High | Daemon advertises configured healthy ds4 servers through hello capabilities |
| 3 | [phase-3-bud-scoped-model-inventory-and-selection.md](./phase-3-bud-scoped-model-inventory-and-selection.md) | High | Browser/API model inventory and message validation are Bud-aware |
| 4 | [phase-4-local-llm-data-plane-provider.md](./phase-4-local-llm-data-plane-provider.md) | High | Hosted service can invoke Bud-local ds4 through authenticated data-plane streams |
| 5 | [phase-5-responses-hardening-and-rollout.md](./phase-5-responses-hardening-and-rollout.md) | Medium | Chosen endpoint hardening, live validation, compatibility decisions, and rollout docs are complete |

## Expected Files And Areas

### Service

- `service/src/config.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/llm/registry.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/providers/`
- `service/src/agent/model-runner.ts`
- `service/src/routes/models.ts`
- `service/src/routes/threads/`
- `service/src/transport/`
- `service/src/ws/protocol.ts`
- `service/.env.example`
- `service/README.md`

### Bud Daemon

- `bud/src/config.rs`
- `bud/src/app.rs`
- `bud/src/transport.rs`
- `bud/src/proto_wire.rs`
- new daemon local LLM module if implementation needs one

### Protocol, Docs, And Specs

- `docs/proto.md`
- `proto/bud/v1/bud.proto` if typed protobuf fields are added
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/transport/transport.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

### Web

- `web/src/lib/models.ts`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- model/reasoning selector components if separate from routes

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| ds4 Chat Completions cannot replay output-only reasoning and repeatedly misses live KV cache | High | High | Add Phase 1.5 to validate `/v1/responses` before daemon/data-plane rollout |
| ds4 Responses stream deltas differ from OpenAI enough to break tool parsing | Medium | High | Capture fixtures first and keep ds4 parsing isolated behind provider tests |
| Direct local-dev ds4 becomes visible in hosted environments | Low | High | Register only with explicit `DS4_DIRECT_BASE_URL`; label source as service-local-dev |
| Local model appears globally instead of Bud-scoped | Medium | High | Add route and message-send tests for owner, non-owner, no-`bud_id`, and unavailable cases |
| Daemon local HTTP path becomes an arbitrary localhost proxy | Medium | High | Resolve logical server ids daemon-side and allowlist methods, paths, headers, and loopback origins |
| Long ds4 outputs overwhelm agent loop or storage | Medium | Medium | Enforce service and daemon max output/body/TTL limits before broad rollout |
| Prompt privacy is misunderstood | Medium | Medium | Document that prompts pass through the hosted service before reaching local ds4 |
| Existing provider ledger assumes only OpenAI/Anthropic | Medium | High | Extend canonical provider/request-mode types in Phase 1 and test replay/fallback paths |

## Rollout Strategy

1. Capture ds4 fixtures and lock the provider/request-mode contract.
2. Land direct local-dev provider support.
3. Historical: prove direct Chat Completions final-text and tool-call turns against the running server.
4. Prove direct Responses final-text, reasoning, and tool-call turns against the running server.
5. Validate `/v1/responses` live cache behavior before relying on it for Bud-backed use.
6. Add daemon config, probe, and capability advertisement.
7. Add Bud-scoped inventory and unavailable-model validation.
8. Add the local LLM stream family and Bud-backed provider using the chosen ds4 endpoint.
9. Prove Bud-backed final-text, terminal tool-loop, cancel, and ds4-stopped flows.
10. Complete docs/spec updates and product handoff.

## Open Questions

- Does ds4's `/v1/models` expose context/output metadata reliably, or should Bud always require explicit context config?
- Should ds4 reasoning be exposed as Bud `reasoning_effort`, a ds4-specific advanced option, or hidden in the first pass?
- Does `/v1/responses` provide replayable reasoning/continuation state for Bud's stateless transcript flow, or does it require server-side continuation ids?
- Should saved ds4 thread preferences remain selected while the Bud is offline, with send disabled, or should the selector force a cloud model before send?
- How much provider-native ds4 request/response shape should be retained in the ledger for exact replay and debugging?
- Should runtime health changes be sent through a new `capability_update` frame, or is reconnect-time detection sufficient for the first release?
- If a future local runner requires an API key, should the daemon inject it locally so the hosted service never sees it?

## Definition Of Done

- [ ] direct local-dev ds4 appears only when explicitly configured
- [ ] direct local-dev ds4 can complete final-text and terminal tool-call turns
- [ ] daemon advertises healthy configured ds4 through `capabilities.llm`
- [ ] Bud-scoped `/api/models` exposes local ds4 only to the owning user
- [ ] explicit ds4 send fails before user-message persistence when ds4 is unavailable
- [ ] Bud-backed provider streams the selected ds4 endpoint over authenticated data-plane frames
- [ ] cancellation resets the daemon stream and leaves provider/runtime state coherent
- [ ] provider ledger records new `ds4` calls with request mode `ds4_openai_responses`
- [ ] protocol, service, daemon, web, and root specs are updated as implementation lands
- [ ] [progress-checklist.md](./progress-checklist.md) and [validation-checklist.md](./validation-checklist.md) are updated with final status
