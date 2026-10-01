# Debug: Backend mobile performance

## Environment and baseline

2026-09-30, local macOS workspace. No deployment changes. Existing access-log and
invocation-worker suites pass (17 tests):
`pnpm --dir service exec node --import tsx --test src/access-log.test.ts src/agent/invocation-worker.test.ts`.
The scheduling fixtures use a mocked executor, not a live LLM.

## Reproduction and observations

`InvocationWorker.schedule` starts one `runOnce` per one-second timer even with
four available slots. `runOnce` scans recovery/expiry and then awaits execution.
There is no immediate refill or transaction-commit wake. Existing structured
access logs report completion duration, but lack pre-send timing and payload size.

## Proposed fix

Extend existing access logging; split worker claim pumping from awaited execution.
Serialize claims and coalesce wakes; preserve leases, fences and shutdown guards.
Connect admission/continuation after outer transaction commit, with periodic fallback.
Track implementation and further validation in `plan/backend-mobile-performance/`.
Affected specs: service source, agent, runtime, routes and downstream phase specs.

## Build validation

`pnpm build` from `service/` initially failed with TS2683 at
`src/access-log.ts:24,31,41`: raw-response wrappers needed explicit `this` types.
Added `this: typeof reply.raw` to preserve Node response typing.

`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-timing.test.ts src/agent/invocation-repository.test.ts` initially failed with local connection `EPERM` under the sandbox. The approved outside-sandbox rerun passed all 14 tests with no skips.

Service and web production builds pass. Web retains its existing large-chunk warning. Focused service access-log/worker/timing/events/runtime run: 40 passed, one opt-in DB suite skipped (separately run above). Web invocation-state tests: 12 passed. No production or mobile latency claim is made.

## Atomic creation validation

`pnpm --dir /Users/adam/bud/service db:push` proposed unrelated recreation of
`agent_invocation_dedupe_key` on 307 existing rows. Canceled without truncation.
Generated/reviewed `0048_lush_timeslip.sql` and applied only that additive SQL in
a local transaction after sandbox `EPERM` required approved localhost access.

`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/routes/threads/creation-repository.test.ts`
initially failed inserting the fixture auth user with `emailVerified: default`.
The auth-managed local table requires an explicit value; changed the fixture to
`emailVerified: false`, matching existing repository fixtures.

The rerun passed both tests, including the real PostgreSQL race/rollback/migration
case. Combined route fixtures pass anonymous/foreign-owner rejection and current
completed-state retry. Service build then caught TS7006 in the new mock callback;
added parameter types derived from `ThreadCreationRepository.create`.

## Concurrent read watermark

Code inspection found a prior read followed by an unconditional upsert in
`POST /api/threads/:threadId/read`: two requests can both observe the old row
and the later commit can rewind the watermark. Replace with conditional SQL
upsert comparing the canonical millisecond timestamp/UUID tuple, then read the
winner for stale requests. Share an owner-scoped SQL aggregate with notification
summary. Real PostgreSQL concurrent requests provide the regression check.

`pnpm build` from `service/` caught TS2769 in the watermark fixture: mapped
message `role` widened to `string`. Added the literal type `as const`; runtime
PostgreSQL tests had already passed.

`pnpm build` from `service/` caught TS2339 in compact serializer tests because
the inferred non-tool union omitted optional DTO fields; declared the shared
`MessageView` return type. It also caught the old list-stream fixture signature
after owner-feed replacement; migrated that fixture to the owner contract.

`pnpm build` from `web/` caught TS1294: the list reducer used constructor
parameter properties with `erasableSyntaxOnly`. Replaced them with declared
fields and constructor assignments.

`pnpm exec node --import tsx --test src/routes/threads/messages.test.ts src/routes/threads/registration.test.ts` from `service/` failed only the exact registration inventory: actual added `POST /api/threads/:threadId/messages/reconcile`. Updated the expected endpoint set; the nine message tests passed.

## Invalidation replay boundary

Inspection found that transcript invalidations do not mutate the runtime overlay.
Reusing only its last state cursor on open would replay an already repaired
invalidation indefinitely. Open now asks for a fresh checkpoint synchronously
before canonical reads. A regression test proves old invalidations are covered,
changes during reads replay, and the next recovery does not loop.

Final `pnpm build` in service caught TS2322/TS2345 in the added pagination
fixture: the raw tuple lacked cursor scope/version fields and crypto UUID array
inference was narrower than returned string IDs. Use the exported full cursor
type and a string ID array. Runtime PostgreSQL pagination had already passed.

The pagination fixture's cleanup thread-ID array also inferred the crypto UUID
template type (TS2345 on push). Declared that array as `string[]` as well.
