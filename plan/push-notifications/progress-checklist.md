# Progress Checklist: Push Notifications

## Phase 1: Schema And Owned Routes

- [ ] Add `push_endpoint` schema
- [ ] Add `thread_read_state` schema
- [ ] Add `push_notification_outbox` schema
- [ ] Add `thread.last_attention_message_id`
- [ ] Add `thread.last_attention_message_created_at`
- [ ] Add `thread.last_attention_kind`
- [ ] Add `PUT /api/me/push/endpoints/:installation_id`
- [ ] Add `DELETE /api/me/push/endpoints/:installation_id`
- [ ] Add `POST /api/threads/:thread_id/read`
- [ ] Add `GET /api/me/notifications/summary`
- [ ] Extend `GET /api/threads` with `has_unseen_attention`
- [ ] Extend `GET /api/threads` with `last_attention_kind`

## Phase 2: Durable Enqueue And Outbox

- [ ] Assistant completion updates thread attention summary
- [ ] Assistant completion inserts outbox row atomically
- [ ] Outbox uses stable dedupe key
- [ ] No outbox row is created from draft SSE
- [ ] No outbox row is created from tool results
- [ ] Failure-only `final` path still does not notify

## Phase 3: APNs Delivery Worker

- [ ] Add `service/src/notifications/` implementation area
- [ ] Add provider abstraction
- [ ] Add APNs implementation
- [ ] Add outbox claim loop
- [ ] Add already-seen suppression
- [ ] Add invalid-token endpoint invalidation
- [ ] Add retry/backoff behavior
- [ ] Add delivery observability

## Phase 4: Client Read State And Badge Adoption

- [ ] Publish mobile registration contract
- [ ] Publish read-acknowledgment contract
- [ ] Badge count is sourced from `GET /api/me/notifications/summary`
- [ ] Thread unread indicators are sourced from `GET /api/threads`
- [ ] Decide whether reference web adopts read acknowledgments in this tranche

## Phase 5: Human-Input Attention Trigger

- [ ] Human-input prompt feature has a durable transcript artifact
- [ ] Prompt artifact updates thread attention summary
- [ ] Prompt artifact inserts `human_input_requested` outbox row
- [ ] Endpoint preferences gate prompt notifications
- [ ] Badge semantics remain thread-based

## Docs / Specs

- [ ] Update `service/src/db/db.spec.md`
- [ ] Update `service/src/routes/routes.spec.md`
- [ ] Update `service/src/agent/agent.spec.md`
- [ ] Update `service/src/src.spec.md`
- [ ] Update `service/service.spec.md`
- [ ] Update `docs/proto.md`
- [ ] Update `bud.spec.md`
