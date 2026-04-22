# push-notifications

Implementation planning documents for push notifications on unseen thread activity that requires the user's attention.

## Purpose

This folder turns the design review in [../../design/mobile-push-notifications-for-unseen-agent-messages.md](../../design/mobile-push-notifications-for-unseen-agent-messages.md) into an actionable phased implementation plan.

The current plan assumes:

- notification truth must come from durable thread state, not draft SSE
- unseen is a server-owned concept derived from per-user read state
- badge count semantics are fixed to `unseen threads with attention-worthy output`
- the current iOS app ships first, but backend abstractions must also fit future Android clients
- provider delivery must be decoupled from transcript persistence through an outbox
- future human-input prompts such as `askUserQuestion` should reuse the same attention and delivery pipeline once they become durable transcript artifacts

## Files

### `implementation-spec.md`

Parent implementation spec for the push-notifications work.

Documents:

- the current architecture constraints
- the chosen schema and route direction
- fixed decisions, sequencing, risks, and definition of done

### `phase-1-schema-and-owned-routes.md`

Foundation phase covering:

- schema additions for push endpoints, thread read state, and thread attention summary fields
- owned registration and read-ack routes
- baseline unread/badge query surfaces

### `phase-2-durable-enqueue-and-outbox.md`

Durable enqueue phase covering:

- atomic assistant-completion enqueue
- thread attention summary updates
- outbox schema and claim model
- suppression and dedupe rules

### `phase-3-apns-delivery-worker.md`

Delivery phase covering:

- APNs provider abstraction
- in-process worker loop
- retry, invalidation, collapse, and observability rules

### `phase-4-client-read-state-and-badge-adoption.md`

Client and read-state adoption phase covering:

- mobile endpoint registration and read acknowledgments
- optional reference-web read-state adoption
- thread list unread indicators and aggregate badge semantics

### `phase-5-human-input-attention-trigger.md`

Follow-on phase covering:

- durable human-input request artifacts
- reuse of the same attention summary and outbox pipeline
- explicit `askUserQuestion` notification behavior

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and contract validation checklist for the plan.

## Dependencies

- [../../design/mobile-push-notifications-for-unseen-agent-messages.md](../../design/mobile-push-notifications-for-unseen-agent-messages.md) - design review and proposed backend shape
- [../../plan/mobile-push-notifications-for-unseen-agent-messages.md](../../plan/mobile-push-notifications-for-unseen-agent-messages.md) - initial scoped planning note
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) - runtime/bootstrap contract that read-state updates will sit on top of
- [../../design/mobile-chat-thread-first-backend-contract.md](../../design/mobile-chat-thread-first-backend-contract.md) - mobile route-family baseline
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The first pass assumes a single-thread owner receives attention notifications. Shared-thread fan-out is intentionally deferred until a collaboration design exists.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
