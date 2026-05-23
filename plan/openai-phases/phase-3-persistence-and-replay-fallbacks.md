# Phase 3: Persistence And Replay Fallbacks

**Status**: Planned
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

## Goal

Ensure assistant phase survives durable replay and is safely derived when older
rows or provider responses do not contain it.

## Scope

- Let `llm_call_item.canonical_payload` store canonical text
  `assistantPhase` naturally.
- Update provider-ledger reconstruction to return text blocks with
  `assistantPhase` when present.
- Add historical best-effort derivation for reconstructed OpenAI output without
  phase:
  - if the same provider output contains tool calls, assistant text is
    `commentary`
  - if the provider output has assistant text and no tool call, assistant text is
    `final_answer`
- Update transcript writing so assistant message metadata can include
  `assistant_phase`:
  - intermediate assistant segments map to `commentary`
  - final assistant segments map to `final_answer`
- Update conversation loading so fallback transcript replay derives
  `assistantPhase` from `message.metadata.assistant_phase`, then from
  `message.metadata.segment_kind`.
- In the same-turn agent loop, fill missing phase before appending model output
  back into the in-memory conversation:
  - output with any tool call maps visible assistant text to `commentary`
  - final output without tool calls maps visible assistant text to
    `final_answer`
- Update `service/src/agent/agent.spec.md` and `service/src/llm/llm.spec.md`.

## Acceptance Criteria

- [ ] Provider-ledger round trip preserves explicit `assistantPhase`.
- [ ] Provider-ledger replay derives phase for historical OpenAI outputs that
      predate the rollout.
- [ ] Persisted intermediate assistant transcript rows carry
      `metadata.assistant_phase: "commentary"`.
- [ ] Persisted final assistant transcript rows carry
      `metadata.assistant_phase: "final_answer"`.
- [ ] Conversation-loader fallback emits canonical assistant text with
      `assistantPhase`.
- [ ] Same-turn tool-loop replay sends pre-tool assistant text back to OpenAI as
      `commentary`.

## Validation

- Extend `service/src/llm/provider-ledger.test.ts`.
- Extend `service/src/agent/conversation-loader.test.ts`.
- Extend `service/src/agent/transcript-writer.test.ts`.
- Extend `service/src/agent/agent-service.test.ts` or
  `service/src/agent/model-runner.test.ts` for same-turn replay fallback.

## Notes

This phase intentionally does not add a relational column. The field is replay
metadata and does not need indexed lookup in the current architecture.
