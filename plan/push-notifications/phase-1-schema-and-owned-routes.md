# Phase 1: Schema And Owned Routes

## Goal

Establish the durable ownership and unread primitives that the rest of the notification pipeline depends on.

This phase is intentionally provider-agnostic. It should not attempt APNs delivery yet.

## Scope

### Schema

Add:

- `push_endpoint`
- `thread_read_state`
- `push_notification_outbox`

Add thread summary columns:

- `thread.last_attention_message_id`
- `thread.last_attention_message_created_at`
- `thread.last_attention_kind`

### Owned routes

Add:

- `PUT /api/me/push/endpoints/:installation_id`
- `DELETE /api/me/push/endpoints/:installation_id`
- `POST /api/threads/:thread_id/read`
- `GET /api/me/notifications/summary`

Additive thread-list contract:

- `GET /api/threads` returns `has_unseen_attention`
- `GET /api/threads` returns `last_attention_kind`

## Implementation Tasks

### Task 1: Extend schema

Update `service/src/db/schema.ts` with the new tables and `thread` summary columns.

Constraints:

- all new user-facing rows should carry `user_id` or equivalent owner linkage
- new indexes should support:
  - endpoint lookup by user
  - read-state lookup by `(thread_id, user_id)`
  - outbox claim by `status` and `next_attempt_at`
  - unread-thread aggregation by owner and latest attention summary

### Task 2: Define message-attention semantics

For this phase, define but do not yet populate:

- `assistant_completed`
- `human_input_requested`

Recommended internal type:

```text
type AttentionKind = "assistant_completed" | "human_input_requested"
```

### Task 3: Add push endpoint registration routes

Implement owned registration in `service/src/routes/me.ts` or a nearby split route module.

Required behavior:

- viewer is resolved through existing cookie-or-bearer auth
- upsert by `(user_id, installation_id)`
- `PUT` updates token and preferences idempotently
- `DELETE` disables or removes the owned endpoint
- cross-user operations remain impossible because the installation id is scoped under the resolved viewer

### Task 4: Add read acknowledgment route

Implement `POST /api/threads/:thread_id/read`.

Required behavior:

- authorize owned thread access first
- validate `last_seen_message_id` belongs to that thread and viewer-visible transcript
- resolve the message’s `created_at`
- upsert read state and only move the watermark forward

Do not:

- accept arbitrary timestamps from the client as the source of truth
- allow the watermark to move backward

### Task 5: Add badge-summary route

Implement `GET /api/me/notifications/summary`.

Response should be derived from:

- owned threads
- each thread’s latest attention summary
- the user’s `thread_read_state`

Badge semantics are fixed:

- `unseen_thread_count` equals the number of owned threads whose latest attention tuple is newer than the read-state watermark

### Task 6: Extend thread list query

Update `GET /api/threads` query shape to include additive unread indicators.

Recommended fields:

- `has_unseen_attention`
- `last_attention_kind`

Optional:

- `last_attention_message_id`

## Tests

Add focused coverage for:

- push endpoint upsert and delete ownership
- read-state monotonicity
- summary-route unseen-thread counting
- thread-list unread indicator projection

## Docs / Specs

Update:

- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `service/service.spec.md`
- `docs/proto.md`

## Exit Criteria

- schema compiles and local `db:push` shape is defined
- owned registration/read routes exist
- badge summary can be computed without scanning all messages every time
- thread list exposes server-owned unread attention state
