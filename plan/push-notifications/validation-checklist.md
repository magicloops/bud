# Validation Checklist: Push Notifications

Manual validation pending.

## Schema And Ownership

- [ ] `push_endpoint` rows are scoped to the authenticated user
- [ ] `thread_read_state` rows are scoped to `(thread_id, user_id)`
- [ ] Cross-user registration or read operations still return `404` or `401` according to the current auth rules
- [ ] `thread.last_attention_*` fields update only from durable attention-worthy artifacts

## Push Endpoint Registration

- [ ] `PUT /api/me/push/endpoints/:installation_id` upserts registration idempotently
- [ ] Re-registering with a rotated token updates the owned endpoint instead of creating duplicates
- [ ] `DELETE /api/me/push/endpoints/:installation_id` disables or removes the owned endpoint
- [ ] Logging out or account switch flow stops future sends for that installation once the client cleans up

## Read State

- [ ] `POST /api/threads/:thread_id/read` only moves the watermark forward
- [ ] Submitting an older visible message does not move the watermark backward
- [ ] Marking one thread read does not affect another thread
- [ ] A read acknowledgment suppresses future sends for that already-seen attention boundary

## Thread List And Badge Semantics

- [ ] `GET /api/threads` returns `has_unseen_attention`
- [ ] `GET /api/threads` returns `last_attention_kind`
- [ ] `GET /api/me/notifications/summary` returns `unseen_thread_count`
- [ ] `unseen_thread_count` equals the number of owned threads with unseen attention-worthy output
- [ ] Two unseen assistant messages on the same thread still count as one badge unit
- [ ] One unseen assistant message on each of two threads counts as two badge units

## Assistant Completion Trigger

- [ ] A successful persisted assistant message updates `thread.last_attention_*`
- [ ] A successful persisted assistant message creates exactly one outbox row
- [ ] Draft assistant SSE alone does not create outbox work
- [ ] Tool results do not create assistant-completion outbox work
- [ ] Failure-only `final` events do not notify in V1

## Outbox And Delivery

- [ ] Pending outbox rows can be claimed exactly once by the worker
- [ ] Already-seen rows are marked `suppressed`
- [ ] Rows with no enabled endpoints are marked `suppressed`
- [ ] Successful APNs sends are marked `sent`
- [ ] Retryable APNs failures increment `attempt_count` and reschedule `next_attempt_at`
- [ ] Invalid APNs tokens invalidate endpoints and stop further retries for that endpoint

## Payload And Collapse Behavior

- [ ] APNs payload includes thread and message identifiers needed for app open/reconciliation
- [ ] Notification collapse key is thread-scoped
- [ ] Lock-screen preview behavior matches the endpoint preference and final product decision

## Human-Input Prompt Follow-On

- [ ] Once implemented, `human_input_requested` uses a durable transcript artifact
- [ ] The prompt artifact updates `thread.last_attention_kind`
- [ ] The prompt artifact inserts one outbox row with `kind = human_input_requested`
- [ ] Human-input prompts still contribute only one badge unit per unseen thread

## Docs / Specs

- [ ] `docs/proto.md` reflects the new routes and unread semantics
- [ ] Relevant service specs are updated
- [ ] `bud.spec.md` includes the new plan references and still reads coherently
