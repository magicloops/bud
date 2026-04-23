# Plan: Mobile Push Notifications For Unseen Agent Messages

## Context
- Link to issue(s): mobile team request for push notifications when an agent turn needs the user's attention
- Related spec files:
  - [bud.spec.md](/Users/adam/bud/bud.spec.md)
  - [service/service.spec.md](/Users/adam/bud/service/service.spec.md)
  - [service/src/agent/agent.spec.md](/Users/adam/bud/service/src/agent/agent.spec.md)
  - [service/src/routes/routes.spec.md](/Users/adam/bud/service/src/routes/routes.spec.md)
  - [service/src/db/db.spec.md](/Users/adam/bud/service/src/db/db.spec.md)
  - [docs/proto.md](/Users/adam/bud/docs/proto.md)
  - [design/mobile-chat-thread-first-backend-contract.md](/Users/adam/bud/design/mobile-chat-thread-first-backend-contract.md)
  - [design/mobile-agent-stream-attach-semantics.md](/Users/adam/bud/design/mobile-agent-stream-attach-semantics.md)
  - [design/mobile-tool-call-timing-and-compaction.md](/Users/adam/bud/design/mobile-tool-call-timing-and-compaction.md)

## Objective
- Produce a design for cross-platform push notifications that alerts users when a thread has new unseen agent output that requires attention.
- Keep the initial product target aligned with the current iOS app while choosing backend abstractions that also fit future Android clients.
- Define the backend trigger point, unread/seen semantics, device-token ownership model, delivery architecture, and open questions before implementation starts.

## Design / Approach
- Review the existing durable transcript boundary instead of triggering from transient SSE deltas.
- Treat notification eligibility as a thread attention boundary:
  - final persisted assistant output
  - future explicit human-input requests
- Define unseen from a server-owned per-user thread read state rather than from implicit client attachment state.
- Register mobile push endpoints through authenticated `/api/me/*` style routes so bearer and cookie auth both work.
- Decouple provider transport from product platform:
  - APNs for the current iOS app
  - FCM-ready shape for future Android
- Use a DB-backed outbox so message persistence and notification enqueue can be made atomic, while delivery happens asynchronously and can later move to a separate worker.

## Spec Files to Update
- [ ] None in this design-only tranche
- [ ] Implementation follow-up should update:
  - [service/service.spec.md](/Users/adam/bud/service/service.spec.md)
  - [service/src/agent/agent.spec.md](/Users/adam/bud/service/src/agent/agent.spec.md)
  - [service/src/routes/routes.spec.md](/Users/adam/bud/service/src/routes/routes.spec.md)
  - [service/src/db/db.spec.md](/Users/adam/bud/service/src/db/db.spec.md)
  - [docs/proto.md](/Users/adam/bud/docs/proto.md)

## Impacted Contracts
- [ ] WSS protocol
- [ ] SSE events
- [x] DB schema
- [ ] Agent tools
- [x] Web UI
- [x] Mobile API surface

## Test Plan
- Validate the design against the current agent flow:
  - user message insert
  - tool result persistence
  - final assistant persistence
  - `/agent/state` plus `/agent/stream` recovery
- During implementation, cover:
  - read-state updates and unseen suppression
  - endpoint registration and invalidation
  - outbox enqueue idempotency
  - provider-delivery retry and collapse behavior

## Rollout
- Land the backend data model first:
  - push endpoints
  - per-thread read state
  - notification outbox
- Add registration/read-state routes.
- Wire enqueue at the durable assistant or future human-input boundary.
- Deliver through APNs first behind the generic push provider abstraction.
- Adopt the read-state route in mobile, then optionally in web to reduce cross-device false positives.
