# thread-title-generation

Implementation planning documents for generating short thread titles from the first user message and streaming title updates over the existing thread agent stream.

## Purpose

This folder turns the design work in [../../design/thread-title-generation-and-streaming.md](../../design/thread-title-generation-and-streaming.md) into an actionable implementation and validation plan.

The plan assumes:

- `thread.title` already exists and should be reused rather than redesigned
- the first pass generates titles from the first durable user message only
- Anthropic `claude-haiku-4-5` is the required title-generation model target as of 2026-04-08
- title generation should be non-blocking and best-effort
- successful persistence should emit `thread.title` on the existing thread agent stream
- web and mobile should treat the stream event as a normal thread metadata update
- canonical thread reads remain the durable fallback if the event is missed

## Files

### `implementation-spec.md`

Parent implementation spec for the thread-title work.

Documents:

- the current title-gap problem
- the fixed first-pass decisions
- phase sequencing
- risks and definition of done

### `phase-1-backend-title-generation-foundation.md`

Backend foundation phase covering:

- dedicated title-generation helper/service
- Anthropic Haiku invocation
- sanitization and validation
- first-message qualification
- conditional `thread.title` persistence
- `thread.title` stream emission

### `phase-2-thread-stream-event-and-reference-web-adoption.md`

Reference-web phase covering:

- mutable Bud-route thread summary state
- canonical thread-detail bootstrap on open
- live `thread.title` patching
- active workspace title rendering

### `phase-3-docs-mobile-handoff-and-validation.md`

Finalization phase covering:

- protocol/spec updates
- mobile handoff update
- manual validation
- explicit recording of deferred follow-up work

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/thread-title-generation-and-streaming.md](../../design/thread-title-generation-and-streaming.md) - main design review and recommended contract
- [../../design/mobile-thread-title-stream-handoff.md](../../design/mobile-thread-title-stream-handoff.md) - mobile-facing event contract draft
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) - existing thread-stream cursor and resume semantics this work builds on
- [../../design/mobile-chat-thread-first-backend-contract.md](../../design/mobile-chat-thread-first-backend-contract.md) - mobile thread-first API context
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder intentionally keeps scope to generated first-message titles only. Generic live `thread.updated` events, manual rename UX, title provenance metadata, and historical backfill remain out of scope for this pass.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
