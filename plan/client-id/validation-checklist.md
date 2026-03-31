# Message Client ID Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Schema And Transcript Foundation

### Storage And Backfill

- [ ] new message rows persist `client_id`
- [ ] historical rows are backfilled with `client_id`
- [ ] no rows remain with null `client_id` before final schema tightening
- [ ] uniqueness enforcement works as intended

### Read Contract

- [ ] `GET /api/threads/:thread_id/messages` returns `client_id` on every row
- [ ] transcript ordering still matches pre-change behavior
- [ ] message cursors still work across tied timestamps

## Phase 2: User Message Write Contract

### Fresh Send

- [ ] POST with caller-supplied `client_id` persists the same value
- [ ] POST without `client_id` returns a server-generated one
- [ ] response always includes both `message_id` and `client_id`

### Duplicate Handling

- [ ] retrying the same `client_id` does not create a duplicate user row
- [ ] retrying the same `client_id` does not launch a duplicate agent turn
- [ ] the documented first-pass idempotency limitation is still accurate after implementation

## Phase 3: Agent Runtime And Stream Identity

### Runtime Snapshot

- [ ] `/agent/state.pending_tool.client_id` is present while a tool is in flight
- [ ] `/agent/state.draft_assistant.client_id` is present while assistant draft text is in flight

### SSE Contract

- [ ] assistant draft events include stable `client_id`
- [ ] tool events include stable `client_id`
- [ ] `agent.message` includes both `message_id` and `client_id`
- [ ] `agent.tool_result` includes both `message_id` and `client_id`
- [ ] the later persisted transcript row matches the earlier streamed `client_id`

## Phase 4: Reference Web Adoption And Handoff

### Existing Thread

- [ ] optimistic user message identity does not change after POST resolves
- [ ] assistant draft identity does not change when the persisted assistant row arrives
- [ ] pending tool identity does not change when the persisted tool row arrives

### New Thread

- [ ] the first message send from `/$budId/new` includes `client_id`
- [ ] the destination thread route converges on the same `client_id`

### Compatibility

- [ ] rollout fallback using `client_id ?? message_id` works for historical or transitional data

## Docs / Spec Alignment

- [ ] `service/src/db/db.spec.md` updated
- [ ] `service/src/routes/routes.spec.md` updated
- [ ] `service/src/agent/agent.spec.md` updated
- [ ] `service/src/runtime/runtime.spec.md` updated if needed
- [ ] `web/src/lib/lib.spec.md` updated
- [ ] `web/src/routes/$budId/budId.spec.md` updated
- [ ] `docs/proto.md` updated
- [ ] relevant reference handoff docs updated
- [ ] `bud.spec.md` updated

## Notes

- This checklist validates stable message identity, not a broader request-idempotency architecture.
- If a later tranche adds `attempt_id` or full replay-safe send semantics, add a separate validation pass rather than stretching this checklist.
