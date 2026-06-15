# Implementation Spec: Agent Message Duration Metadata

**Status**: Planned
**Created**: 2026-06-09
**Design Doc**: [../../design/agent-message-work-duration-contract.md](../../design/agent-message-work-duration-contract.md)
**Related Plan**: [../tool-timing/implementation-spec.md](../tool-timing/implementation-spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-contract-and-helper-foundation.md](./phase-1-contract-and-helper-foundation.md)
**Phase 2**: [phase-2-tool-and-reasoning-metadata.md](./phase-2-tool-and-reasoning-metadata.md)
**Phase 3**: [phase-3-assistant-timing-stream-and-persistence.md](./phase-3-assistant-timing-stream-and-persistence.md)
**Phase 4**: [phase-4-client-types-docs-and-validation.md](./phase-4-client-types-docs-and-validation.md)

---

## Context

Mobile wants to calculate `Worked for 5m 43s` for whatever set of transcript
rows it collapses into a UI summary. That grouping may contain tools,
reasoning, assistant output, or a mix of all three.

Today the backend gives a partial contract:

- tool rows persist `metadata.started_at`, `metadata.finished_at`, and
  `metadata.duration_ms`
- live tool events include timing fields
- reasoning rows persist `metadata.started_at` and `metadata.finished_at`
- assistant and reasoning rows persist `metadata.turn_id`
- assistant rows do not persist work-duration metadata
- tool rows do not persist `metadata.turn_id`
- `message.created_at` is a row persistence timestamp, not a work interval

The next increment should generalize duration metadata per message without
introducing turn lifecycle storage.

## Objective

Standardize service-owned timing metadata on every agent-created message row
that represents visible work.

Specifically:

- persist `started_at`, `finished_at`, `duration_ms`, and `duration_source` on
  completed tool, reasoning, and assistant rows
- persist `turn_id` on tool rows to match assistant and reasoning artifacts
- add assistant draft timing to live stream/state so live and reload paths agree
- keep `message.content` replay-safe and free of UI-only timing fields
- keep grouping math client-owned
- avoid database migrations by using existing JSONB metadata

## Fixed Decisions

- Per-message timing is the durable v1 contract.
- `duration_source` is required for newly timed rows and starts as
  `service_wall_clock`.
- `duration_ms` is always `max(0, finished_at - started_at)`.
- Timing field names remain snake_case at API boundaries.
- User and system rows do not need duration metadata for this request.
- `message.created_at` must not be documented as a work-start or work-finish
  boundary.
- No `agent_turn` table is part of this implementation.
- No checked-in Drizzle migration is required unless the implementation chooses
  to add relational columns, which this plan does not recommend.

## Success Criteria

- [x] Tool rows in `/api/threads/:thread_id/messages` include
  `metadata.turn_id`, `metadata.started_at`, `metadata.finished_at`,
  `metadata.duration_ms`, and `metadata.duration_source`.
- [x] Reasoning rows include `metadata.turn_id`, `metadata.started_at`,
  `metadata.finished_at`, `metadata.duration_ms`, and
  `metadata.duration_source`.
- [x] Intermediate assistant rows include `metadata.started_at`,
  `metadata.finished_at`, `metadata.duration_ms`, and
  `metadata.duration_source`.
- [x] Final assistant rows include the same timing metadata.
- [x] `/agent/state.draft_assistant` includes `started_at` while assistant text
  is actively streaming.
- [x] `agent.message_start` includes `started_at`.
- [x] `agent.message_done` includes `started_at`, `finished_at`,
  `duration_ms`, and `duration_source`.
- [x] Emitted nested `message.metadata` matches later `/messages` metadata after
  reload.
- [x] First-party types, docs, and fixtures describe the additive fields.

## Non-Goals

- adding a durable `agent_turn` table
- producing backend grouped-summary rows
- changing `/api/threads/:thread_id/messages` response shape outside existing
  message metadata
- changing message ordering or pagination
- estimating durations for legacy assistant rows from neighboring timestamps
- excluding human wait time from `ask_user_questions` tool duration
- changing model-visible replay payloads

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-contract-and-helper-foundation.md](./phase-1-contract-and-helper-foundation.md) | Urgent | Lock metadata semantics and add shared helpers/types |
| 2 | [phase-2-tool-and-reasoning-metadata.md](./phase-2-tool-and-reasoning-metadata.md) | Urgent | Fill current tool/reasoning metadata gaps with low blast radius |
| 3 | [phase-3-assistant-timing-stream-and-persistence.md](./phase-3-assistant-timing-stream-and-persistence.md) | High | Add assistant timing to live stream, runtime state, and persisted rows |
| 4 | [phase-4-client-types-docs-and-validation.md](./phase-4-client-types-docs-and-validation.md) | High | Update types/docs/specs/fixtures and validate live/history parity |

## Expected Files And Areas

### Service

- `service/src/agent/contracts.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/agent/transcript-writer.test.ts`
- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`

### Web

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/src.spec.md`

### Docs / Specs

- `docs/proto.md`
- `design/agent-message-work-duration-contract.md`
- `plan/message-duration-metadata/message-duration-metadata.spec.md`
- `bud.spec.md`

## Sequencing Notes

- Phase 1 should land first so every later field uses the same helper and source
  label.
- Phase 2 can ship independently because it only extends rows that already have
  timing boundaries.
- Phase 3 is the highest-risk phase because assistant text currently has weaker
  runtime timing state than tools/reasoning.
- Phase 4 should verify both live SSE payloads and persisted history because
  mobile relies on parity across stream, reload, and pagination.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Assistant timing boundaries drift between live stream and persistence | Medium | High | Carry one `startedAt`/`finishedAt` pair from model runner through transcript writer |
| `duration_ms` is interpreted as exact turn duration | Medium | Medium | Document that it is per message; clients choose sum vs interval union |
| Timing fields leak into `message.content` and affect replay | Low | High | Test `message.content` shape and keep timing in metadata only |
| Legacy assistant rows create inconsistent UI | Medium | Low | Document fallback: omit duration for untimed rows |
| `ask_user_questions` duration includes human wait time | Medium | Medium | Preserve current wall-clock semantics and add future paused/active fields only if product asks |

## Rollout Strategy

1. Add shared metadata helpers and types.
2. Extend tool and reasoning persisted metadata.
3. Add assistant draft start tracking and stream timing.
4. Persist assistant timing metadata.
5. Update first-party types, docs, specs, and fixtures.
6. Validate live stream, reload, pagination, and legacy fallback behavior.

## Definition Of Done

- [ ] Tool, reasoning, and assistant work rows expose consistent duration
  metadata.
- [ ] Live assistant timing fields match persisted assistant metadata.
- [ ] `/messages` requires no extra query or schema migration to expose timing.
- [ ] Existing model replay is unchanged.
- [ ] Specs and protocol docs explain the contract and client calculation rules.
- [ ] Mobile can compute grouped duration from the rows it actually collapses.
