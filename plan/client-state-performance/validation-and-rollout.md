# Validation, progress and rollout

Status: Local implementation/automated validation completed for service/web 0–3.
Unchecked end-to-end gates remain outstanding; no deployment performed.

## Phase progress

- [ ] Phase 0: measurement export selected; baseline and wake confirmation recorded.
- [ ] Phase 1: exact cursors and both-client reset behavior validated.
- [ ] Phase 2: cheap state/open and dedicated budget endpoint adopted.
- [ ] Phase 3: mutation matrix complete; healthy idle thread polling removed.
- [x] Phase 4: explicitly deferred; no measured case yet for cache invalidation complexity.
- [ ] Phase 5: decisions resolved and enforcement delivered, or separately reported
      as outstanding; do not count a deferral as fulfilling F4.

## Required evidence

Each implementation PR records commands, environment, pass/fail/skips and fixture
versions. Run package-local scripts from the owning package. Include real
PostgreSQL cursor tests and transactional publication tests; mocked timestamps
alone cannot establish precision correctness. Do not count skipped DB tests as
passed. Run relevant service/web builds and web lint after implementation.

- [ ] Two authenticated sessions plus foreign-owner checks for every changed
      read/stream; additions recorded in the auth validation checklist.
- [ ] Slow/delayed requests, duplicate events, mutation during open/attach and
      mutation during state refresh cannot rewind live state or skip events.
- [ ] Publication failure, restart and stale cursors force canonical recovery.
- [ ] No missing final/compaction/reasoning rows after history pagination or replay.
- [ ] Ten-minute idle request counts and representative cold/warm open latency,
      with payload sizes, sample counts and error rates recorded.
- [ ] Fixtures for cursor rejection/reset, pending hints plus refreshed empty/full
      arrays, and budget omitted/unknown/stale/available supplied to mobile.
- [ ] Documentation describes actual limits; process-local replay is not durable.

## Coordinated rollout

The service deploys automatically on merge. Pre-launch coordinated upgrades are
feasible; no prolonged compatibility machinery is planned.

1. Confirm production still has one service instance with its invocation worker
   in-process. Record actual service revision, web build and mobile build number.
2. Phase 0 can deploy independently. Phase 1 requires web/mobile invalid-cursor
   reset support before switching encoders; coordinate a reload/update of installed
   clients and clear cached pagination boundaries. Old cursors fail explicitly.
3. Ship Phase 2/3 service and matching web/mobile consumers in the controlled
   cutover. During the short gap, old clients may retain polling; do not advertise
   fresh budget behavior for old consumers. Record exact sequencing and whether
   a brief controlled maintenance window is needed before merge.
4. Smoke-test open, old/new history boundaries, send/final, cross-device pending
   creation/answer, expired request, stream reconnect and meter refresh on both
   clients. Confirm idle requests stop after hydration.
5. Phase 4, if selected, changes no core client contract. Phase 5 has its own
   migration/credential-renewal plan and explicit account/stream/cache tests.

No daemon release is expected for 0–4. Confirm Phase 5 execution-policy scope
before declaring whether it affects daemon/automation operations.

## Rollback

For cursor or state-contract rollback, coordinate client reload/rebootstrap with
the matching service version; stale cursors cannot be transparently reused.
For event delivery defects, restore the previously tested client recovery poll
temporarily while fixing coverage; name and remove that bridge after validation.
Do not mutate transcript timestamps or delete durable request/invocation rows.
Auth rollback must preserve disablement/revocation state and fail closed; never
roll back to bypassing established policy merely to restore availability.

## Completion record

Add actual versions, deployment order, migrations (if any), benchmark results,
mobile acknowledgement and remaining limitations here during implementation.
Handoff delivery is not mobile execution evidence. No version/build is assigned
by this spec. Commits, PRs, merges and deployments still require user intent.

## Local evidence — 2026-10-05

- Service `pnpm build`: passed. Web `pnpm build`: passed with existing Vite
  chunk-size warnings.
- Service `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test` with
  `src/routes/threads/{message-cursor,open,registration,messages,agent-question-response,change-listener,pending-events}.test.ts`,
  `src/request-metrics.test.ts`, `src/access-log.test.ts`: 30 passed, zero skipped.
  PostgreSQL tests use disposable/transactional fixtures, not production rows.
- Web `pnpm exec tsx --tsconfig tsconfig.app.json --test` with
  `src/features/threads/client-state-refresh.test.tsx`, `use-context-budget.test.tsx`,
  `use-pending-requests.test.tsx`, `thread-message-state.test.ts` and
  `src/components/workbench/streaming-parity.test.tsx`: 30 passed, zero skipped.
  Pending refresh test advances ten minutes of fake time: zero idle reads.
- Service invocation-worker/invocation-events tests: 19 passed, zero skipped.
  Existing wake wiring retained; no scheduler replacement.
- Changed web files: ESLint passed. Full `pnpm lint`: 12 errors/4 warnings in
  untouched files; see implementation debug note. This is not a clean full lint.
- Migration generated by Drizzle custom generation; exact 0050 SQL applied locally
  and tested. db:push canceled before unrelated constraint/truncation proposal.

Still required: actual native build/adoption, real two-account/cookie/bearer smoke
checks, physical two-client request/expiry/replay acceptance, deployment migration,
production baseline and comparable before/after latency. No release SHA/build has
been assigned. F4 policy decisions are pending, not implemented or waived.

Additional web recovery check: `pnpm exec tsx --tsconfig tsconfig.app.json --test
src/features/threads/client-recovery.test.tsx` passed 17/17, zero skipped, covering
stream bootstrap, definitive auth/resource loss, navigation fences and reconnects.
`git diff --check` passed. No commit, push or deployment performed.
