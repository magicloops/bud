# Phase 4: Reference Web Adoption And Handoff

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Move the reference web client onto `client_id` as the primary message identity and update the surrounding docs/handoffs so web and iOS can share one stable contract.

## Scope

In scope:

- web dependency setup for UUIDv7 generation
- optimistic user send keyed by `client_id`
- assistant/tool runtime and SSE reconciliation keyed by `client_id`
- `/new` route first-message adoption
- protocol/spec/reference documentation updates

Out of scope:

- iOS implementation itself
- regenerate/attempt UX

## Decisions For This Phase

- use the `uuid` package in `web` for UUIDv7 generation
- key rendered/transient message state by `client_id`
- keep `message_id` attached on the object for debugging and cursor-oriented logic

## Implementation Steps

### 1. Web API types

Update `ApiMessage` and related SSE/runtime event typings to include `client_id`.

### 2. Existing-thread send

Replace the current optimistic user flow:

- remove `temp_*` as the primary identity model
- generate UUIDv7 `client_id` in the browser before POST
- append an optimistic row keyed by that `client_id`
- on success, attach `message_id` to the same object instead of swapping identity

### 3. Assistant/tool live reconciliation

Replace the current synthetic-ID model:

- do not key draft assistant rows by `assistant_draft:<turn_id>`
- do not key pending tool rows by `tool_call:<call_id>`
- key both by streamed/runtime `client_id`

The client should still use:

- `turn_id` for grouping turn-level cleanup
- `call_id` for tool semantics

but not as the message object identity.

### 4. New-thread flow

Update `/$budId/new` so the first message also carries a client-generated `client_id`.

### 5. Documentation and handoff

Update:

- `docs/proto.md`
- touched service specs
- touched web specs
- reference handoff docs/fixtures that describe transcript and agent stream payloads
- root spec catalog

## Acceptance Criteria

- [ ] web uses UUIDv7 `client_id` generation through `uuid`.
- [ ] optimistic user rows are keyed by `client_id`.
- [ ] assistant draft rows are keyed by `client_id`.
- [ ] pending tool rows are keyed by `client_id`.
- [ ] the `/new` route sends `client_id` on first message creation.
- [ ] docs/specs/reference handoffs describe `client_id` consistently.

## Risks / Notes

- Update both `/$budId/$threadId` and `/$budId/new` together so the app does not keep two message-identity models.
- `ChatTimeline` can continue to render by a single `id`, but that `id` should now come from `client_id`.
