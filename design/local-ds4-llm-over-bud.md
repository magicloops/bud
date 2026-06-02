# Design: Local ds4 LLM Over Bud

**Date:** 2026-06-02
**Status:** Proposed
**Implementation Plan:** [../plan/ds4/implementation-spec.md](../plan/ds4/implementation-spec.md)

## Context

Bud currently treats LLM providers as service-side integrations. The service resolves a selected product model through the catalog/registry, calls a singleton provider adapter, stores canonical output in the provider ledger, and drives terminal/web-view tools over the Bud daemon data plane.

ds4 is different from OpenAI and Anthropic because it usually runs beside the Bud daemon on the user's machine. The cloud-hosted service should be able to use that model only for threads whose Bud advertises a reachable local LLM API. This makes ds4 an environment capability of a Bud, not a globally available service provider.

Related docs and specs:

- [../reference/ds4/server.md](../reference/ds4/server.md)
- [./llm-model-catalog-and-reasoning-controls.md](./llm-model-catalog-and-reasoning-controls.md)
- [./model-preferences-and-thread-overrides.md](./model-preferences-and-thread-overrides.md)
- [./live-llm-provider-smoke-tests.md](./live-llm-provider-smoke-tests.md)
- [../service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [../service/src/llm/providers/providers.spec.md](../service/src/llm/providers/providers.spec.md)
- [../service/src/transport/transport.spec.md](../service/src/transport/transport.spec.md)
- [../service/src/ws/ws.spec.md](../service/src/ws/ws.spec.md)
- [../bud/src/src.spec.md](../bud/src/src.spec.md)
- [../docs/proto.md](../docs/proto.md)

## ds4 Server Facts

The local ds4 server exposes OpenAI- and Anthropic-compatible endpoints:

- `GET /v1/models`
- `GET /v1/models/deepseek-v4-flash`
- `GET /v1/models/deepseek-v4-pro`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/completions`
- `POST /v1/messages`

The `deepseek-v4-flash` and `deepseek-v4-pro` model names are compatibility aliases for the currently loaded GGUF; they do not select different weights. The server supports SSE streaming, tool calls, and reasoning/thinking shapes across the chat, Responses, and Anthropic-compatible endpoints.

The server serializes inference through one graph worker. Bud should assume only one active ds4 generation per Bud at first, even if multiple HTTP clients connect concurrently.

## Goals

- Add a local-development path where a service running on the same machine as ds4 can expose ds4 as a selectable model.
- Add a Bud-backed path where the hosted service can call a ds4 server on the Bud machine through the authenticated daemon data plane.
- Show ds4 models only for Buds that advertise a configured and healthy local LLM endpoint.
- Preserve Bud ownership boundaries: model inventory, selection, and invocation must be scoped to the authenticated owner and thread Bud.
- Keep provider output in Bud's canonical stream/ledger pipeline so tool calls, assistant streaming, context compaction, and thread model preferences continue to work.

## Non-Goals

- Starting, installing, or supervising `ds4-server`.
- Exposing arbitrary localhost HTTP proxying as a model provider.
- Supporting remote LAN LLM servers in the first pass.
- Making ds4 a global service default.
- Replacing OpenAI/Anthropic provider adapters.

## Current Constraints

- `GET /api/models` is authenticated but global. It filters by configured service providers, not by Bud.
- `ModelCatalogEntry.provider` and `CanonicalProviderId` currently assume provider ids are `openai` or `anthropic`.
- `AgentModelRunner` resolves a singleton provider and calls `provider.invoke(messages, tools, config, signal)`. Provider adapters do not receive `thread_id`, `bud_id`, or owner context today.
- The daemon already advertises data-plane stream families for file and localhost proxy work, but not local LLM APIs.
- The existing localhost proxy is browser/product oriented. It authorizes proxy sessions, forwards browser-shaped headers/cookies, and streams response bytes to Fastify replies. A model provider needs a narrower request path that returns a provider-like streaming body to the LLM adapter.

## Recommended Shape

Treat ds4 as a first-class `ds4` provider in the catalog and ledger, with endpoint-specific request modes such as `ds4_openai_chat` and later `ds4_openai_responses` / `ds4_anthropic_messages`.

Do not register ds4 as `openai`. It is OpenAI-compatible at the HTTP boundary, but provider identity matters for replay, diagnostics, availability, and avoiding accidental cloud fallback.

Use OpenAI Chat Completions first for the initial ds4 provider adapter because it is the most conventional local-runner compatibility surface and ds4 explicitly supports tools and streaming there. Add a Responses-mode adapter after chat completions works with Bud's tool loop, because Bud's existing OpenAI adapter is Responses-first and ds4's Responses support may be useful for reasoning continuity.

## Phase 1: Direct Local Dev Provider

Add a dev-only direct provider path for the case where `service` and ds4 run on the same machine.

Suggested config:

```text
DS4_DIRECT_BASE_URL=http://127.0.0.1:8000/v1
DS4_DIRECT_MODEL=deepseek-v4-flash
DS4_DIRECT_CONTEXT_TOKENS=100000
DS4_DIRECT_MAX_OUTPUT_TOKENS=128000
```

Implementation direction:

- Add `ds4` to the model catalog provider vocabulary.
- Add a catalog entry such as `ds4-deepseek-v4-flash` with provider model `deepseek-v4-flash`.
- Add `Ds4ChatCompletionsProvider` or a reusable `OpenAIChatCompletionsProvider` configured with the ds4 base URL.
- Register it only when `DS4_DIRECT_BASE_URL` is configured.
- Keep it opt-in and local-dev labeled in display metadata, not as a production global default.
- Add live smoke tests under the existing opt-in live LLM smoke pattern.

This phase proves model selection, tool parsing, streaming, and provider-ledger writes without changing the daemon protocol.

## Phase 2: Bud Local LLM Capability

Add daemon config for a local ds4 API without starting the server:

```text
BUD_LOCAL_LLM_DS4_URL=http://127.0.0.1:8000
BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS=100000
BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS=128000
```

Daemon behavior:

- Probe `GET /v1/models` during startup before `hello`.
- Advertise a new `capabilities.llm` object only when the probe succeeds.
- Preserve exact loopback target internally on the daemon; the service should address a logical server id, not arbitrary host/port.
- Initially require daemon restart/reconnect when ds4 starts or stops. Add runtime capability updates later if needed.

Example capability:

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

Service changes:

- Extend `HelloSchema` capability preservation to include `llm`.
- Persist `bud.capabilities.llm` as normal Bud capabilities.
- Add `local_llm_http` as a data-plane stream family when the daemon advertises both `bud_envelope.stream_frames` and a local LLM server.
- Update `docs/proto.md`, `service/src/ws/ws.spec.md`, `bud/src/src.spec.md`, and transport specs.

## Phase 3: Bud-Backed Provider Invocation

Add a purpose-built local LLM data-plane path rather than reusing browser proxy sessions.

Recommended frame family:

- `local_llm_open` from service to daemon
- `local_llm_open_result` from daemon to service
- `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` for request/response bodies

The service sends a logical target:

```json
{
  "type": "local_llm_open",
  "stream_type": "local_llm_http",
  "local_llm_server_id": "ds4",
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": {
    "content-type": "application/json",
    "accept": "text/event-stream"
  },
  "request_body_bytes": 12345
}
```

Daemon policy:

- Resolve `local_llm_server_id` to its local configured URL.
- Permit only configured loopback ds4 targets by default.
- Permit only known API paths under `/v1`.
- Strip cookies and browser auth headers.
- Inject local-only API auth if a future ds4-compatible server needs it; do not send local API secrets to the cloud service.
- Enforce method, body, response, idle, TTL, and concurrency limits.

Service provider changes:

- Extend `ModelConfig` or provider invocation context with routing metadata:

```typescript
{
  threadId: string;
  budId: string;
  ownerUserId: string;
}
```

- Let `BudLocalDs4Provider` open `local_llm_http` streams through `selectDataPlaneCarrier`.
- Parse ds4's streaming Chat Completions SSE into Bud canonical stream events.
- Record calls with provider `ds4`, request mode `ds4_openai_chat`, model `deepseek-v4-flash`, and the owning user stamp.
- Use the same cancellation signal to reset the daemon stream when the user cancels the turn.

This requires extending the provider ledger provider/request-mode types beyond `openai` and `anthropic`.

## Model Inventory And Selection

Add a Bud-scoped model inventory route instead of making local models globally visible:

```text
GET /api/models?bud_id=<owned-bud-id>
```

Compatibility behavior:

- Without `bud_id`, return only globally configured service providers as today.
- With `bud_id`, authorize the Bud first, then append healthy local models from that Bud's capabilities.
- Signed-in non-owners get `404`.
- The thread serializer should use the owning thread's Bud when resolving effective model metadata.

Local model ids should be stable product ids, for example:

```text
ds4-deepseek-v4-flash
```

The provider route should expose enough metadata for clients to communicate locality:

```json
{
  "id": "ds4-deepseek-v4-flash",
  "provider": "ds4",
  "provider_model": "deepseek-v4-flash",
  "display_name": "ds4 DeepSeek V4",
  "source": {
    "kind": "bud_local",
    "bud_id": "b_..."
  }
}
```

Thread model preference and message send validation need environment-aware checks. If a user explicitly selects a ds4 model and the Bud no longer has a healthy ds4 capability, return a clear `424 local_model_unavailable` or `400 invalid_model` before persisting a user message. Do not silently fall back from a local model to a cloud model.

## Security And Ownership

- Browser-facing model inventory for local models must resolve Bud ownership before reading capabilities.
- Message send must resolve the owned thread, derive its Bud, then validate local model availability against that Bud.
- The service must not accept raw local LLM host, port, or URL from the browser.
- The daemon must not accept arbitrary service-supplied local targets for LLM calls.
- No cookies, Better Auth headers, proxy viewer cookies, or Bud credentials should be forwarded to ds4.
- Prompt and transcript data will transit through the hosted service before being forwarded to the local model. This should be made explicit in product copy later; local inference is not end-to-end private from the service.
- Audit rows should use existing `bud_operation`, `bud_stream`, and `audit_event` tables for local LLM stream opens, daemon denials, resets, and closes.

## Testing Plan

Deterministic tests:

- Chat Completions stream parser handles text, tool-call deltas, tool-call completion, usage, and max-token/incomplete stops.
- Catalog and reasoning policy include `ds4` without changing OpenAI/Anthropic defaults.
- `/api/models?bud_id=...` filters local models by owned Bud capability.
- Message creation rejects explicit ds4 selection when the owned Bud lacks ds4.
- Provider ledger records `ds4` calls and reconstructs canonical fallback after provider switches.
- Daemon local LLM target validation rejects non-loopback targets, unknown server ids, disallowed paths, and oversized bodies.

Live/manual tests:

- Direct local service mode against running ds4: one final-text turn and one tool-call turn.
- Bud-backed mode against running ds4: one final-text turn and one terminal tool-call loop.
- Cancel a streaming ds4 turn and verify the daemon stream resets.
- Stop ds4, reconnect Bud, and verify the model disappears or invocation fails clearly.
- Confirm concurrent requests serialize or queue according to the configured per-Bud ds4 concurrency limit.

## Rollout

1. Implement direct local-dev ds4 provider using Chat Completions.
2. Add opt-in direct smoke tests and fixtures from real ds4 streams.
3. Add daemon ds4 config, startup probe, and `llm` hello capability.
4. Add Bud-scoped model inventory and environment-aware model validation.
5. Add `local_llm_http` data-plane stream and `BudLocalDs4Provider`.
6. Validate Chat Completions tool loops end to end.
7. Test `/v1/responses` and decide whether to add a Responses-mode ds4 adapter.
8. Test `/v1/messages` only if Anthropic-compatible replay or Claude Code parity becomes a product need.

## Open Questions

- Does ds4's `/v1/models` expose enough context/output metadata, or must Bud require explicit context config?
- Should the UI expose both `deepseek-v4-flash` and `deepseek-v4-pro` aliases even though ds4 says they map to the same loaded model?
- Should a saved ds4 thread show an unavailable model state when the Bud is offline, or should the selector force a cloud model before the user can send?
- How much provider-native replay should `ds4` get in the ledger, especially for DSML exact tool replay and Responses continuations?
- Should runtime ds4 health changes be sent as a new daemon `capability_update` frame, or is reconnect-time capability detection sufficient for the first release?
- What is the right first hard limit for ds4 output tokens? The server can generate very long outputs, but Bud's agent loop and UI need bounded latency and storage.
- If users configure a local runner that requires an API key, should the daemon inject that key locally so the hosted service never sees it?

## Acceptance Criteria

- ds4 can be selected in local development when `DS4_DIRECT_BASE_URL` is configured.
- A cloud-hosted service can invoke a ds4 server running beside an owned online Bud without exposing arbitrary localhost proxy access.
- ds4 models are visible only in a Bud-scoped model list for Buds that advertise the local LLM capability.
- Explicit ds4 selections fail clearly when the local model is unavailable and never silently fall back to a cloud provider.
- Tool calls stream, execute, and replay through the existing agent loop.
- Protocol, service, daemon, and route specs are updated with the new local LLM provider and data-plane contract during implementation.
