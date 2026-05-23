# Phase 0: SDK Type Baseline And Fixtures

**Status**: Planned
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

## Goal

Update the service to OpenAI SDK `6.39.0`, inspect whether the package exposes
assistant message `phase` in its Responses TypeScript declarations, and define
the fixture shapes needed by the implementation phases.

## Scope

- Update `service/package.json` from `openai@^6.8.1` to `openai@^6.39.0`.
- Update `service/pnpm-lock.yaml` through `pnpm --dir /Users/adam/bud/service
  add openai@6.39.0`.
- Inspect the installed SDK declarations for:
  - assistant input message `phase`
  - response output message `phase`
  - streaming `response.output_item.added` message item shape
- Decide whether `service/src/llm/providers/openai.ts` can use SDK-native types
  or needs a provider-local cast for `phase`.
- Define fixtures for:
  - assistant commentary input replay
  - streaming commentary output before a tool call
  - non-streaming final-answer output

## Acceptance Criteria

- [ ] `service/package.json` declares `openai` as `^6.39.0`.
- [ ] `service/pnpm-lock.yaml` resolves `openai@6.39.0`.
- [ ] The provider implementation plan records whether SDK-native types expose
      `phase`.
- [ ] Fixture names and shapes are known before changing provider behavior.

## Validation

- `pnpm --dir /Users/adam/bud/service install --lockfile-only` or the equivalent
  package-manager update completes without unrelated dependency churn.
- `rg -n "phase" service/node_modules/openai` confirms whether the installed SDK
  exposes the field.

## Notes

Current SDK check: `openai@6.39.0` exposes `phase?: "commentary" |
"final_answer" | null` on both `EasyInputMessage` and `ResponseOutputMessage`
in `service/node_modules/openai/resources/responses/responses.d.ts`.

If the SDK type declarations still lag the API field, keep the type escape hatch
inside `providers/openai.ts`. Do not weaken canonical LLM types or introduce
global `any` aliases to accommodate one provider field.
