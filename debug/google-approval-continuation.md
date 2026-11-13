# Debug: Google approval continuation validation

## Environment
- Local macOS development checkout; isolated PostgreSQL schema cloned from local public tables.
- Synthetic provider ledger; no Google network writes.

## Repro Steps
From `service/`:
```sh
BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-google-approval.test.ts
```

## Observed
The foreign-thread fixture passed `another-thread` to a UUID database field. Exact test output:

```text
TAP version 13
# Subtest: Google approvals park atomically, recover by owner, expire, and restore exactly once without executing
not ok 1 - Google approvals park atomically, recover by owner, expire, and restore exactly once without executing
  ---
  duration_ms: 349.752541
  type: 'test'
  location: '/Users/sp/.codex/worktrees/google-calendar-policy/bud/service/src/agent/invocation-google-approval.test.ts:1:496'
  failureType: 'testCodeFailure'
  error: |-
    Failed query: select "agent_invocation_action"."id", "agent_invocation_action"."invocation_id", "agent_invocation_action"."call_id", "agent_invocation_action"."fence", "agent_invocation_action"."kind", "agent_invocation_action"."status", "agent_invocation_action"."evidence", "agent_invocation_action"."created_by_user_id", "agent_invocation_action"."tenant_id", "agent_invocation_action"."created_at", "agent_invocation_action"."completed_at", "agent_invocation"."turn_id", "agent_invocation"."id" from "agent_invocation_action" inner join "agent_invocation" on ("agent_invocation"."id" = "agent_invocation_action"."invocation_id" and "agent_invocation"."created_by_user_id" = "agent_invocation_action"."created_by_user_id") inner join "thread" on ("thread"."thread_id" = "agent_invocation"."thread_id" and "thread"."created_by_user_id" = $1) inner join "bud" on ("bud"."bud_id" = "agent_invocation"."bud_id" and "bud"."created_by_user_id" = $2) where ("agent_invocation_action"."created_by_user_id" = $3 and "agent_invocation"."thread_id" = $4 and "agent_invocation"."status" = $5 and "agent_invocation_action"."kind" = $6 and "agent_invocation_action"."status" = $7 and "agent_invocation"."cancel_requested_at" is null and "thread"."deleted_at" is null and "agent_invocation_action"."evidence"->'google_approval'->>'status' = 'pending' and ("agent_invocation_action"."evidence"->'google_approval'->>'expires_at')::timestamptz > clock_timestamp()) order by "agent_invocation_action"."id" asc limit $8
    params: google-approval-c6b02df8-cca6-477a-a8f5-6fd4e02b54fc,google-approval-c6b02df8-cca6-477a-a8f5-6fd4e02b54fc,google-approval-c6b02df8-cca6-477a-a8f5-6fd4e02b54fc,another-thread,waiting_for_user,google_call,waiting_for_user,20
  code: 'ERR_TEST_FAILURE'
  stack: |-
    NodePgPreparedQuery.queryWithCache (/Users/sp/.codex/worktrees/google-calendar-policy/bud/service/node_modules/.pnpm/drizzle-orm@0.44.7_@types+pg@8.15.6_kysely@0.28.12_pg@8.16.3/node_modules/src/pg-core/session.ts:73:11)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async <anonymous> (/Users/sp/.codex/worktrees/google-calendar-policy/bud/service/node_modules/.pnpm/drizzle-orm@0.44.7_@types+pg@8.15.6_kysely@0.28.12_pg@8.16.3/node_modules/src/node-postgres/session.ts:154:19)
    async InvocationRepository.pendingGoogleApprovalsForThread (/Users/sp/.codex/worktrees/google-calendar-policy/bud/service/src/agent/invocation-repository.ts:159:18)
    async TestContext.<anonymous> (/Users/sp/.codex/worktrees/google-calendar-policy/bud/service/src/agent/invocation-google-approval.test.ts:71:22)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 920.992625

```

## Expected
A different valid UUID returns an empty owned approval list.

## Hypotheses
The fixture uses an invalid UUID; owner filtering and the query are not at fault.

## Proposed Fix
Use `randomUUID()` for the unrelated thread, then rerun the database fixture. Related specs: `service/src/agent/agent.spec.md`, `service/src/routes/threads/threads.spec.md`.

## Validation
- Corrected the test-only UUID. The exact PostgreSQL command above now passes.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec node --import tsx --test src/agent/google-approval-loop.test.ts src/agent/invocation-worker.test.ts src/routes/threads/state-loader.test.ts`: 20 passed.


## Parking-failure fixture follow-up

The command `pnpm exec tsc --noEmit && pnpm exec node --import tsx --test src/agent/google-approval-loop.test.ts` passed compilation but the new failure-path fixture rejected the existing failure notification. Exact assertion output (both branches):

```text
The input did not match the regular expression /stale_invocation_lease/. Input:
'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n' +
  '+ actual - expected\n' +
  '\n' +
  "+ 'final'\n" +
  "- 'agent.tool_call'\n"
```

The missing-hook case had the same assertion with `/google_approval_unavailable/`. The fixture must accept and inspect the existing failed `final` event and error state before asserting the original exception is rethrown; production behavior is unchanged.

Updated the fixture to inspect failed-final/error-state emissions. The exact command above now passes TypeScript and all three loop scenarios in both branches.
