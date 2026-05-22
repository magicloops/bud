# Implementation Spec: OpenAI Responses Assistant Phase Preservation

**Status**: Implemented
**Created**: 2026-05-22
**Source Review**: [../../review/openai-response-phase-review.md](../../review/openai-response-phase-review.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-sdk-type-baseline-and-fixtures.md](./phase-0-sdk-type-baseline-and-fixtures.md)
**Phase 1**: [phase-1-canonical-assistant-phase-contract.md](./phase-1-canonical-assistant-phase-contract.md)
**Phase 2**: [phase-2-openai-provider-round-trip.md](./phase-2-openai-provider-round-trip.md)
**Phase 3**: [phase-3-persistence-and-replay-fallbacks.md](./phase-3-persistence-and-replay-fallbacks.md)
**Phase 4**: [phase-4-validation-docs-and-rollout.md](./phase-4-validation-docs-and-rollout.md)

---

## Context

OpenAI Responses assistant output messages can carry a `phase` value:
`commentary` for intermediate assistant output and `final_answer` for the final
answer. OpenAI recommends preserving and resending that field on assistant
messages in follow-up requests for GPT-5.3 Codex and later models.

Bud is in the preservation-sensitive path because the service manually rebuilds
Responses input from canonical message rows and provider-ledger rows. It does
not currently rely on `previous_response_id` for OpenAI continuity.

The current implementation loses phase in three places:

- canonical text blocks cannot represent phase
- the OpenAI provider does not include phase when lowering assistant history to
  Responses input
- streaming, non-streaming, provider-ledger, and transcript fallback paths all
  drop any phase that OpenAI returns

This is highest risk for tool-heavy GPT-5.4/GPT-5.5 turns where the model emits
visible text before a tool call. If Bud replays that pre-tool text without
`phase: "commentary"`, OpenAI may interpret it as final-answer history.

## Objective

Preserve OpenAI assistant message phase across Bud's provider abstraction,
durable provider ledger, transcript fallback, and same-turn tool-loop replay
without imposing OpenAI-only behavior on Anthropic.

Specifically:

- add an optional internal assistant phase to canonical assistant text
- include `phase` on OpenAI assistant message input items when the phase is known
- capture `phase` from OpenAI streaming and non-streaming output messages
- persist and reconstruct phase through existing JSONB payloads
- derive conservative fallback phase for historical rows and OpenAI output that
  omits the field
- keep Anthropic request payloads unchanged

## Fixed Decisions

- The canonical type name is `AssistantMessagePhase`.
- Valid canonical values are `commentary` and `final_answer`.
- The canonical text field is `assistantPhase?: AssistantMessagePhase`.
- `assistantPhase` is meaningful only for assistant text. Other roles may carry
  the optional property in generic data, but providers must ignore it unless the
  role is assistant and the provider understands it.
- OpenAI lowering emits `phase` only on assistant `message` input items and only
  when `assistantPhase` is present.
- Anthropic lowering ignores `assistantPhase`.
- No SQL migration is expected. `llm_call_item.canonical_payload` and
  `message.metadata` are already JSONB.
- The product API does not gain a new top-level field in this tranche. Any
  product-row fallback lives in `message.metadata.assistant_phase`.
- Historical replay falls back to `commentary` for assistant text in output that
  also contains a tool call, and `final_answer` for assistant text in output
  without tool calls.

## Success Criteria

- [x] Canonical assistant text can carry `assistantPhase`.
- [x] OpenAI follow-up input includes `phase` for replayed assistant text when
      phase is known.
- [x] OpenAI streaming output with `phase: "commentary"` produces canonical text
      carrying `assistantPhase: "commentary"`.
- [x] OpenAI non-streaming output with `phase: "final_answer"` produces
      canonical text carrying `assistantPhase: "final_answer"`.
- [x] Provider-ledger round trip preserves `assistantPhase` for text blocks.
- [x] Transcript fallback derives assistant phase from
      `message.metadata.assistant_phase` or `segment_kind`.
- [x] Same-turn tool-loop replay marks pre-tool assistant text as `commentary`
      before sending the next Responses request.
- [x] Anthropic provider request payloads do not change.

## Non-Goals

- switching Bud to OpenAI `previous_response_id`
- exposing phase as a new first-party top-level REST or SSE contract field
- changing assistant message rendering in web or mobile clients
- adding a relational `assistant_phase` column
- changing model selection, reasoning controls, or cache policy
- changing Anthropic message semantics

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 0 | [phase-0-sdk-type-baseline-and-fixtures.md](./phase-0-sdk-type-baseline-and-fixtures.md) | Urgent | Update to OpenAI SDK `6.39.0`, inspect type support, and define fixtures |
| 1 | [phase-1-canonical-assistant-phase-contract.md](./phase-1-canonical-assistant-phase-contract.md) | Urgent | Add the optional canonical assistant phase contract without changing providers yet |
| 2 | [phase-2-openai-provider-round-trip.md](./phase-2-openai-provider-round-trip.md) | Urgent | Round-trip phase through OpenAI request lowering and output parsing |
| 3 | [phase-3-persistence-and-replay-fallbacks.md](./phase-3-persistence-and-replay-fallbacks.md) | High | Preserve phase durably and derive safe fallback phase for replay gaps |
| 4 | [phase-4-validation-docs-and-rollout.md](./phase-4-validation-docs-and-rollout.md) | High | Validate OpenAI/Anthropic behavior, update specs, and prepare rollout |

## Expected Files And Areas

### Service LLM

- `service/package.json`
- `service/pnpm-lock.yaml`
- `service/src/llm/types.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/provider-ledger.test.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/llm/providers/providers.test.ts`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`

### Service Agent

- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/agent-service.test.ts`
- `service/src/agent/conversation-loader.test.ts`
- `service/src/agent/model-runner.test.ts`
- `service/src/agent/transcript-writer.test.ts`
- `service/src/agent/agent.spec.md`

### Docs / Specs

- `service/service.spec.md`
- `bud.spec.md`
- `plan/openai-phases/openai-phases.spec.md`
- `plan/openai-phases/progress-checklist.md`
- `plan/openai-phases/validation-checklist.md`

`docs/proto.md` is not expected to change unless implementation exposes phase as
a new top-level SSE or Bud-owned wire contract field, which this plan avoids.

## Sequencing Notes

- Phase 0 should land first so the implementation can use the latest SDK
  declarations if they now expose `phase`.
- Phase 1 should land before provider work so all providers and tests compile
  against one canonical representation.
- Phase 2 and Phase 3 are tightly coupled. OpenAI parsing can capture phase, but
  the fix is incomplete until the provider ledger and transcript fallback can
  replay it.
- Same-turn tool-loop fallback belongs with Phase 3 because the same in-memory
  conversation array is also a replay source.
- Phase 4 should verify both OpenAI preservation and Anthropic no-op behavior.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SDK `6.39.0` still lacks phase in TypeScript declarations | Medium | Medium | Keep any cast local to `providers/openai.ts` and add a fixture test that guards the request shape |
| Streaming parser cannot reliably associate text deltas with the output message phase | Medium | High | Capture `response.output_item.added` message metadata by output item id and test with realistic streamed event fixtures |
| Fallback phase marks final text as commentary or pre-tool text as final | Medium | High | Prefer provider-returned phase, then transcript metadata, then conservative output-shape derivation |
| Anthropic request payloads accidentally gain OpenAI-only metadata | Low | Medium | Add Anthropic regression coverage around transformed messages |
| Product clients over-interpret `message.metadata.assistant_phase` as a UI contract | Low | Low | Document it as replay metadata, not a rendering requirement |

## Rollout Strategy

1. Update the OpenAI SDK and inspect the new type surface.
2. Add canonical optional phase and compile the existing provider tests.
3. Add OpenAI request/parse round-trip support behind the canonical field.
4. Persist phase through the provider ledger and transcript metadata fallback.
5. Add historical and same-turn fallback derivation.
6. Run focused service tests, update specs, and do one real or recorded OpenAI
   tool-loop trace before relying on the behavior in staging.

## Definition Of Done

- [x] OpenAI SDK dependency is `^6.39.0` and lockfile resolution uses `6.39.0`.
- [x] Canonical assistant text can carry phase while remaining optional.
- [x] OpenAI input/output round-trip preserves phase in streaming and
      non-streaming paths.
- [x] Provider-ledger and transcript fallback replay preserve or derive phase.
- [x] Anthropic behavior is verified unchanged.
- [x] Specs and checklists in this folder reflect the final implementation.
- [x] Relevant service specs are updated when code changes land.
