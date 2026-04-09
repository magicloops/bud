# Implementation Spec: Thread Title Generation

**Status**: Draft
**Created**: 2026-04-08
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-backend-title-generation-foundation.md](./phase-1-backend-title-generation-foundation.md)
**Phase 2**: [phase-2-thread-stream-event-and-reference-web-adoption.md](./phase-2-thread-stream-event-and-reference-web-adoption.md)
**Phase 3**: [phase-3-docs-mobile-handoff-and-validation.md](./phase-3-docs-mobile-handoff-and-validation.md)
**Related Docs**:
- [../../design/thread-title-generation-and-streaming.md](../../design/thread-title-generation-and-streaming.md)
- [../../design/mobile-thread-title-stream-handoff.md](../../design/mobile-thread-title-stream-handoff.md)
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)
- [../../design/mobile-chat-thread-first-backend-contract.md](../../design/mobile-chat-thread-first-backend-contract.md)

---

## Context

Bud already has a durable `thread.title` field, but the product does not populate it during normal chat creation.

Current state:

- `POST /api/threads` accepts an optional `title`, but the web new-thread flow does not send one.
- `POST /api/threads/:thread_id/messages` persists the first user message and starts the assistant turn, but it never updates `thread.title`.
- `GET /api/threads` and `GET /api/threads/:thread_id` already return `title`.
- the web thread panel falls back to `Untitled thread`
- the mobile app, in a separate repo, currently falls back to `New thread`

The new design direction is:

1. generate a short title from the first user message
2. use Anthropic's current Haiku line
3. do the work in parallel with the first assistant response rather than blocking it
4. persist the title onto `thread.title`
5. stream a thread metadata event so web and mobile can update without a title-specific follow-up request

As of 2026-04-08, Anthropic's current Haiku line is `Claude Haiku 4.5`, with the alias `claude-haiku-4-5`. This plan treats that alias as the fixed title-generation model target.

## Objective

Implement short thread-title generation for the first user message, with one backend/web/mobile-facing contract:

- title generation is non-blocking and best-effort
- persistence is durable and idempotent
- `GET /api/threads/:thread_id/agent/stream` can emit `thread.title`
- clients treat `thread.title` as a normal thread metadata update
- the web reference client actually uses the update rather than staying stuck on loader-seeded fallback labels

## Why This Matters

This is a small feature, but it cuts across a few existing boundaries:

- backend message write path
- provider selection outside the main assistant turn
- thread-scoped live stream semantics
- loader-vs-live-state ownership in the web Bud/thread shell
- mobile handoff expectations for thread metadata

If we only persist the DB title and do not stream it, the first-response experience stays stale.

If we only stream it and do not persist it safely, reconnect and list reads drift.

If we stream it but leave the web thread list as immutable loader data, the product still looks broken in the reference client.

## Fixed Decisions

These decisions are fixed for this plan:

- Keep using the existing `thread.title` column. No schema migration is planned for the first pass.
- Generate the title from the first durable user message only.
- Use Anthropic `claude-haiku-4-5` specifically for title generation.
- Do not expose title-generation model choice through `/api/models`.
- Do not block `POST /api/threads/:thread_id/messages` or the main assistant turn on title generation.
- Trigger title generation only after the first user message write succeeds and the assistant turn has been queued successfully.
- Treat title generation as best-effort. Failure should log and exit quietly.
- Persist with a conditional `title IS NULL` update so duplicate triggers or future manual edits do not get overwritten.
- Emit a dedicated `thread.title` event on the existing thread agent stream instead of adding a title-only route.
- Keep the event additive. Clients must tolerate it on any stream attach, even though the first shipped trigger is the first user message.
- Do not silently fall back to another model/provider when Anthropic Haiku is unavailable.
- Do not add bookkeeping columns such as `title_source` or `title_generated_at` in this pass.

## Success Criteria

- [ ] backend title generation is implemented as a dedicated sidecar, not as part of the tool-calling agent loop
- [ ] the title-generation model target is fixed to `claude-haiku-4-5`
- [ ] the title prompt returns plain text only, with backend sanitization and validation before persistence
- [ ] only the first real user message on an untitled thread qualifies
- [ ] duplicate `client_id` retries do not schedule a second meaningful title-generation attempt
- [ ] `POST /api/threads/:thread_id/messages` remains non-blocking with respect to title generation
- [ ] the DB update is conditional and idempotent
- [ ] `thread.title` is emitted only after a successful title write
- [ ] `thread.title` participates in the existing thread-stream cursor space so reconnect behavior remains coherent
- [ ] the reference web client updates the Bud thread panel live when a title arrives
- [ ] the reference web client uses canonical thread detail on thread open so it still converges if the stream event was missed
- [ ] the reference web client shows the current thread title in the active workspace instead of a static placeholder
- [ ] docs, specs, and mobile handoff text all describe the same `thread.title` contract

## Non-Goals

- manual thread renaming UX
- generic `thread.updated` live sync for all thread summary fields
- retroactive title backfill for old untitled threads
- new schema for title provenance
- mobile-repo implementation work itself

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-backend-title-generation-foundation.md](./phase-1-backend-title-generation-foundation.md) | Urgent | Service can generate, sanitize, persist, and emit a thread title without blocking the assistant turn |
| 2 | [phase-2-thread-stream-event-and-reference-web-adoption.md](./phase-2-thread-stream-event-and-reference-web-adoption.md) | Urgent | Reference web can ingest `thread.title`, keep the thread list live, and render the active title from canonical + streamed state |
| 3 | [phase-3-docs-mobile-handoff-and-validation.md](./phase-3-docs-mobile-handoff-and-validation.md) | High | Protocol/spec docs, mobile handoff, tests, and manual validation all align with the shipped contract |

## Sequencing Notes

- Do not ship the backend event without reference-web adoption. Otherwise the feature still appears broken in the product we use as the contract reference.
- Do not make the web depend only on the new stream event. Thread-open canonical reads must still converge if the event arrived before attach or was missed.
- Do not add a new thread-title endpoint unless implementation proves the existing stream cannot carry this cleanly.
- Keep the first pass scoped to `thread.title`. If live thread-preview/count/activity sync is desired later, treat that as a separate reviewed contract expansion.
- Keep the no-fallback-to-other-model rule explicit. If Anthropic Haiku is unavailable, skip generation rather than silently changing the product requirement.

## Expected Files And Areas

### Service

- `service/src/routes/threads.ts`
- `service/src/agent/` for a new title-generation helper/service
- `service/src/db/thread-metadata.ts` or a small new DB helper beside it
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`

### Web

- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/new.tsx` if thread bootstrap comments or navigation assumptions change
- `web/src/components/workbench/workspace-top-bar.tsx`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`

### Docs

- `docs/proto.md`
- `design/thread-title-generation-and-streaming.md` if implementation decisions diverge from the draft
- `design/mobile-thread-title-stream-handoff.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Title generation adds latency to the message send path | Low | High | Fire-and-forget only after the assistant turn is queued; do not await the result |
| The "first user message" gate is too loose and generates twice under retry or concurrency | Medium | Medium | Use duplicate-send suppression plus a first-user-message check and conditional `title IS NULL` persistence |
| The model returns junk, quotes, or a sentence instead of a short title | Medium | Medium | Sanitize, validate, fail closed, and log |
| Anthropic Haiku is unavailable in some environments | Medium | Medium | Skip generation and log; do not silently switch providers |
| `thread.title` is emitted but the web thread list still does not update | High | High | Move the Bud route to mutable thread summary state in the same rollout |
| The event arrives before stream attach and the UI still misses it | Medium | Medium | Also load canonical thread detail on thread open and upsert that into parent state |
| Mixing `thread.title` into the existing cursor space causes resume confusion | Low | Medium | Keep the event in the same cursor space intentionally and document it as a normal thread-stream event |
| Docs drift from the shipped event name or payload | Medium | Medium | Update protocol/spec/handoff docs in the final phase, not as optional cleanup |

## Rollout Strategy

1. Add backend title-generation foundation plus conditional persistence and `thread.title` emission.
2. Update the reference web client to consume canonical thread detail and the new stream event.
3. Update protocol/spec/mobile handoff docs and run manual validation.
4. Only after validation, treat `thread.title` as the stable mobile-facing contract for title updates.

## Definition Of Done

- [ ] first-message title generation is implemented and non-blocking
- [ ] the service emits `thread.title` on the thread agent stream
- [ ] web thread list updates live from the new event
- [ ] web active thread header renders the resolved title
- [ ] web still converges correctly when the event is missed before attach
- [ ] mobile handoff doc describes the shipped event and client expectations
- [ ] protocol/spec files are updated alongside the implementation
- [ ] validation notes are captured in [validation-checklist.md](./validation-checklist.md)
