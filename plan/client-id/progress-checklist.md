# Message Client ID Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Schema And Transcript Foundation

### Storage

- [ ] `message.client_id` added to the schema.
- [ ] UUIDv7 generation helper added to the service.
- [ ] staged backfill plan implemented.
- [ ] historical rows backfilled.
- [ ] schema tightened to non-null and unique by end of rollout.

### Reads

- [ ] transcript serializers include `client_id`.
- [ ] persisted assistant/tool serializers include `client_id`.
- [ ] transcript ordering/cursor logic remains unchanged.

## Phase 2: User Message Write Contract

### Route Contract

- [ ] `POST /api/threads/:thread_id/messages` accepts optional `client_id`.
- [ ] missing `client_id` values are generated server-side.
- [ ] response returns `{ message_id, client_id }`.

### Duplicate Handling

- [ ] duplicate user `client_id` is detected within the same owned thread.
- [ ] duplicate send does not create a second user row.
- [ ] duplicate send does not start a second agent turn.
- [ ] first-pass idempotency limits are documented.

## Phase 3: Agent Runtime And Stream Identity

### Runtime State

- [ ] `/agent/state.pending_tool` includes `client_id`.
- [ ] `/agent/state.draft_assistant` includes `client_id`.

### Stream Contract

- [ ] `agent.message_start` includes `client_id`.
- [ ] `agent.message_delta` includes `client_id`.
- [ ] `agent.message_done` includes `client_id`.
- [ ] `agent.tool_call` includes `client_id`.
- [ ] `agent.tool_result` includes `client_id`.
- [ ] `agent.message` includes `client_id`.

### Persistence Alignment

- [ ] assistant `client_id` is allocated before the first streamed draft event.
- [ ] tool `client_id` is allocated before `agent.tool_call`.
- [ ] the persisted assistant row reuses the streamed assistant `client_id`.
- [ ] the persisted tool row reuses the streamed tool `client_id`.

## Phase 4: Reference Web Adoption And Handoff

### Web Adoption

- [ ] `web` uses the `uuid` package for UUIDv7 generation.
- [ ] optimistic user sends use browser-generated `client_id`.
- [ ] existing-thread message rendering keys by `client_id`.
- [ ] new-thread first message flow sends `client_id`.
- [ ] assistant/tool draft reconciliation keys by `client_id`.
- [ ] temp/synthetic IDs are no longer the primary render identity.

### Docs And Specs

- [ ] protocol docs updated.
- [ ] service specs updated.
- [ ] web specs updated.
- [ ] root spec updated.
- [ ] reference handoff docs/fixtures updated.

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Schema, backfill, and transcript serialization still use `message_id` only today |
| 2 | Not Started | User writes do not yet accept or echo `client_id` |
| 3 | Not Started | `/agent/state` and agent SSE do not yet expose pre-persistence message identity |
| 4 | Not Started | Web still keys optimistic and streaming message state off temp/synthetic IDs |

## Notes

- Keep this checklist current as implementation lands.
- If the rollout order changes, update this checklist and the phase docs together.
