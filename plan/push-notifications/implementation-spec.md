# Implementation Spec: Push Notifications For Unseen Agent Messages

**Status**: Planned
**Created**: 2026-04-21
**Design Doc**: [../../design/mobile-push-notifications-for-unseen-agent-messages.md](../../design/mobile-push-notifications-for-unseen-agent-messages.md)
**Related Plan**: [../../plan/mobile-push-notifications-for-unseen-agent-messages.md](../../plan/mobile-push-notifications-for-unseen-agent-messages.md)
**Related Design**: [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-schema-and-owned-routes.md](./phase-1-schema-and-owned-routes.md)
**Phase 2**: [phase-2-durable-enqueue-and-outbox.md](./phase-2-durable-enqueue-and-outbox.md)
**Phase 3**: [phase-3-apns-delivery-worker.md](./phase-3-apns-delivery-worker.md)
**Phase 4**: [phase-4-client-read-state-and-badge-adoption.md](./phase-4-client-read-state-and-badge-adoption.md)
**Phase 5**: [phase-5-human-input-attention-trigger.md](./phase-5-human-input-attention-trigger.md)

---

## Context

Bud’s current service architecture already has the right separation for notification work:

- `message` is the durable transcript source of truth
- `/api/threads/:thread_id/agent/state` is the in-flight runtime snapshot
- `/api/threads/:thread_id/agent/stream` is live transport
- `AgentTranscriptWriter.recordFinalAssistant(...)` is the durable assistant completion boundary
- ownership is already enforced across thread, message, and terminal routes

What is still missing is everything around user attention:

- no push endpoint registration
- no server-owned per-thread read state
- no thread-level attention summary for efficient badge queries
- no notification outbox
- no APNs or future FCM provider abstraction
- no durable human-input-request artifact yet

The design review in [../../design/mobile-push-notifications-for-unseen-agent-messages.md](../../design/mobile-push-notifications-for-unseen-agent-messages.md) proposed a read-state plus outbox model. This implementation spec makes that concrete and adds one important implementation refinement:

- because badge semantics are now fixed to `unseen threads with attention-worthy output`, the backend should persist a thread-level latest-attention summary alongside per-user read state

That gives us:

- efficient thread list unread indicators
- a straightforward aggregate badge count
- simpler outbox suppression decisions

without forcing the service to rescan `message` rows every time it needs to answer a thread-summary or badge query.

## Objective

Implement a cross-platform notification foundation that:

1. sends push notifications when a thread gains new unseen attention-worthy output
2. counts badges as `unseen threads with attention-worthy output`
3. works for the current iOS app via APNs
4. leaves a clean path for future Android clients
5. derives correctness from durable transcript and read state rather than from transient SSE timing
6. keeps delivery decoupled from transcript persistence through a notification outbox
7. supports future human-input prompts such as `askUserQuestion` once they become durable transcript artifacts

## Fixed Decisions

These decisions are fixed for this plan:

- Notification triggers come from durable transcript or durable thread-attention boundaries, not from draft SSE events.
- V1 attention-worthy output is the final persisted assistant message.
- Future `askUserQuestion`-style human-input prompts must become durable transcript-visible artifacts before they can notify.
- Badge count semantics are `unseen threads with attention-worthy output`.
- Unseen is derived from server-owned per-user thread read state.
- The backend should store the latest attention-worthy message summary on `thread` so unread-thread queries are cheap and deterministic.
- Push endpoints are owned user resources under `/api/me/*`, not thread resources.
- Delivery uses a DB-backed outbox and an asynchronous worker, not inline provider calls on the message-write path.
- Provider transport is abstracted from product platform.
- APNs ships first.
- FCM readiness is architectural, not required for Phase 3 closure.
- Failure-only `final` events do not notify in V1 unless they also persist a durable attention-worthy artifact.
- Web read-state adoption is recommended but not a blocker for initial mobile/APNs delivery.

## Proposed Data Model

### New table: `push_endpoint`

Owned mobile/device registration table keyed by `(user_id, installation_id)`.

Minimum fields:

- `endpoint_id`
- `user_id`
- `installation_id`
- `platform`
- `provider`
- `provider_environment`
- `app_id`
- `token`
- `enabled`
- `alerts_agent_completed`
- `alerts_human_input_requested`
- `include_message_preview`
- `invalidated_at`
- `last_registered_at`
- `last_seen_at`
- `last_error_at`
- `last_error_code`
- `last_error_message`
- `created_at`
- `updated_at`

### New table: `thread_read_state`

Per-user durable read watermark.

Minimum fields:

- `thread_id`
- `user_id`
- `last_seen_message_id`
- `last_seen_message_created_at`
- `last_seen_at`
- `created_at`
- `updated_at`

Primary key:

- `(thread_id, user_id)`

### New table: `push_notification_outbox`

Asynchronous send queue with retry and suppression state.

Minimum fields:

- `notification_id`
- `user_id`
- `thread_id`
- `message_id`
- `kind`
- `status`
- `dedupe_key`
- `collapse_key`
- `title`
- `body`
- `payload`
- `attempt_count`
- `next_attempt_at`
- `claimed_at`
- `sent_at`
- `suppressed_reason`
- `last_error_code`
- `last_error_message`
- `created_at`
- `updated_at`

### New thread summary columns

Recommended additions on `thread`:

- `last_attention_message_id`
- `last_attention_message_created_at`
- `last_attention_kind`

Recommended meanings:

- `last_attention_message_id`: the newest durable message that should count for unread-thread attention
- `last_attention_message_created_at`: ordering companion for efficient tuple comparison with read state
- `last_attention_kind`: `assistant_completed` now, later also `human_input_requested`

This keeps thread summary and badge queries cheap:

- a thread is unseen-for-attention if its `last_attention_*` tuple is newer than the user’s `thread_read_state` watermark

## API Surface

### Push endpoint registration

- `PUT /api/me/push/endpoints/:installation_id`
- `DELETE /api/me/push/endpoints/:installation_id`

### Read acknowledgment

- `POST /api/threads/:thread_id/read`

### Aggregate notification summary

Recommended route:

- `GET /api/me/notifications/summary`

Recommended response:

```json
{
  "unseen_thread_count": 3,
  "updated_at": "2026-04-21T20:15:04.000Z"
}
```

### Thread list unread indicators

Recommended additive `GET /api/threads` fields:

- `has_unseen_attention`
- `last_attention_kind`
- optionally `last_attention_message_id`

These fields should be derived server-side from `thread` summary columns plus `thread_read_state`.

## Success Criteria

- [ ] Push endpoints can be registered, updated, and deleted through owned `/api/me/*` routes.
- [ ] Per-user thread read state exists and can only move forward.
- [ ] `thread` stores the latest attention-worthy message summary.
- [ ] `GET /api/threads` can mark each owned thread with `has_unseen_attention`.
- [ ] `GET /api/me/notifications/summary` returns badge-ready `unseen_thread_count`.
- [ ] Assistant completion persists the assistant row, updates thread attention summary, and enqueues one outbox row atomically.
- [ ] Outbox dedupe prevents duplicate notification rows for the same attention boundary.
- [ ] APNs delivery runs asynchronously and retries transient failures.
- [ ] Invalid APNs tokens invalidate endpoints cleanly.
- [ ] Mobile can keep badge state in sync from summary and read-state routes.
- [ ] Future human-input prompts can slot into the same attention-summary and outbox model without redesigning the schema.
- [ ] Specs and protocol docs reflect the new routes and fields.

## Non-Goals

- replacing SSE with push for in-app updates
- introducing collaborative multi-user thread fan-out
- delivering notifications for non-durable failures in V1
- making cross-device foreground presence part of V1 correctness
- implementing the `askUserQuestion` tool itself in this plan
- optimizing for multi-instance worker distribution before the single-process version exists

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-schema-and-owned-routes.md](./phase-1-schema-and-owned-routes.md) | Urgent | Durable ownership primitives exist: push endpoints, read state, thread attention summary, and badge/read routes |
| 2 | [phase-2-durable-enqueue-and-outbox.md](./phase-2-durable-enqueue-and-outbox.md) | Urgent | Assistant completion atomically updates attention state and enqueues outbox work |
| 3 | [phase-3-apns-delivery-worker.md](./phase-3-apns-delivery-worker.md) | Urgent | APNs delivery, retry, invalidation, and observability are live behind a generic provider seam |
| 4 | [phase-4-client-read-state-and-badge-adoption.md](./phase-4-client-read-state-and-badge-adoption.md) | High | Mobile uses registration, read acknowledgments, thread unread indicators, and aggregate badge count cleanly |
| 5 | [phase-5-human-input-attention-trigger.md](./phase-5-human-input-attention-trigger.md) | High | Durable human-input prompts reuse the same attention and notification pipeline |

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/src/db/db.spec.md`
- `service/src/routes/me.ts`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/core.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/agent.spec.md`
- `service/src/auth/session.ts`
- new notification modules under `service/src/notifications/` or a similarly named folder
- `service/src/src.spec.md`
- `service/service.spec.md`

### Web

- `web/src/lib/api-types.ts`
- optional reference-web thread/read-state surfaces if we adopt read acknowledgments there

### Docs / Specs

- `docs/proto.md`
- `bud.spec.md`
- `design/mobile-push-notifications-for-unseen-agent-messages.md`

## Sequencing Notes

- Land the schema primitives before changing assistant persistence behavior.
- Land the atomic enqueue path before any provider-delivery worker.
- Keep APNs transport behind the provider seam from day one so Android does not require another notification-model redesign later.
- Do not couple badge-count correctness to push delivery state; it must come from thread attention summary plus read state.
- Keep human-input prompt delivery out of the initial assistant-completion rollout unless the durable prompt artifact is ready in the same branch.
- If multi-instance delivery becomes urgent before Phase 3 closes, preserve the outbox contract and upgrade the worker/claim model rather than changing the transcript/write boundary.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| We infer unseen from client attachment or SSE timing and get inconsistent badge counts | Medium | High | Make `thread_read_state` and `thread.last_attention_*` the only correctness inputs |
| Inline provider delivery slows or breaks message persistence | Medium | High | Enqueue inside the durable boundary and deliver asynchronously from the outbox |
| Duplicate assistant retries create duplicate push rows | Medium | High | Add a strong outbox `dedupe_key` derived from user, thread, message, and notification kind |
| Badge counts become expensive because we scan `message` for every thread-list load | High | Medium | Persist `thread.last_attention_*` summary columns |
| Invalid APNs tokens keep retrying forever | Medium | Medium | Classify permanent provider failures and invalidate endpoints immediately |
| Web and mobile read-state behavior diverges and causes cross-device false positives | High | Medium | Keep read-state semantics server-owned and document client rules clearly; adopt web read acknowledgments as a follow-up within this plan |
| Future `askUserQuestion` prompt shape does not map cleanly onto the assistant-only attention model | Medium | Medium | Reserve `last_attention_kind` and outbox `kind` as explicit enums from the start |

## Rollout Strategy

1. Add schema primitives, owned routes, and summary queries.
2. Ship assistant-completion attention-summary updates plus atomic outbox enqueue.
3. Add the APNs worker and endpoint invalidation behavior.
4. Adopt read-state and badge-summary flows in mobile.
5. Extend the same pipeline to durable human-input prompts once they exist.

## Definition Of Done

- [ ] The backend has one clear attention model: durable transcript artifact -> thread attention summary -> read-state comparison -> optional push delivery.
- [ ] Badge count equals the number of owned threads whose latest attention-worthy output is newer than the user’s read watermark.
- [ ] Assistant completion is the only V1 notification trigger.
- [ ] APNs delivery is asynchronous and retriable.
- [ ] Notification delivery failures do not break transcript persistence.
- [ ] Client-facing routes and list payloads are documented and ownership-aware.
- [ ] The future `human_input_requested` extension path is explicit and does not require replacing the V1 schema.
