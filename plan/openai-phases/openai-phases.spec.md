# openai-phases

Implementation planning documents for preserving OpenAI Responses assistant
message `phase` values across Bud's manual provider-history replay path.

## Purpose

This folder turns the findings in
[../../review/openai-response-phase-review.md](../../review/openai-response-phase-review.md)
into a phased implementation plan.

The plan assumes:

- Bud manually reconstructs OpenAI Responses input from canonical transcript and
  provider-ledger data rather than using `previous_response_id`
- OpenAI assistant message `phase` is provider conversation state that must be
  preserved when Bud replays assistant messages
- Anthropic does not have a matching phase concept, so the internal
  representation must stay optional and provider-neutral
- no SQL schema change is expected because canonical provider output already
  persists through JSONB payloads and product message metadata is also JSONB

## Files

### `implementation-spec.md`

Parent implementation spec for the OpenAI assistant phase rollout.

Documents:

- current gap and why it matters for manual Responses replay
- fixed design decisions
- phase sequencing
- risks and definition of done

### `phase-0-sdk-type-baseline-and-fixtures.md`

Dependency and reconnaissance phase covering:

- updating the service OpenAI SDK to `6.39.0`
- checking whether the SDK declarations expose `phase`
- capturing provider fixtures that represent commentary and final-answer
  assistant messages

### `phase-1-canonical-assistant-phase-contract.md`

Canonical-contract phase covering:

- optional `AssistantMessagePhase`
- optional `assistantPhase` on canonical text blocks
- provider-neutral handling that keeps Anthropic behavior unchanged

### `phase-2-openai-provider-round-trip.md`

OpenAI provider phase covering:

- lowering canonical assistant phase to Responses input message `phase`
- preserving `phase` from streaming and non-streaming Responses output messages
- focused OpenAI provider tests

### `phase-3-persistence-and-replay-fallbacks.md`

Durability and replay phase covering:

- provider-ledger persistence and reconstruction
- product transcript metadata fallback
- historical best-effort phase derivation for rows that predate the rollout

### `phase-4-validation-docs-and-rollout.md`

Finalization phase covering:

- automated and manual validation
- Anthropic regression checks
- service spec updates and rollout notes

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../review/openai-response-phase-review.md](../../review/openai-response-phase-review.md) - current-state review and recommendation
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - provider-agnostic LLM abstraction and ledger contract
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - OpenAI and Anthropic provider behavior
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent loop and transcript writer ownership
- [../../service/service.spec.md](../../service/service.spec.md) - service package dependency catalog
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

No intentional follow-up debt is introduced by this plan. If Bud later adopts
`previous_response_id` for OpenAI continuity, add a separate design note because
that would change the replay responsibility rather than just the phase field.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
