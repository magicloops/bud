# Phase 6: Review hardening and slow backstop

Status: Implemented in the working tree 2026-10-06; automated checks pass (see
[validation](validation-and-rollout.md)). Two-tab smoke test and deploy pending.
Source: review of PR #140 (2026-10-06).
Applies to the Phase 1–3 implementation on `codex/client-state-performance`;
intended to land in the same PR before merge.

## Decisions

- Keep the PR's design: exact v2 cursors, cheap state plus dedicated budget
  read, trigger-published pending invalidation.
- Add a slow cheap-state backstop while a thread is visible. Trigger coverage
  gaps must self-heal without a foreground or reconnect.
- **Mobile is not live.** No installed mobile build consumes these contracts,
  so no backwards compatibility, cursor-reset coordination or mixed-version
  window is required. Mobile adopts the final contract from the
  [handoff](mobile-api-handoff.md) when it ships. Web deploys with the service.
- Application post-commit hooks remain rejected; triggers cover raw-SQL and
  maintenance writers.

## 1. Slow backstop

Amends [Phase 3](phase-3-pending-request-events.md): hints stay the primary
path; the backstop only bounds staleness after a missed hint.

- In `usePendingRequests`, while the document is visible, call the existing
  `invalidate()` once per 60 seconds. Reuse the hook's coalescing, generation
  fencing, backoff and 401/403/404 stop; add no second request path.
- Restart the interval after any completed inventory read, so a hint-driven
  read defers the next backstop read. Pause while hidden; the existing
  foreground invalidation covers return.
- The read is cheap `/agent/state` only. It applies pending inventory through
  `applyPendingRequests`. It never calls `/open` or `/context-budget`, never
  moves the stream cursor and never triggers history reconciliation.
- Lifecycle and transcript truth keep their own events and recovery; the
  backstop does not compare invocation revisions. Remove the now-unused
  `invocationRevision` export and its tests.
- Mobile implements the same 60-second visible-thread rule in the handoff.

This replaces Phase 3's "zero recurring requests" acceptance with: at most one
cheap state read per 60 seconds per visible thread, and zero recurring
`/open` or `/context-budget` requests.

## 2. Simplify the event payload

`agent.pending_requests_changed` always lists all five kinds, and web
rebootstraps on any unknown kind. Drop `kinds`: the payload becomes `{}` and
means "reread pending inventory".

- Service: remove `pendingRequestKinds` from `pending-events.ts`; emit `{}`.
- Web: remove the kinds list and validation in `use-agent-stream.ts`; keep the
  stale-source, thread and duplicate-event-ID guards.
- Update `docs/proto.md`, [fixtures](contract-fixtures.json), the mobile
  handoff and the Phase 3 contract section.

Adding a sixth pending kind then needs no event or client-validation change.

## 3. Trigger fixes (migration 0050)

0050 is unmerged and unapplied outside local databases, so edit it in place
rather than adding 0051. Reapply the exact SQL locally after editing.

- For `agent_invocation_action`, test the `waiting_for_user` status filter
  before any `to_jsonb(OLD/NEW)` comparison. Ordinary tool progress must not
  serialize `evidence`.
- Test against the real schema. Replace the `LIKE agent_question_request`
  stand-ins in `change-listener.test.ts` with tables created from the
  checked-in migrations (or the real tables inside a rolled-back transaction),
  so a renamed `thread_id`, `created_by_user_id`, `invocation_id` or `status`
  column fails the test instead of silently dropping hints.
- Derive the startup trigger check in `change-listener.ts` from one exported
  list of required trigger names; compare against its length, not a literal 12.

## 4. Cleanup

- `PendingRequestEvents` and `TranscriptEvents` keep separate queue/drain/
  generation copies: a shared base would be larger than the ~20 duplicated
  lines. Noted in `threads.spec.md`.
- Use one helper for the "active turn's budget is applicable" condition in
  `agent.ts` and `state-loader.ts`.
- Fix the `onInvocationChanged` indentation in `use-agent-stream.ts` (three sites).
- Keep request histograms; record the baseline per the
  [runbook](measurement-runbook.md) after deploy.

## Rollout

- Deploy order is unchanged: Render runs `pnpm db:migrate` (through 0050)
  before service start; startup verifies the triggers. Web ships alongside.
- Open web tabs holding v1 cursors recover through the existing
  `invalid_message_cursor` reset. No mobile step.
- Removed pre-merge gates: mobile build selection, installed-client reload and
  mobile cursor clearing. Remaining gates: single-instance topology check and
  the two-account, two-tab pending create/decide/expire/replay smoke test.

## Spec files to update

- [x] `service/src/routes/threads/threads.spec.md`, `docs/proto.md`
- [x] `web/src/features/threads/threads.spec.md`, `web/src/routes/$budId/budId.spec.md`
- [x] `service/drizzle/migrations/migrations.spec.md`, `service/src/db/db.spec.md`
- [x] [mobile handoff](mobile-api-handoff.md), [fixtures](contract-fixtures.json),
      [mutation coverage](mutation-coverage.md), [Phase 3](phase-3-pending-request-events.md)

## Acceptance

- [ ] With hints suppressed, a pending card created or resolved elsewhere
      converges within 60 seconds on a visible thread; nothing is read while hidden.
- [x] Ten idle visible minutes: at most ten `/agent/state` reads, zero `/open`
      and `/context-budget` reads. A hint-driven read resets the interval.
- [ ] Backstop reads never move the stream cursor or discard live drafts.
- [x] Trigger test runs against real table definitions and fails on a renamed column.
- [x] Action updates outside `waiting_for_user` emit no hint and perform no
      row serialization.
- [x] Empty-payload event accepted by web; fixtures and protocol docs match.
- [x] Service and web builds, changed-file lint and the existing Phase 1–3
      suites pass with zero skips.
