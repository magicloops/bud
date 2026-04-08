# Phase 3: Docs, Mobile Handoff, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Finalize the `thread.title` contract by updating protocol/spec docs, refreshing the mobile handoff, and validating the full first-message flow end to end.

By the end of this phase:

- protocol docs describe `thread.title`
- service/web specs describe the shipped implementation
- the mobile handoff reflects the final event contract
- manual validation proves the feature works in the first-thread flow and reconnect/convergence edge cases

## Current Problem

Without a documentation pass, this feature will be easy to misunderstand:

- the event lives on the agent stream but is not itself an `agent.*` event
- the trigger is initially "first user message" but clients should not hardcode that forever
- the canonical fallback remains normal thread reads, not a title-specific route

If the docs stay partial, web and mobile will implement different mental models.

## Scope

### In Scope

- `docs/proto.md` update for `thread.title`
- spec updates across touched service/web folders
- mobile handoff update
- manual validation notes

### Out Of Scope

- new reference fixtures outside what is needed to explain `thread.title`
- additional live thread-summary events beyond title

## Contract Direction

The final documented contract should say:

- `thread.title` is a thread-scoped metadata event emitted on `GET /api/threads/:thread_id/agent/stream`
- clients should treat it as an idempotent title patch keyed by `thread_id`
- clients should not assume fixed ordering relative to `agent.*` events
- canonical thread reads remain the durable fallback if the event is missed

## Implementation Tasks

### Task 1: Update protocol docs

Update `docs/proto.md` to add:

- `thread.title` to the thread agent-stream event list
- example payload
- client semantics:
  - thread metadata patch
  - event ordering is not guaranteed relative to `agent.*`
  - normal thread reads remain the fallback source of truth

### Task 2: Update touched specs

Update:

- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

The spec updates should reflect the shipped behavior, not the draft design language.

### Task 3: Refresh the mobile handoff

Update [../../design/mobile-thread-title-stream-handoff.md](../../design/mobile-thread-title-stream-handoff.md) so it reflects the actual shipped payload and client expectations.

Keep the handoff language simple:

- listen for `thread.title`
- patch local thread metadata by `thread_id`
- do not rely on a title-only follow-up fetch on the happy path
- use normal thread reads as durable fallback

### Task 4: Run manual validation

Capture results in [validation-checklist.md](./validation-checklist.md) for at least:

- first message on a new thread generates and streams a title
- `POST /messages` remains responsive while title generation happens in parallel
- thread list updates live in the web app
- active thread header updates live in the web app
- re-opening the thread later shows the durable title from canonical reads
- if title generation fails, the app remains stable on fallback labels

### Task 5: Record any deferred follow-up work explicitly

If implementation surfaces adjacent needs, record them explicitly rather than silently expanding scope.

Examples:

- generic `thread.updated`
- manual rename UX
- title provenance metadata
- historical title backfill

Use explicit follow-up docs or `SPEC:TODO` markers where appropriate.

## Validation Checklist

- [ ] `docs/proto.md` documents `thread.title`
- [ ] service specs document the backend sidecar and stream event
- [ ] web specs document canonical thread-detail bootstrap plus live title patching
- [ ] `bud.spec.md` indexes the new implementation-plan doc
- [ ] mobile handoff doc reflects the shipped payload and recovery rules
- [ ] a new thread's first message produces a visible title update in the web app
- [ ] the title remains visible after refresh/reopen through canonical thread reads
- [ ] failure-to-generate leaves the app stable on fallback labels
- [ ] any deferred follow-up scope is called out explicitly rather than implied

## Exit Criteria

This phase is done when the feature can be implemented, consumed, and handed off without relying on tribal knowledge: code, specs, protocol docs, and mobile guidance all describe the same `thread.title` contract.
