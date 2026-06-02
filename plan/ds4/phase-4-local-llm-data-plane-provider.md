# Phase 4: Local LLM Data-Plane Provider

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Let the hosted service invoke a ds4 server running beside an owned online Bud through a narrow authenticated data-plane stream.

By the end of this phase:

- daemon and service support `local_llm_http` streams
- service can open a logical ds4 request without sending raw host/port data
- daemon forwards allowlisted ds4 API calls to loopback only
- `BudLocalDs4Provider` parses ds4 Chat Completions streams into canonical provider events
- cancellation, stream reset, limits, and provider-ledger recording work end to end

## Scope

### In Scope

- daemon local LLM stream handler
- service transport/data-plane routing
- provider invocation context with thread/Bud/owner routing metadata
- `BudLocalDs4Provider`
- stream frame open/result handling
- provider-ledger `ds4` recording
- protocol docs and specs
- deterministic daemon/service stream tests

### Out Of Scope

- generic browser proxy reuse
- arbitrary localhost forwarding
- Responses-mode ds4 provider
- remote LAN model servers
- UI changes beyond consuming Phase 3 inventory

## Stream Contract

Initial frame family:

- `local_llm_open` from service to daemon
- `local_llm_open_result` from daemon to service
- existing stream data, credit, reset, and close frames for request and response bytes

Service open request:

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

The open result should include status, selected compatibility mode, response headers needed by the provider parser, and a typed denial reason when the daemon rejects the request.

## Implementation Tasks

### Task 1: Extend service provider invocation context

Add routing context to model invocation:

```typescript
{
  threadId: string;
  budId: string;
  ownerUserId: string;
}
```

This context is required only for environment-scoped providers. Existing OpenAI/Anthropic providers can ignore it.

### Task 2: Add data-plane stream family support

Add `local_llm_http` to the service and daemon stream-family vocabulary.

Selection rules:

- choose an authenticated data-plane carrier for the thread Bud
- require `bud_envelope.stream_frames`
- require advertised `capabilities.llm` server id `ds4`
- fail fast when the Bud is disconnected or the stream family is unsupported

### Task 3: Implement service-side Bud ds4 provider

`BudLocalDs4Provider` responsibilities:

- build Chat Completions JSON request bodies
- open a `local_llm_http` stream to logical server id `ds4`
- stream request body bytes if needed
- parse response SSE bytes from the daemon stream
- emit canonical text and tool-call deltas
- normalize local unavailable, daemon denial, HTTP error, and parse errors
- reset the stream on cancellation

### Task 4: Implement daemon local LLM HTTP forwarding

Daemon responsibilities:

- resolve `local_llm_server_id` to configured ds4 origin
- permit only loopback targets from daemon config
- permit only allowlisted paths under `/v1`
- permit only expected methods, initially `POST` for generation and possibly `GET` for model probes if needed
- strip cookies, Better Auth headers, proxy cookies, and Bud credentials
- inject local-only API auth in the daemon only if a future local runner needs it
- enforce request body, response body, idle, TTL, and concurrency limits
- stream response bytes with ordered seq values

### Task 5: Add audit and durable stream state

Use existing operation/stream/audit surfaces for:

- stream open
- daemon denial
- upstream ds4 HTTP error
- cancellation/reset
- close with final byte offsets
- limit-triggered termination

Do not add database schema unless current durable stream tables cannot represent the stream family.

### Task 6: Add tests

Add deterministic coverage for:

- service rejects Bud-backed ds4 when no carrier is available
- service rejects Bud-backed ds4 when the Bud lacks ds4 capability
- daemon rejects unknown local LLM server id
- daemon rejects non-loopback configured targets
- daemon rejects disallowed methods/paths/headers
- daemon enforces concurrency `1`
- cancellation resets the stream
- provider parser handles daemon-streamed Chat Completions SSE
- provider-ledger stores provider `ds4` and request mode `ds4_openai_chat`

## Validation Checklist

- [ ] `local_llm_http` stream family exists
- [ ] service opens logical ds4 stream without raw URL
- [ ] daemon validates logical server id
- [ ] daemon strips forbidden headers
- [ ] daemon enforces method/path/body/response/time limits
- [ ] provider emits canonical text events
- [ ] provider emits canonical tool-call events
- [ ] cancellation resets daemon stream
- [ ] provider ledger records `ds4_openai_chat`
- [ ] Bud-backed live final-text smoke passes
- [ ] Bud-backed live terminal tool-loop smoke passes

## Exit Criteria

This phase is done when a cloud-hosted service can complete a normal agent turn against ds4 running beside the owned Bud, without exposing arbitrary localhost proxy access.
