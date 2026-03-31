# Phase 2: User Message Write Contract

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Let first-party clients send a stable `client_id` with user messages and receive that same `client_id` back from `POST /api/threads/:thread_id/messages`.

## Scope

In scope:

- request validation for `client_id`
- server-side fallback generation when `client_id` is omitted
- write response changes
- first-pass duplicate `client_id` handling for user messages
- route and protocol doc updates for the user send contract

Out of scope:

- assistant/tool runtime identity
- agent SSE contract changes
- full send replay/idempotency architecture

## Decisions For This Phase

- `client_id` remains optional on input during rollout.
- first-party clients should send `client_id` proactively.
- if omitted, the service generates one server-side.
- the response becomes:

```json
{
  "message_id": "uuid",
  "client_id": "uuidv7"
}
```

## Duplicate Handling

This phase should add narrow first-pass duplicate handling, not a full idempotency system.

Recommended behavior:

- if the same authenticated user posts the same `client_id` to the same thread and a matching user message row already exists:
  - return the existing `{ message_id, client_id }`
  - do not insert a second row
  - do not start a second agent turn

This covers the most valuable case:

- duplicate browser submits
- quick retries after an ambiguous network result

Non-goal for this tranche:

- guaranteeing recovery when the original request inserted the user row but failed before agent dispatch in a way the server cannot distinguish later

That limitation should be documented rather than hidden.

## Implementation Steps

### 1. Request schema

Extend `CreateMessageSchema` with:

- `client_id?: string`

Validate it as a UUID.

### 2. Write path

- resolve the effective `client_id`
- check for an existing user message in the same owned thread with that `client_id`
- if found, short-circuit with the existing identifiers
- otherwise insert the user message row with `client_id`

### 3. Response shape

Always respond with:

```json
{
  "message_id": "...",
  "client_id": "..."
}
```

Fresh insert:

- `201`

Duplicate match:

- `200`

### 4. Metadata and ownership

- do not bury `client_id` in `metadata`
- continue stamping ownership exactly as today
- continue recording thread metadata exactly as today

## Acceptance Criteria

- [ ] `POST /api/threads/:thread_id/messages` accepts optional `client_id`.
- [ ] missing `client_id` values are generated server-side.
- [ ] inserted user rows persist `client_id`.
- [ ] response echoes both `message_id` and `client_id`.
- [ ] duplicate `client_id` requests do not create duplicate user rows.
- [ ] duplicate `client_id` requests do not launch duplicate agent turns.
- [ ] route specs and protocol docs are updated.

## Risks / Notes

- This phase improves duplicate suppression, not full send replay semantics.
- Keep duplicate matching scoped to owned thread + user message semantics to avoid surprising cross-role collisions.
