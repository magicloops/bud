# Phase 0: Contract Baseline And Fixtures

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Lock the ds4 provider contract before code changes so later phases do not guess at stream shapes, model aliases, output limits, or provider-ledger naming.

By the end of this phase:

- ds4 Chat Completions final-text and tool-call stream fixtures are captured
- Responses and Anthropic Messages support are documented as observed or deferred
- the first product model id and alias policy are fixed
- provider-ledger request modes are named
- reasoning/output-limit behavior is decided for the first pass

## Scope

### In Scope

- `reference/ds4/server.md`
- checked-in ds4 provider fixtures under the eventual service fixture location
- notes in this plan folder for unresolved fixture findings
- request-mode and model-id decisions

### Out Of Scope

- provider implementation
- daemon protocol changes
- browser UI changes
- starting or supervising the ds4 server

## Implementation Tasks

### Task 1: Capture Chat Completions fixtures

Capture representative ds4 responses from the already-running local server:

- non-streaming final text
- streaming final text
- streaming tool-call delta
- tool-call completion
- usage metadata if present
- incomplete/max-token finish if ds4 exposes it
- error payload for an invalid model or malformed request

Store fixtures where provider tests can consume them. Prefer compact JSON/SSE samples over large raw logs.

### Task 2: Probe secondary compatibility endpoints

Run minimal probes for:

- `POST /v1/responses`
- `POST /v1/messages`

Record whether each endpoint has enough parity for a later Bud provider mode. Do not implement these modes in Phase 0.

### Task 3: Lock product model and alias policy

Use one product-visible model in the first implementation:

```text
ds4-deepseek-v4-flash
```

Keep `deepseek-v4-pro` hidden initially because ds4 currently reports both aliases against the same loaded GGUF. Revisit this only if product wants separate labels for compatibility reasons.

### Task 4: Decide first-pass reasoning behavior

Decide whether ds4 gets:

- no exposed reasoning selector and a default provider request
- mapping from Bud `reasoning_effort` to ds4-specific Chat Completions parameters
- a deferred advanced setting outside the current model selector

The default should be no exposed reasoning selector unless fixtures show a stable, documented mapping.

### Task 5: Lock provider-ledger request modes

Initial request mode:

```text
ds4_openai_chat
```

Reserved future request modes:

```text
ds4_openai_responses
ds4_anthropic_messages
```

### Task 6: Set initial limits

Confirm initial configured defaults:

- context window tokens: `100000`
- max output tokens: `128000`
- per-Bud concurrency: `1`

Implementation may enforce stricter runtime output limits if service storage, UI latency, or agent-loop behavior requires it.

## Validation Checklist

- [ ] Chat Completions final-text fixture captured
- [ ] Chat Completions tool-call fixture captured
- [ ] Chat Completions error fixture captured
- [ ] Responses endpoint probe recorded
- [ ] Anthropic Messages endpoint probe recorded
- [ ] first product model id confirmed
- [ ] `deepseek-v4-pro` alias deferral confirmed
- [ ] first-pass reasoning behavior decided
- [ ] provider-ledger request modes documented

## Exit Criteria

This phase is done when the implementation can proceed from concrete ds4 fixture data and fixed provider naming instead of assumptions.
