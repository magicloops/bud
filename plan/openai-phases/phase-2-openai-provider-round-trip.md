# Phase 2: OpenAI Provider Round Trip

**Status**: Planned
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

## Goal

Make the OpenAI provider preserve assistant phase when converting between Bud's
canonical messages and OpenAI Responses input/output shapes.

## Scope

- Update `OpenAIProvider.transformMessages()` so assistant text blocks with
  `assistantPhase` become Responses assistant message input items with `phase`.
- Do not emit `phase` for user, system, tool-result, reasoning, or tool-call
  input items.
- In non-streaming `parseResponse()`, read `phase` from OpenAI output message
  items and attach it to all text blocks produced from that message.
- In streaming handling:
  - capture output message item `phase` from `response.output_item.added`
  - associate text deltas and final text blocks with their output message item
  - attach the captured phase to canonical text blocks in the final response
- Keep any SDK type casts provider-local if `6.39.0` declarations do not expose
  the field.
- Update `service/src/llm/providers/providers.spec.md`.

## Acceptance Criteria

- [ ] Assistant canonical text with `assistantPhase: "commentary"` lowers to an
      OpenAI input message with `phase: "commentary"`.
- [ ] Non-streaming OpenAI message output with `phase: "final_answer"` parses to
      canonical text with `assistantPhase: "final_answer"`.
- [ ] Streaming OpenAI message output with `phase: "commentary"` parses to
      canonical text with `assistantPhase: "commentary"`.
- [ ] Tool calls, reasoning, and redacted reasoning retain their current behavior.
- [ ] OpenAI request payloads omit `phase` when canonical phase is absent.

## Validation

- Add or extend `service/src/llm/providers/providers.test.ts` with request-shape,
  streaming parse, and non-streaming parse cases.
- Include one fixture where text precedes a function call and should remain
  `commentary`.
- Include one fixture where the final no-tool response should be
  `final_answer`.

## Notes

Provider-returned phase wins. Fallback derivation for missing phase is handled
in Phase 3 so the provider parser remains a faithful adapter for what OpenAI
actually returned.
