# Phase 5: Responses Hardening And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Harden the ds4 rollout after Chat Completions works, then decide whether ds4 Responses or Anthropic-compatible Messages should become supported provider modes.

By the end of this phase:

- ds4 Chat Completions behavior has live and deterministic validation
- cancellation, reconnect, unavailable-server, and concurrency cases are covered
- audit and limit behavior is documented
- `/v1/responses` has a go/no-go implementation decision
- product and deployment docs clearly describe local inference boundaries

## Scope

### In Scope

- live ds4 validation
- Responses endpoint compatibility tests
- optional Responses provider mode design update
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

### Task 1: Validate Chat Completions hard cases

Run and record live/manual validation for:

- final-text turn
- terminal tool-call turn
- long output within configured limits
- malformed tool-call recovery if ds4 produces partial JSON
- cancel during streaming
- ds4 process stopped before send
- ds4 process stopped mid-stream
- Bud reconnect after ds4 starts or stops
- two concurrent ds4 requests to one Bud

### Task 2: Decide Responses support

Using Phase 0 fixtures and live probes, decide whether to implement:

```text
ds4_openai_responses
```

Decision criteria:

- streaming text shape maps cleanly to canonical provider events
- tool-call shape maps cleanly to Bud tool execution
- provider-native replay is better than Chat Completions for Bud's tool loop
- reasoning or continuity features justify the additional mode

If the answer is no, document the blocker and keep Chat Completions as the only supported ds4 mode.

### Task 3: Decide Anthropic Messages support

Decide whether to implement:

```text
ds4_anthropic_messages
```

This should remain deferred unless ds4's Anthropic-compatible endpoint provides a concrete product benefit over Chat Completions or Responses.

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
- [ ] Responses support decision recorded
- [ ] Anthropic Messages support decision recorded
- [ ] audit/log review complete
- [ ] docs/spec updates complete

## Exit Criteria

This phase is done when Chat Completions ds4 is safe to roll out as an opt-in local LLM option and follow-up compatibility modes have explicit decisions instead of ambiguity.
