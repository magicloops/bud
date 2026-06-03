# Phase 5: Responses Hardening And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Harden the ds4 rollout after the direct-provider endpoint decision from [phase-1.5-direct-responses-provider.md](./phase-1.5-direct-responses-provider.md), then decide whether Anthropic-compatible Messages should become a supported provider mode.

By the end of this phase:

- the chosen ds4 endpoint has live and deterministic validation
- cancellation, reconnect, unavailable-server, and concurrency cases are covered
- audit and limit behavior is documented
- `/v1/responses` rollout status is confirmed from Phase 1.5
- product and deployment docs clearly describe local inference boundaries

## Scope

### In Scope

- live ds4 validation
- chosen endpoint compatibility tests
- Responses hardening follow-up after the Phase 1.5 service-local default switch
- limits and audit hardening
- reconnect/unavailable behavior
- docs/spec finalization
- product/deployment handoff

### Out Of Scope

- supporting every OpenAI-compatible local runner
- remote local-network model servers
- multi-Bud load balancing for local models
- end-to-end private inference claims

## Implementation Tasks

### Task 1: Validate chosen endpoint hard cases

Run and record live/manual validation for:

- final-text turn
- terminal tool-call turn
- post-tool continuation with Responses `function_call_output` replay
- reasoning output preservation/replay when ds4 emits Responses reasoning items
- long output within configured limits
- malformed tool-call recovery if ds4 produces partial JSON
- `response.incomplete` handling for output/context limits
- `response.failed` and upstream HTTP error handling
- cancel during streaming
- ds4 process stopped before send
- ds4 process stopped mid-stream
- Bud reconnect after ds4 starts or stops
- two concurrent ds4 requests to one Bud

### Responses API Deltas

Hardening should focus on Responses lifecycle behavior rather than Chat Completions chunk behavior:

- confirm post-tool requests replay `function_call` followed by `function_call_output`
- confirm provider-native reasoning payloads are kept for same-provider replay when available
- confirm visible assistant text and reasoning/tool items preserve provider output order
- confirm `response.completed`, `response.incomplete`, and `response.failed` all produce coherent canonical outcomes
- confirm daemon-streamed SSE framing preserves multi-line `data:` events and `[DONE]`
- do not add tests or fallback behavior for Chat Completions `delta.reasoning_content`, `tool_calls`, or `finish_reason`

### Task 2: Confirm Responses rollout status

Use Phase 1.5 fixtures and live probes to confirm whether the rollout uses:

```text
ds4_openai_responses
```

Phase 1.5 made Responses the service-local default, and live cache validation on June 3, 2026 confirmed that Responses is the chosen endpoint for continuing Bud-backed work. The remaining Phase 5 work is hardening:

- live cache behavior remains better than Chat Completions (confirmed)
- cancellation and Responses error/incomplete events are covered
- Bud-backed data-plane docs use `/v1/responses`
- provider-ledger diagnostics distinguish `ds4_openai_responses`

If live validation later rejects Responses for Bud-backed use, treat that as a blocker for Bud-backed ds4 or scope a new endpoint design. Phase 1.6 removed Chat Completions as an active Bud fallback.

### Task 3: Decide Anthropic Messages support

Decide whether to implement:

```text
ds4_anthropic_messages
```

This should remain deferred unless ds4's Anthropic-compatible endpoint provides a concrete product benefit over Responses.

### Task 4: Harden operational limits

Confirm and document:

- max request body bytes
- max response bytes
- idle timeout
- total stream TTL
- per-Bud ds4 concurrency
- cancellation behavior
- retry policy
- daemon reconnect behavior

Prefer explicit failure over queueing behavior that hides ds4's single-worker concurrency constraints.

### Task 5: Finalize audit and observability

Make sure logs/audit can answer:

- which Bud-local model was selected
- whether invocation used direct local-dev or Bud-backed mode
- which logical local LLM server id was used
- whether the daemon denied the local request
- whether cancellation or limits ended the stream
- whether ds4 returned an upstream HTTP error

Do not log raw prompt bodies or sensitive local headers.

### Task 6: Complete handoff docs

Update:

- relevant `.spec.md` files
- `docs/proto.md`
- service and daemon environment docs
- product copy/handoff notes explaining that local inference still routes prompt context through the hosted service
- [progress-checklist.md](./progress-checklist.md)
- [validation-checklist.md](./validation-checklist.md)

## Validation Checklist

- [ ] final-text live smoke passes
- [ ] terminal tool-call live smoke passes
- [ ] cancel live smoke passes
- [ ] stopped-ds4-before-send behavior is clear
- [ ] stopped-ds4-mid-stream behavior is clear
- [ ] reconnect-time health behavior is clear
- [ ] concurrency behavior is clear
- [x] Responses rollout status confirmed
- [ ] Anthropic Messages support decision recorded
- [ ] audit/log review complete
- [ ] docs/spec updates complete

## Exit Criteria

This phase is done when the selected ds4 endpoint is safe to roll out as an opt-in local LLM option and follow-up compatibility modes have explicit decisions instead of ambiguity.
