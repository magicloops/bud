# Phase 2: Daemon Local LLM Capability

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Teach the Bud daemon to discover and advertise a configured local ds4 server without exposing raw localhost details to the hosted service or browser.

By the end of this phase:

- daemon config can point at a local ds4 API origin
- the daemon probes `GET /v1/models` before hello
- healthy ds4 is advertised under `capabilities.llm`
- service hello parsing preserves the `llm` capability
- the service can persist and inspect Bud-local LLM capability metadata

Phase 1.6 made `/v1/responses` the only active Bud ds4 endpoint. Phase 2 capability metadata should therefore advertise Responses compatibility only; Chat Completions and Anthropic Messages remain historical/deferred and must not appear as available Bud-local modes.

## Scope

### In Scope

- `bud/src/config.rs`
- `bud/src/app.rs`
- daemon HTTP probe helper or local LLM module
- `service/src/ws/protocol.ts`
- service Bud capability persistence path
- `docs/proto.md`
- `bud/src/src.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/transport/transport.spec.md` if stream-family readiness is documented here

### Out Of Scope

- service invocation of ds4 through the daemon
- runtime capability update frames
- remote non-loopback local LLM targets
- installing or starting ds4

## Configuration

```text
BUD_LOCAL_LLM_DS4_URL=http://127.0.0.1:8000
BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS=100000
BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS=384000
```

The URL must be a loopback HTTP origin. The daemon appends `/v1/models` for probing and later resolves allowlisted API paths from the logical server id.

## Capability Contract

Advertise the capability only after a successful startup probe:

```json
{
  "llm": {
    "local_api": true,
    "servers": [
      {
        "id": "ds4",
        "provider": "ds4",
        "compatibility": ["openai_responses"],
        "request_mode": "ds4_openai_responses",
        "generation_path": "/v1/responses",
        "models": [
          {
            "id": "deepseek-v4-flash",
            "display_name": "ds4 DeepSeek V4",
            "context_window_tokens": 100000,
            "max_output_tokens": 384000
          }
        ],
        "concurrency": 1,
        "healthy": true
      }
    ]
  }
}
```

If the probe fails, omit `capabilities.llm` or include no healthy servers. Prefer omission in the first pass to avoid ambiguous client behavior.

### Responses API Deltas

Compared to the original Chat Completions plan:

- `compatibility` advertises only `openai_responses`
- `request_mode` is always `ds4_openai_responses`
- `generation_path` is `/v1/responses`; `/v1/chat/completions` is not advertised
- no `assistant.reasoning_content` or Chat-specific DSML replay behavior is part of the capability contract
- `/v1/models` remains the startup health probe, but it does not imply support for any endpoint other than the advertised Responses path

## Implementation Tasks

### Task 1: Add daemon config parsing

Parse the `BUD_LOCAL_LLM_DS4_*` environment variables and corresponding CLI flags only if CLI parity is desired.

Validate:

- scheme is `http` or an explicitly allowed secure local scheme
- host is loopback (`127.0.0.1`, `localhost`, or IPv6 loopback)
- no path outside an optional empty/root path is accepted for the origin
- context/output token values are positive integers

### Task 2: Add ds4 startup probe

Before building hello:

- send `GET /v1/models`
- apply a short timeout
- parse enough JSON to confirm the server responds
- record model ids if present
- fall back to configured model metadata when ds4's response omits limits

Failure should not stop the daemon from connecting unless the user explicitly asks for strict local LLM mode later.

### Task 3: Advertise `capabilities.llm`

Add `llm` to the daemon hello capabilities when the probe succeeds.

Keep the configured local URL out of the hello payload. The service receives only logical server id, provider, compatibility, request mode, generation path, model metadata, concurrency, and health.

### Task 4: Preserve capability in the service

Update service hello parsing so `capabilities.llm` is retained instead of stripped by schema transforms.

Persist it in the existing Bud capabilities storage path with other capability data.

### Task 5: Document protocol behavior

Update daemon/service protocol docs and specs with:

- local LLM capability shape
- Responses-only compatibility and generation path
- loopback-only local target rule
- startup-probe-only health behavior for the first release
- note that runtime capability updates are deferred

## Validation Checklist

- [x] daemon rejects non-loopback ds4 URL config
- [x] daemon omits `capabilities.llm` when ds4 probe fails
- [x] daemon advertises `capabilities.llm` when ds4 probe succeeds
- [x] daemon advertises only `openai_responses` compatibility for ds4
- [x] hello payload never includes raw local URL
- [x] service schema preserves `capabilities.llm`
- [x] service stores Bud capability metadata
- [x] protocol docs describe local LLM capability

## Exit Criteria

This phase is done when an owned online Bud can advertise that ds4 is locally available, while the service still cannot invoke arbitrary daemon-local HTTP targets.
