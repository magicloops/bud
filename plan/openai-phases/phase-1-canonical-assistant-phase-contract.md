# Phase 1: Canonical Assistant Phase Contract

**Status**: Planned
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

## Goal

Add a narrow canonical representation for assistant message phase that can
survive provider parsing, same-turn replay, and persistence without changing
providers that do not use the field.

## Scope

- Add `AssistantMessagePhase = "commentary" | "final_answer"` to
  `service/src/llm/types.ts`.
- Extend canonical text blocks with
  `assistantPhase?: AssistantMessagePhase`.
- Keep the field optional and role-sensitive:
  - OpenAI may use it for assistant text
  - Anthropic must ignore it
  - user, system, and tool messages should not synthesize it
- Add small helpers only if they reduce repeated phase validation or fallback
  logic.
- Update `service/src/llm/llm.spec.md` to describe the optional replay metadata.

## Acceptance Criteria

- [ ] TypeScript callers can construct assistant canonical text with
      `assistantPhase`.
- [ ] Existing canonical messages without phase still compile.
- [ ] Anthropic provider tests pass without request-shape changes.
- [ ] The LLM spec documents that this is provider replay metadata, not a
      product rendering contract.

## Validation

- Run focused TypeScript tests that exercise canonical message construction.
- Run existing provider tests before adding OpenAI behavior changes to establish
  that the optional field is non-breaking.

## Notes

Name the canonical field `assistantPhase`, not `phase`, so code that deals with
non-assistant messages does not accidentally treat it as a generic message
attribute.
