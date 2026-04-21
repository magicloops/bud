# Phase 5: Validation, Specs, And Final Cleanup

## Objective

Finish the refactor by validating behavior, updating specs/docs, and removing or explicitly documenting any remaining dead legacy runtime/schema remnants.

## Scope

### In scope

- manual validation of the refactored service
- spec/doc updates for the new service module layout and DB workflow
- final dead-code cleanup tied to the removed standalone runtime
- schema cleanup if legacy run tables or columns are now truly unused

### Out of scope

- staged rollout playbooks
- production-only operationalization work
- new product features

## Proposed Work

### 1. Run the validation matrix

Use the companion [validation-checklist.md](./validation-checklist.md) to confirm:

- provider-less boot for auth/device-claim flows
- correct ownership behavior for streams and route reads
- stable thread-scoped terminal behavior
- cancel/offline fast-fail semantics
- successful agent turns after the decomposition

### 2. Update specs and root documentation

Update at least:

- `service/service.spec.md`
- `service/src/src.spec.md`
- affected folder specs under `service/src/`
- `bud.spec.md`

If the DB workflow note is corrected as part of this refactor, also update:

- `AGENTS.md`
- `service/README.md`
- `service/drizzle/drizzle.spec.md`
- `service/drizzle/migrations/migrations.spec.md`

### 3. Decide final schema cleanup for the removed legacy runtime

If the standalone runtime removal leaves `run`, `run_step`, `run_log`, `run_summary`, or related code/schema surfaces truly dead, either:

- remove them now and document the local/staging DB validation path, or
- explicitly document why that schema cleanup is still deferred

This decision should not be left implicit.

### 4. Validate DB workflow with the actual current posture

If schema changes occur in this refactor:

- validate local development with `pnpm db:push`
- validate staging with `pnpm db:migrate`

There is no production rollout step yet, so do not add speculative production migration guidance here.

## Expected File Areas

- `service/service.spec.md`
- `service/src/src.spec.md`
- affected folder specs under `service/src/`
- `service/src/db/schema.ts` if cleanup is needed
- `service/README.md`
- `service/drizzle/drizzle.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `AGENTS.md` if touched
- `bud.spec.md`

## Testing Strategy

### Automated

- run the most relevant service tests added during Phases 1-4
- add final regression coverage for any cleanup that removes code/schema paths

### Manual

- work through the validation checklist end to end
- if schema changed, verify the local and staging DB paths described above

## Exit Criteria

- the validation checklist has been exercised
- service specs and root docs match the refactored module layout
- DB workflow docs describe reality
- any remaining legacy runtime/schema remnants are either removed or explicitly documented as deferred
