# Message Client ID Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented in code
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Schema And Transcript Foundation

### Storage

- [x] `message.client_id` added to the schema.
- [x] UUIDv7 generation helper added to the service.
- [x] staged backfill plan implemented.
- [x] historical rows backfilled.
- [ ] schema tightened to non-null and unique by end of rollout.

### Reads

- [x] transcript serializers include `client_id`.
- [x] persisted assistant/tool serializers include `client_id`.
- [x] transcript ordering/cursor logic remains unchanged.

## Phase 2: User Message Write Contract

### Route Contract

- [x] `POST /api/threads/:thread_id/messages` accepts optional `client_id`.
- [x] missing `client_id` values are generated server-side.
- [x] response returns `{ message_id, client_id }`.

### Duplicate Handling

- [x] duplicate user `client_id` is detected within the same owned thread.
- [x] duplicate send does not create a second user row.
- [x] duplicate send does not start a second agent turn.
- [x] first-pass idempotency limits are documented.

## Phase 3: Agent Runtime And Stream Identity

### Runtime State

- [x] `/agent/state.pending_tool` includes `client_id`.
- [x] `/agent/state.draft_assistant` includes `client_id`.

### Stream Contract

- [x] `agent.message_start` includes `client_id`.
- [x] `agent.message_delta` includes `client_id`.
- [x] `agent.message_done` includes `client_id`.
- [x] `agent.tool_call` includes `client_id`.
- [x] `agent.tool_result` includes `client_id`.
- [x] `agent.message` includes `client_id`.

### Persistence Alignment

- [x] assistant `client_id` is allocated before the first streamed draft event.
- [x] tool `client_id` is allocated before `agent.tool_call`.
- [x] the persisted assistant row reuses the streamed assistant `client_id`.
- [x] the persisted tool row reuses the streamed tool `client_id`.

## Phase 4: Reference Web Adoption And Handoff

### Web Adoption

- [x] `web` uses the `uuid` package for UUIDv7 generation.
- [x] optimistic user sends use browser-generated `client_id`.
- [x] existing-thread message rendering keys by `client_id`.
- [x] new-thread first message flow sends `client_id`.
- [x] assistant/tool draft reconciliation keys by `client_id`.
- [x] temp/synthetic IDs are no longer the primary render identity.

### Docs And Specs

- [x] protocol docs updated.
- [x] service specs updated.
- [x] web specs updated.
- [x] root spec updated.
- [x] reference handoff docs/fixtures updated.

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Schema, backfill, persisted write stamping, and transcript serialization now carry `client_id` |
| 2 | Complete | User writes now accept/echo `client_id` and suppress duplicate same-thread retries |
| 3 | Complete | `/agent/state`, draft assistant SSE, tool SSE, and persisted assistant/tool rows now share one preallocated `client_id` |
| 4 | Complete | Web now generates UUIDv7 `client_id` values and uses them as the stable identity for optimistic, runtime, and canonical message reconciliation |

## Notes

- Keep this checklist current as implementation lands.
- If the rollout order changes, update this checklist and the phase docs together.
