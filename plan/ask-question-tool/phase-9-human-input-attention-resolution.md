# Phase 9: Human-Input Attention Resolution

**Status**: Draft / Deferred
**Parent**: [implementation-spec.md](./implementation-spec.md)
**Depends On**:
- [phase-7-follow-up-supersession-service.md](./phase-7-follow-up-supersession-service.md)
- [phase-8-waiting-for-user-client-ux.md](./phase-8-waiting-for-user-client-ux.md)
**Design**: [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md)

---

## Objective

Define and later implement notification/read-attention behavior for `ask_user_questions` prompts now that follow-up messages can supersede them.

This phase is intentionally deferred from the first follow-up supersession slice. The immediate product problem is prompt closure and client recovery. Human-input attention needs a cleaner persistence anchor than the current message-watermark-only attention model provides.

## Current State

The notification system already supports:

- `push_endpoint.alerts_human_input_requested`
- `push_notification_outbox.kind = "human_input_requested"`
- generic notification copy for `human_input_requested`
- unread thread math based on thread attention watermarks

But the service does not yet enqueue `human_input_requested` when `ask_user_questions` becomes visible. The existing notifications spec tracks that as deferred.

The current attention model points at `thread.last_attention_message_id` and `thread.last_attention_message_created_at`. A pending prompt is a durable `agent_question_request` before it is necessarily represented by a final message row, so the attention anchor needs an explicit decision.

## Target Semantics

When a pending `ask_user_questions` prompt becomes visible to clients:

- mark the thread as needing human input
- enqueue a `human_input_requested` push outbox row when push is enabled
- dedupe by request id
- collapse by thread
- avoid leaking answer values because no answers exist yet

The following actions resolve that human-input attention:

- explicit answer
- explicit skip-all
- follow-up supersession
- explicit cancel
- expiry

Follow-up supersession specifically should:

- resolve the pending human-input attention immediately
- suppress unsent `human_input_requested` outbox rows for the request
- not create `assistant_completed` attention for the skipped closeout itself
- allow the new follow-up turn to create normal `assistant_completed` attention later if it writes a final assistant message

Explicit answer and explicit skip-all should:

- resolve the human-input attention
- allow the original continued turn to create normal `assistant_completed` attention later

## Design Choices To Resolve

### Option A: Prompt Message Anchor

Persist a visible prompt/tool message row when the question request becomes durable, then point attention at that message id.

Pros:

- fits the current message-watermark attention model
- read-state semantics stay simple
- push worker suppression already compares attention message ids

Cons:

- changes transcript timing because a pending prompt becomes a real message row before tool completion
- needs careful reconciliation with the final completed tool row
- may duplicate the existing synthetic pending-tool overlay if not designed carefully

### Option B: Request-Id Attention Anchor

Extend thread attention metadata or add a helper table so `human_input_requested` can point at `agent_question_request.question_request_id`.

Pros:

- models the pending prompt as its own durable resource
- avoids forcing pending prompts into final message history
- dedupe and suppression can key directly by request id

Cons:

- expands the attention model beyond message watermarks
- route list serialization and unread math need new logic
- push worker suppression needs request-aware checks

### Option C: Outbox-Only Human Input Push

Enqueue human-input push rows keyed by request id, but do not wire prompts into unread thread attention yet.

Pros:

- smaller than a full attention-model change
- still gets mobile notification value

Cons:

- thread list `has_unseen_attention` may not reflect pending input
- less coherent with current unread/badge semantics
- likely another intermediate contract to remove later

Recommendation: prefer Option B if we want pending prompts to be first-class durable attention. Use Option A only if we decide visible prompt rows should become canonical transcript rows at creation time.

## Implementation Scope

Once the anchor decision is made:

- stamp human-input attention when `createAgentQuestionRequest(...)` succeeds and the prompt is exposed
- enqueue `push_notification_outbox.kind = "human_input_requested"` with dedupe key scoped to request id
- suppress pending human-input outbox rows when the request is answered, skipped, superseded, canceled, or expired
- ensure follow-up supersession resolves human-input attention before the follow-up turn begins
- preserve newer `assistant_completed` attention if it happens after the prompt
- update notification summary and thread-list behavior if the attention model changes

## Tests

Add tests for:

- prompt creation stamps human-input attention
- push outbox row is enqueued with request-id dedupe
- explicit answer resolves human-input attention
- explicit skip-all resolves human-input attention
- follow-up supersession resolves human-input attention and suppresses unsent push
- explicit cancel resolves or cancels human-input attention according to the chosen anchor model
- newer assistant-completed attention is not cleared by stale prompt resolution
- notification summary and thread list reflect the chosen model

## Docs And Specs

Update when implementing:

- `service/src/notifications/notifications.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/db/db.spec.md` if schema or attention metadata changes
- `service/src/routes/threads/threads.spec.md`
- `docs/proto.md`
- `plan/push-notifications/phase-5-human-input-attention-trigger.md`
- `plan/ask-question-tool/progress-checklist.md`
- `plan/ask-question-tool/validation-checklist.md`

## Acceptance Criteria

- [ ] attention anchor decision is recorded
- [ ] pending prompt creates human-input attention
- [ ] human-input push enqueue is implemented or explicitly deferred again with rationale
- [ ] explicit answer/skip-all resolve human-input attention
- [ ] follow-up supersession resolves human-input attention and suppresses stale push
- [ ] skipped prompt closeout does not create assistant-completed attention
- [ ] newer assistant-completed attention is preserved
