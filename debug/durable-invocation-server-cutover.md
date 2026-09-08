# Debug: Durable invocation server cutover

## Environment and reproduction
Local service, PostgreSQL; inspect `buildServer()` after implementing phase 5.

## Observed
The composition root constructs AgentService without the invocation repository.
The durable worker is never started. No runtime error is required to reproduce:
normal message requests still use the detached legacy start path.

## Expected
An explicit startup setting selects one admission path, starts/stops its worker,
and refuses unsafe rollback while durable work remains unresolved.

## Proposed fix
Add validated startup configuration and a database session mode guard. New
processes coordinate mode acquisition; older binaries still require operational
drain. Keep legacy as the default until the remaining phase 5 cutover checks pass.
Document configuration, lifecycle and remaining validation in the source spec
and phase 5 plan.

## Validation issue
`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/invocation-startup.test.ts src/agent/invocation-executor.test.ts src/agent/invocation-worker.test.ts` initially failed: `The input did not match the regular expression /migrations_required/. Input: Error: agent_invocation_mode_conflict`.
The running development server held the same database-wide lock even though the
fixture used a separate schema. Scope lock identity to `current_schema()`; real
replicas using the same schema still exclude opposite modes.
