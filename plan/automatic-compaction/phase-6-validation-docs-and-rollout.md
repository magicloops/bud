# Phase 6: Validation Docs And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Validation pending

---

## Objective

Close the compaction rollout with tests, docs, migration verification, and operational guardrails.

By the end of this phase:

- automated tests cover the core checkpoint lifecycle and trigger behavior
- manual validation proves long threads and tool loops continue after compaction
- specs and protocol docs match shipped behavior
- migration rollout is documented
- rollback and diagnostics are clear

## Scope

### In Scope

- service unit/integration tests
- provider fixture tests for context-window errors
- long-thread manual validation
- checked-in migration review
- spec and protocol updates
- staging rollout notes
- kill-switch verification

### Out Of Scope

- production quality analysis of summary degradation over months of use
- provider-native remote compaction
- transcript search/retrieval features

## Implementation Tasks

### Task 1: Complete automated tests

Required coverage:

- checkpoint repository selection and ownership stamping
- loader reconstruction with and without checkpoints
- provider-ledger checkpoint boundary filtering
- replacement-history builder rules
- provider context-window error normalization
- compaction retry trimming
- pre-turn automatic trigger
- mid-turn automatic trigger
- model downshift on next message send
- kill switch
- `/messages` transcript unchanged by automatic compaction

Use small synthetic context windows so tests are deterministic.

### Task 2: Run migration workflow

For the schema change:

- run `pnpm db:push` from `service/` for local development
- run `pnpm db:generate` from `service/`
- review generated SQL and metadata
- verify staging can apply the checked-in migration with `pnpm db:migrate`
- update `service/drizzle/migrations/migrations.spec.md`

If any command fails, capture the exact command and error output and defer according to repo operating rules.

### Task 3: Update specs and protocol docs

Required docs:

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md` if provider error normalization changes adapters
- `service/src/runtime/runtime.spec.md` if stream runtime events ship
- `service/src/routes/routes.spec.md` and `service/src/routes/threads/threads.spec.md` if route or SSE behavior changes
- `web/src/features/threads/threads.spec.md` if web stream types change
- `docs/proto.md` if new SSE event shapes ship
- `bud.spec.md`

Document the key invariant everywhere relevant: compaction affects model-visible replay state, not visible transcript history.

### Task 4: Manual validation

Run the checklist in [validation-checklist.md](./validation-checklist.md).

Minimum scenarios:

- normal short thread remains no-compaction
- long thread compacts pre-turn and answers coherently
- long tool output compacts mid-turn and continues
- service restart uses latest completed checkpoint
- provider switch after checkpoint uses canonical fallback
- automatic compaction disabled by kill switch preserves old behavior
- non-owner cannot access any manual route if one ships

### Task 5: Add operational logging and rollback notes

Ensure logs can answer:

- which thread compacted
- why compaction triggered
- what model/provider summarized
- estimated tokens before and after
- whether compaction succeeded
- whether a provider context-window retry occurred

Rollback controls:

- set `AGENT_AUTO_COMPACTION_ENABLED=false`
- leave checkpoint rows in place
- loader still uses completed checkpoints unless a separate emergency bypass is added

If an emergency loader bypass is needed, add and document a separate `AGENT_CONTEXT_CHECKPOINTS_ENABLED=false` flag.

### Task 6: Decide launch posture

Recommended launch posture:

- ship automatic compaction enabled by default in development/staging after validation
- keep public manual compaction deferred
- keep provider-native remote compaction deferred
- monitor compaction count, failure count, and average tokens-after

## Commands

Expected service verification commands:

```bash
pnpm --dir /Users/adam/bud/service test
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/service db:generate
```

Use narrower package-local commands during implementation when appropriate.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Migration works locally but not in staging | Medium | High | Verify generated migration and run `db:migrate` in staging validation |
| Tests miss realistic long-running tasks | Medium | Medium | Add one manual terminal-heavy validation script |
| Rollback disables triggers but loader still applies bad checkpoints | Medium | High | Consider separate emergency loader-bypass flag if validation uncovers bad summaries |
| Docs drift from additive SSE fields | Low | Medium | Update `docs/proto.md` in the same phase as event implementation |

## Exit Criteria

- Automated tests for phases 1-4 pass.
- Manual validation checklist is complete.
- Schema migration is generated and reviewed.
- Specs and protocol docs are updated.
- Rollout and rollback controls are documented.
