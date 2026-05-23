# Phase 4: Validation, Docs, And Rollout

**Status**: Planned
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

## Goal

Prove the implementation preserves OpenAI phase through the paths that matter,
verify Anthropic remains unchanged, and update specs for the shipped behavior.

## Scope

- Run focused service tests for:
  - OpenAI provider request lowering
  - OpenAI streaming and non-streaming parse
  - provider-ledger persistence/reconstruction
  - conversation-loader fallback
  - transcript-writer metadata
  - Anthropic no-op behavior
- Run `pnpm --dir /Users/adam/bud/service build` if the branch baseline allows
  it.
- Run a recorded or real OpenAI tool-loop trace that includes visible assistant
  commentary before a tool call.
- Confirm the follow-up OpenAI request preserves `phase: "commentary"` for that
  pre-tool text.
- Update service specs:
  - `service/src/llm/llm.spec.md`
  - `service/src/llm/providers/providers.spec.md`
  - `service/src/agent/agent.spec.md`
  - `service/service.spec.md`
- Update this folder's progress and validation checklists.

## Acceptance Criteria

- [ ] Focused service tests pass.
- [ ] Anthropic transformed request fixtures are unchanged.
- [ ] A trace or fixture demonstrates commentary-before-tool replay with phase
      preserved.
- [ ] A trace or fixture demonstrates final no-tool assistant replay with
      `final_answer` preserved or derived.
- [ ] Specs describe the behavior at the canonical type, OpenAI provider, and
      agent replay layers.
- [ ] Any inability to run real-provider validation is recorded with the exact
      reason.

## Validation Commands

Prefer a focused set first:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts src/llm/provider-ledger.test.ts src/agent/conversation-loader.test.ts src/agent/transcript-writer.test.ts src/agent/model-runner.test.ts src/agent/agent-service.test.ts
```

Then run the package build if the current branch baseline is expected to build:

```bash
pnpm --dir /Users/adam/bud/service build
```

## Notes

If `service build` fails on an unrelated known baseline issue, record the exact
failure in the validation checklist and stop rather than chasing unrelated
cleanup inside this phase.
