# Implementation Spec: Simplify Mobile Transcript API And Stream Contracts

**Status**: In Progress
**Created**: 2026-03-22
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Phase 1**: [phase-1-message-history-contract.md](./phase-1-message-history-contract.md)
**Phase 2**: [phase-2-agent-stream-contract.md](./phase-2-agent-stream-contract.md)
**Phase 3**: [phase-3-reference-web-simplification.md](./phase-3-reference-web-simplification.md)
**Phase 4**: [phase-4-true-assistant-streaming.md](./phase-4-true-assistant-streaming.md)
**Phase 5**: [phase-5-polish-validation-and-handoff.md](./phase-5-polish-validation-and-handoff.md)
**Related Docs**:
- [../../IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md](../../IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md)
- [../../IOS_MOBILE_BACKEND_HANDOFF.md](../../IOS_MOBILE_BACKEND_HANDOFF.md)

---

## Context

The current mobile/backend handoff surfaced a real contract mismatch:

- the service exposes a latest-message snapshot route, not a paginated transcript API
- the agent SSE stream is useful for in-flight UX, but it is not a strong durable transcript transport
- the current web client compensates with synthetic IDs, in-memory replay tolerance, and a full transcript refetch on `final`

That works well enough for prototype send/stream behavior, but it is fragile:

- clients cannot page older history cleanly
- replay can duplicate already-seen events
- event payloads lack stable identifiers for transcript reconciliation
- `agent.message` naming implies streaming semantics that do not exist today
- tool payload semantics vary by tool in ways clients have to learn from implementation details

This plan turns those findings into a phased cleanup focused on simpler, more durable contracts.

## Objective

Make Bud’s thread transcript surface simpler and more robust for both web and mobile by:

1. giving message history a real pagination contract
2. making the live stream explicitly transcript-aware and replay-safe
3. reducing the web client’s reliance on synthetic IDs and full-array replacement
4. creating a clean path to future true assistant text streaming

This is not a mobile-only API fork. The goal is one cleaner contract that both clients can consume.

## Why This Matters

The current system splits truth across three layers:

- canonical transcript rows in Postgres
- in-memory process-local replay buffers
- client-local optimistic/transient rows

The more those layers diverge, the more every client has to rediscover the same edge cases.

The simplest long-term direction is:

- canonical history is first-class and page-able
- live events map cleanly onto canonical transcript rows
- reconnect and replay rules are explicit
- full refetch becomes a fallback consistency mechanism, not the normal happy path

## Success Criteria

- [ ] `GET /api/threads/:thread_id/messages` supports real cursor paging with explicit metadata.
- [ ] Message ordering is stable and documented across all pages.
- [ ] Agent SSE events carry stable identifiers sufficient for transcript reconciliation.
- [ ] Replay/reconnect semantics are explicit and tested.
- [ ] The reference web thread view no longer depends on `final` full-array replacement for normal correctness.
- [ ] Tool payload semantics are normalized and documented enough that clients do not need implementation archaeology.
- [x] There is a clean incremental contract for future assistant text streaming, and the first shipped version now exists.

## Design Anchors

These decisions are fixed for this plan:

- Keep the existing thread route family rather than inventing mobile-only transcript routes.
- Prefer transcript-centric semantics over agent-loop-internal semantics where clients are concerned.
- Treat canonical transcript history as the source of truth.
- Treat live SSE as an augmentation layer with explicit replay rules.
- Use snake_case for all new or revised wire fields unless matching a third-party contract.
- Do not rely on process-local in-memory replay as the only recovery path after reconnect.

## Priority Summary

### Urgent

- Real message-history paging contract
- Stable stream identifiers and clearer event semantics
- Explicit replay/final/error rules
- Fixtures and integration tests for the new contract

### High

- Transcript-centric event model
- Reference web simplification around reconciliation and paging
- Thread bootstrap simplification once paged history exists

### Medium

- True assistant delta streaming
- Tool payload normalization and summary polish

### Low

- Optional filters and other quality-of-life additions that do not change the core contract

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-message-history-contract.md](./phase-1-message-history-contract.md) | Urgent | Thread message history becomes a real paginated transcript API with stable ordering |
| 2 | [phase-2-agent-stream-contract.md](./phase-2-agent-stream-contract.md) | Urgent | Agent SSE becomes explicit about identifiers, replay, completion, and transcript reconciliation |
| 3 | [phase-3-reference-web-simplification.md](./phase-3-reference-web-simplification.md) | High | The reference web client adopts the cleaned contract and stops depending on brittle transcript replacement patterns |
| 4 | [phase-4-true-assistant-streaming.md](./phase-4-true-assistant-streaming.md) | Medium | The backend and reference client gain true assistant-text streaming with draft/final semantics |
| 5 | [phase-5-polish-validation-and-handoff.md](./phase-5-polish-validation-and-handoff.md) | Medium | Tool payload polish, fixtures, validation, and handoff docs align with the shipped contract |

## Sequencing Notes

- Phase 1 is the foundation. Do not start client-side upward paging work before the backend contract exists.
- Phase 2 should land before treating SSE as anything more than a best-effort UX layer.
- Phase 3 should use the new Phase 1-2 contracts rather than adding more one-off client workarounds.
- Phase 4 is intentionally separate because true assistant streaming is materially more complex than the earlier contract cleanup; that implementation is now in place and feeds the remaining validation/polish work.
- Phase 5 is where the docs, fixtures, and validation package become handoff-grade.

## Expected Files And Areas

### Service

- `service/src/routes/threads.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/config.ts` if new caps or defaults are introduced
- `service/src/db/thread-metadata.ts` only if thread bootstrap/revision behavior changes
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/src.spec.md`

### Web

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/workbench/thinking-indicator.tsx`
- `web/src/lib/api.ts`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/lib/lib.spec.md`

### Root Docs

- `bud.spec.md`
- `IOS_MOBILE_BACKEND_HANDOFF.md`
- `IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md`
- new fixtures or handoff docs if we publish them at root or under `reference/`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| We add paging but keep ambiguous ordering/tie behavior | Medium | High | Make stable ordering and cursor semantics part of Phase 1, not follow-up cleanup |
| We keep agent-centric event names but layer more meaning onto them | High | High | Use Phase 2 to settle the event taxonomy explicitly before more client logic accumulates |
| Web continues relying on synthetic IDs even after the backend exposes stable identifiers | Medium | Medium | Make Phase 3 a required contract adoption pass, not an optional polish item |
| True assistant streaming expands scope too early | High | Medium | Keep Phase 4 separate and do not block Phase 1-3 simplification on it |
| Tool payload cleanup regresses existing transcript fidelity | Low | Medium | Keep full-fidelity payloads available while clarifying summaries and truncation semantics |

## Rollout Strategy

1. Stabilize transcript history first.
2. Stabilize live event semantics second.
3. Move the reference web client onto the new contract.
4. Add true assistant streaming only after the simpler contract works.
5. Publish fixtures, docs, and validation notes once the shipped behavior is stable.

## Definition Of Done

- [ ] Phase 1-2 contracts are implemented and documented.
- [ ] The reference web thread view uses those contracts without the current brittle reconciliation pattern.
- [ ] Mobile-facing docs no longer describe nonexistent paging or implied streaming behavior.
- [ ] The new transcript and SSE contracts are covered by fixtures and integration-level checks.
- [ ] Future assistant delta streaming has a clear contract path instead of another ad hoc event addition.
