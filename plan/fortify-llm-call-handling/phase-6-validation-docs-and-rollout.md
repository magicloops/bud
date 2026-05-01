# Phase 6: Validation, Docs, And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Close the rollout with focused automated coverage, manual validation, specs, and migration handoff.

## Scope

### In Scope

- service provider fixture tests
- agent loop integration tests
- conversation reconstruction tests
- transcript persistence and refresh tests
- web stream state tests
- protocol/spec updates
- DB migration docs
- rollout notes and fallback posture

### Out Of Scope

- reasoning UI
- broad frontend redesign
- live provider conformance as the only validation mechanism

## Automated Verification Targets

Service:

- provider adapter fixture tests
- model runner ordered-content tests
- agent service mixed text/tool tests
- transcript writer intermediate assistant text tests
- conversation loader/reconstructor same-provider tests
- provider-switch fallback tests
- DB helper tests for provider ledger persistence

Web:

- stream reducer tests for text then tool call
- stream reducer tests for text between tool calls
- refresh bootstrap tests with persisted intermediate text
- type coverage for intermediate assistant metadata

Migration:

- local `db:push`
- checked-in `db:generate`
- migration SQL review
- migration spec update

## Manual Validation

1. Start a thread with an OpenAI reasoning/tool model.
2. Trigger text before a terminal tool call.
3. Refresh during the tool call and after completion.
4. Confirm visible text remains.
5. Trigger a second tool call after intermediate assistant text.
6. Confirm the intermediate text remains after refresh.
7. Repeat equivalent flow with Anthropic thinking enabled.
8. Confirm reasoning remains hidden in the UI but exists in provider ledger rows.
9. Confirm cache metrics are recorded for OpenAI.
10. Switch providers on a later turn and confirm canonical fallback works without provider-only reasoning translation.

## Docs And Specs To Update

- `docs/proto.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

## Rollout Notes

- Deploy schema before depending on provider ledger writes.
- Keep old product transcript reads compatible with historical messages.
- Treat historical threads without provider ledger rows as canonical-fallback ranges.
- Gate any new provider-native reconstruction path with structured degraded-mode logs.
- Do not expose provider ledger rows through browser APIs in this branch.

## Acceptance Criteria

- [ ] All focused service tests pass.
- [ ] All focused web tests pass.
- [ ] Migration files are checked in and documented.
- [ ] Manual validation checklist is completed or any failures are captured in a new debug note.
- [ ] Specs and protocol docs match shipped behavior.
- [ ] Rollout handoff names the migration file and the provider reconstruction fallback behavior.

## Risks

| Risk | Mitigation |
|------|------------|
| Historical threads behave differently from new threads | Mark missing ledger ranges as canonical fallback and test historical transcript loading |
| Docs lag behind provider-ledger behavior | Keep spec updates in the final implementation PR gate |
| Manual validation needs live provider access | Keep deterministic fixture tests as required CI and live-provider checks as release validation |
