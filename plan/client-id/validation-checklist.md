# Message Client ID Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Schema And Transcript Foundation

### Storage And Backfill

- [x] new message rows persist `client_id`
- [x] historical rows are backfilled with `client_id`
- [x] no rows remain with null `client_id` before final schema tightening
- [ ] uniqueness enforcement works as intended
- [x] the final Stage B `db:push` has been applied successfully to the remote staging database

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

- [-] rollout fallback using `client_id ?? message_id` has been removed after staging alignment and final rollout completion

## Docs / Spec Alignment

- [x] `service/src/db/db.spec.md` updated
- [x] `service/src/routes/routes.spec.md` updated
- [x] `service/src/agent/agent.spec.md` updated
- [x] `service/src/runtime/runtime.spec.md` updated if needed
- [x] `web/src/lib/lib.spec.md` updated
- [x] `web/src/routes/$budId/budId.spec.md` updated
- [x] `docs/proto.md` updated
- [x] relevant reference handoff docs updated
- [x] `bud.spec.md` updated

## Notes

- This checklist validates stable message identity, not a broader request-idempotency architecture.
- The backfill success note for phase 1 came from the completed `pnpm db:backfill:message-client-ids` run after the schema rollout landed.
- For remote staging, the final schema hardening required the expected two-pass rollout: Stage A deploy, staging backfill run, then a manual Stage B `db:push` because deploy-time `db:migrate` did not apply the schema-only client-id changes.
- On 2026-03-30, `pnpm db:push` passed in `service/` after the Stage B schema change (`message.client_id NOT NULL` plus the final unique index) landed locally.
- On 2026-03-30, `pnpm build` passed in `service/` after the phase 3 runtime/SSE `client_id` changes landed.
- On 2026-03-30, `node --import tsx --test src/runtime/agent-runtime-state.test.ts` passed, including the new snapshot assertions for `pending_tool.client_id` and `draft_assistant.client_id`.
- On 2026-03-30, `pnpm build` passed in `web/` after the phase 4 `client_id`-first optimistic/runtime reconciliation changes landed.
- On 2026-03-31, staging accepted new messages with persisted `client_id` values after the manual Stage B `db:push`.
- If a later tranche adds `attempt_id` or full replay-safe send semantics, add a separate validation pass rather than stretching this checklist.
