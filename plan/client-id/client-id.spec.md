# client-id

Implementation planning documents for adding stable message `client_id` values to Bud's transcript, runtime state, and agent stream contracts.

## Purpose

This folder turns the design in [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md) into an actionable implementation and validation plan.

The plan assumes:

- `message_id` remains the persisted row identifier
- `client_id` becomes the stable public/UI identity for messages
- `client_id` is additive and top-level, not buried in `metadata`
- transcript ordering and pagination continue to use `(created_at, message_id)`
- `/agent/state` and agent SSE need the same stable message identity that `/messages` exposes later
- first-party clients can adopt pre-send UUIDv7 generation for user messages
- the current architecture does not yet have a dedicated request/turn table for perfect send idempotency

## Files

### `implementation-spec.md`

Parent implementation spec for the `client_id` work.

Documents:

- the current message-identity problem
- the chosen additive `client_id` direction
- fixed rollout decisions
- phase sequencing
- risks and definition of done

### `phase-1-schema-and-transcript-foundation.md`

Backend foundation phase covering:

- `message.client_id` schema changes
- backfill strategy
- read-path serialization
- compatibility constraints during rollout

### `phase-2-user-message-write-contract.md`

User-send contract phase covering:

- `POST /api/threads/:thread_id/messages` request/response changes
- server-side UUIDv7 generation fallback
- first-pass duplicate `client_id` handling
- write-path and ownership semantics

### `phase-3-agent-runtime-and-stream-identity.md`

Assistant/tool runtime phase covering:

- stable `client_id` allocation before assistant/tool persistence
- `/agent/state` additions for `pending_tool` and `draft_assistant`
- agent SSE payload updates
- persistence alignment between in-flight and canonical transcript rows

### `phase-4-reference-web-adoption-and-handoff.md`

Reference-client and documentation phase covering:

- web adoption of `client_id` as render identity
- removal of temp/synthetic IDs as the primary UI identity model
- API type updates
- protocol/spec/reference doc alignment
- validation and rollout notes for iOS follow-on work

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md) - chosen design direction
- [../../review/message-streaming-and-message-ids-review.md](../../review/message-streaming-and-message-ids-review.md) - current implementation review
- [../../reference/client-id-recommendation.md](../../reference/client-id-recommendation.md) - external recommendation being adapted
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) - existing `/agent/state` and runtime-cursor contract this plan builds on
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder intentionally keeps `message_id` as the persisted/public row identifier and does not solve full cross-request send idempotency beyond first-pass duplicate `client_id` handling.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
