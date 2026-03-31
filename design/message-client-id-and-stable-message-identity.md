# Design: Message Client IDs And Stable Message Identity

Status: Draft

Audience: Backend, web platform, iOS

Last updated: 2026-03-30

## 1. Goal

Add a stable `client_id` to Bud messages so a message can be identified before its database row exists, while keeping the existing `message_id` field unchanged.

This design is intentionally additive:

- keep `message_id` as the persisted row identifier
- add `client_id` as the stable public/UI/correlation identifier
- stream `client_id` before persistence for assistant and tool messages
- let first-party clients send `client_id` for user messages so optimistic UI no longer mutates identity after the POST completes

## 2. Review Summary

The reference recommendation in [`reference/client-id-recommendation.md`](../reference/client-id-recommendation.md) matches a real weakness in Bud’s current message flow.

Current behavior, confirmed in [`review/message-streaming-and-message-ids-review.md`](../review/message-streaming-and-message-ids-review.md):

- user messages are persisted immediately and return `message_id` from `POST /api/threads/:threadId/messages`
- assistant draft text streams first and only later becomes a persisted `message` row
- tool calls show a synthetic pending row first and only later become a persisted `message` row
- the web client currently mutates UI identity:
  - `temp_*` -> `message_id` for user messages
  - `assistant_draft:<turn_id>` -> canonical persisted assistant row
  - `tool_call:<call_id>` -> canonical persisted tool row

Bud already has good correlation primitives:

- `turn_id` for one agent turn
- `call_id` for one tool call
- `message_id` for the persisted transcript row

What is missing is one stable message identity that exists both:

- before persistence
- after persistence

That is the gap this design closes.

## 3. Problem Statement

Today, Bud uses the persisted row ID as the only message-shaped identifier that survives into the transcript API. That creates three concrete problems:

1. UI identity mutates during normal healthy flows.
2. Mid-turn bootstrap uses synthetic derived IDs (`turn_id`, `call_id`) instead of the future canonical message identity.
3. Retries, reloads, and cross-client reconciliation are harder than they need to be because there is no durable public identity shared by optimistic state and persisted state.

The core design principle from the reference doc is correct:

- database identity answers “which row is this?”
- public/UI identity answers “which on-screen message is this?”

Those are different jobs.

## 4. Decision

Bud should introduce a top-level `client_id` on every message.

`client_id` will be:

- a UUIDv7 string
- stable for the full lifetime of one logical message
- present in the database row
- returned by `GET /messages`
- echoed by write responses
- included in streamed assistant/tool runtime and SSE payloads before persistence completes

`message_id` will remain:

- the existing persisted row identifier
- the message lookup/debug/admin identifier
- the cursor tie-breaker in transcript pagination
- the database primary key exposed today

Short version:

- `client_id` becomes the stable message identity used by UI state and stream reconciliation
- `message_id` remains the persisted transcript row identifier

## 5. ID Taxonomy

After this change, Bud will have four message-adjacent identifiers with different jobs:

| Field | Scope | Purpose |
|------|-------|---------|
| `client_id` | one logical message | stable public/UI/correlation identity |
| `message_id` | one persisted row | database-backed transcript identity |
| `turn_id` | one agent turn | group assistant/tool activity in a single turn |
| `call_id` | one tool call | correlate tool request/result semantics |

Rules:

- `client_id` identifies the message object shown in the UI
- `message_id` identifies the stored row
- `turn_id` does not replace `client_id`
- `call_id` does not replace `client_id`

`turn_id` already fills most of the “attempt” role described in the reference doc, so this design does not introduce a separate `attempt_id` field yet.

## 6. Proposed Data Model

### 6.1 Message table

Add a new column to `message`:

```sql
client_id uuid
```

Target end state:

- `client_id` is `NOT NULL`
- `client_id` is globally unique in `message`
- `client_id` is generated in application code, not by the database

Recommended Drizzle shape:

```ts
clientId: uuid("client_id")
```

with a unique index such as:

```ts
uniqueIndex("message_client_id_idx").on(table.clientId)
```

### 6.2 Why keep `message_id`?

We should not replace `message_id` in this tranche.

Reasons:

- current pagination stability already depends on `(created_at, message_id)`
- current APIs, specs, and clients already understand `message_id`
- `message_id` is still useful for storage-oriented debugging and row lookup
- this user request explicitly asks for `client_id` in addition to the existing `id`/`message_id` field

So the recommended move is additive, not a full external-ID replacement.

## 7. Generation Rules

### 7.1 User messages

For first-party clients, the caller should generate `client_id` before sending the message.

Request:

```json
{
  "text": "Can you summarize the failing tests?",
  "client_id": "01961f0f-5e7a-7f31-9db8-8c4337df0ac4",
  "model": "gpt-4.1-mini",
  "reasoning_effort": "medium"
}
```

Server behavior:

- persist the row using the supplied `client_id`
- return both `message_id` and `client_id`

Compatibility behavior during rollout:

- if `client_id` is omitted, the service may generate one server-side
- old clients will still work, but only new clients get pre-send stable identity

### 7.2 Assistant messages

Assistant `client_id` should be generated by the service before the first assistant draft event for that message.

Recommended timing:

- allocate it lazily at the first assistant draft emission
- if the assistant resolves without any prior draft event, allocate it immediately before emitting `agent.message`

The same `client_id` must be used for:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `/agent/state.draft_assistant`
- the eventual persisted assistant row
- the final `agent.message`

### 7.3 Tool messages

A tool message `client_id` should be generated by the service before `agent.tool_call` is emitted.

The same `client_id` must be used for:

- `agent.tool_call`
- `/agent/state.pending_tool`
- the eventual persisted tool row
- `agent.tool_result`

### 7.4 System messages

System messages are not part of the current live agent SSE flow, but they should still get a normal `client_id` when inserted so transcript rows are consistent across all roles.

## 8. API Contract Changes

### 8.1 Transcript history

`GET /api/threads/:threadId/messages` should return:

```json
{
  "message_id": "uuid",
  "client_id": "uuidv7",
  "role": "assistant",
  "display_role": "Bud Agent",
  "content": "...",
  "metadata": {},
  "created_at": "2026-03-30T18:00:00.000Z"
}
```

Ordering and cursors should remain unchanged:

- keep cursor ordering on `(created_at, message_id)`
- do not switch pagination to `client_id`

`client_id` is for identity and reconciliation, not ordering.

### 8.2 Send message response

`POST /api/threads/:threadId/messages` should return:

```json
{
  "message_id": "uuid",
  "client_id": "uuidv7"
}
```

The user message `client_id` should round-trip exactly as provided by the first-party client.

### 8.3 Agent runtime snapshot

`GET /api/threads/:threadId/agent/state` should be extended so synthetic in-flight message overlays can use the eventual stable message identity.

Proposed shape:

```json
{
  "active": true,
  "turn_id": "01TURN...",
  "phase": "streaming_message",
  "can_cancel": true,
  "stream_cursor": "01CUR...",
  "pending_tool": {
    "client_id": "01961f11-4e6d-7cb8-bcb9-dcc279018c1e",
    "call_id": "call_123",
    "name": "terminal.run",
    "args": { "input": "git status\n" }
  },
  "draft_assistant": {
    "client_id": "01961f11-90ef-7f72-8d34-6d2108e48b25",
    "text": "Working through the repo...",
    "updated_at": "2026-03-30T18:00:03.000Z"
  },
  "updated_at": "2026-03-30T18:00:03.000Z"
}
```

This is the most important runtime-state change for the UI model. It lets a client opening mid-turn render the same stable `client_id` that later appears in the persisted transcript row.

### 8.4 Agent SSE events

Recommended additive changes:

#### Assistant draft events

```json
{ "turn_id":"01TURN...", "client_id":"01961f11-90ef-7f72-8d34-6d2108e48b25" }
{ "turn_id":"01TURN...", "client_id":"01961f11-90ef-7f72-8d34-6d2108e48b25", "delta":"Hel" }
{ "turn_id":"01TURN...", "client_id":"01961f11-90ef-7f72-8d34-6d2108e48b25", "text":"Hello" }
```

#### Assistant persisted event

```json
{
  "turn_id":"01TURN...",
  "client_id":"01961f11-90ef-7f72-8d34-6d2108e48b25",
  "message_id":"f7ea2c5f-1f67-4335-99da-dfa3fe0fc485",
  "text":"Hello",
  "message":{
    "message_id":"f7ea2c5f-1f67-4335-99da-dfa3fe0fc485",
    "client_id":"01961f11-90ef-7f72-8d34-6d2108e48b25",
    "role":"assistant",
    "display_role":"Bud Agent",
    "content":"Hello",
    "metadata":{"status":"succeeded"},
    "created_at":"2026-03-30T18:00:05.000Z"
  }
}
```

#### Tool events

```json
{
  "turn_id":"01TURN...",
  "client_id":"01961f11-4e6d-7cb8-bcb9-dcc279018c1e",
  "call_id":"call_123",
  "name":"terminal.run",
  "args":{"input":"git status\n"}
}
```

```json
{
  "turn_id":"01TURN...",
  "client_id":"01961f11-4e6d-7cb8-bcb9-dcc279018c1e",
  "call_id":"call_123",
  "message_id":"08f5dd9d-279c-4a9b-9d86-fbfd1f5935a8",
  "name":"terminal.run",
  "summary":"Ran git status",
  "message":{
    "message_id":"08f5dd9d-279c-4a9b-9d86-fbfd1f5935a8",
    "client_id":"01961f11-4e6d-7cb8-bcb9-dcc279018c1e",
    "role":"tool",
    "display_role":"Tool",
    "content":"{\"tool\":\"terminal.run\",...}",
    "metadata":{"tool":"terminal.run","call_id":"call_123"},
    "created_at":"2026-03-30T18:00:04.000Z"
  }
}
```

### 8.5 `final`

`final` does not need to become the identity carrier.

Under the current design:

- assistant identity is carried by assistant draft events plus `agent.message`
- tool identity is carried by `agent.tool_call` plus `agent.tool_result`

So `final` can stay completion-oriented.

## 9. Client Model Changes

### 9.1 Rendering identity

Web and iOS should key rendered transcript items by `client_id`, not by `message_id`.

Current anti-pattern:

- render `temp_*`
- later replace with `message_id`

Target model:

- render the optimistic or streaming row with its stable `client_id`
- later attach or update `message_id` on that same in-memory object

### 9.2 Existing thread send flow

Current web flow:

- generate `temp_*`
- POST message
- replace temp with `message_id`

Target flow:

1. client generates UUIDv7 `client_id`
2. UI appends optimistic row keyed by `client_id`
3. request sends `client_id`
4. response attaches `message_id` to that same row
5. no identity mutation occurs

### 9.3 Assistant draft flow

Current web flow:

- build synthetic ID from `assistant_draft:<turn_id>`
- later replace with persisted `message_id`

Target flow:

1. `agent.message_start` arrives with `client_id`
2. client creates one draft row keyed by `client_id`
3. `agent.message_delta` and `agent.message_done` merge into that same object
4. `agent.message` attaches `message_id` and canonical persisted fields to that same object

### 9.4 Tool flow

Current web flow:

- build synthetic ID from `tool_call:<call_id>`
- later replace with persisted `message_id`

Target flow:

1. `agent.tool_call` arrives with `client_id`
2. client creates one pending tool row keyed by `client_id`
3. `agent.tool_result` attaches `message_id` and canonical persisted fields to that same object

### 9.5 New-thread navigation

This proposal also improves the `/new` route:

- the first user message can carry a client-generated `client_id`
- the destination thread route can reconcile loader-fetched persisted rows against the same `client_id`
- the route no longer depends on consuming the returned `message_id` before navigation to preserve UI identity

## 10. Bud-Specific Recommendations

### 10.1 Keep `message_id` in the public API

Even after `client_id` is introduced, Bud should continue returning `message_id` publicly.

Reason:

- current docs, tooling, and debugging flows already use it
- transcript pagination already depends on it
- removing it would create more churn than value in this tranche

### 10.2 Treat `client_id` as first-class in serializers

Do not bury `client_id` inside `metadata`.

It should be:

- a real DB column
- a real top-level API field
- a real top-level SSE field where applicable

### 10.3 Keep `turn_id` and `call_id`

`client_id` should not replace Bud’s existing stream correlation fields.

We still need:

- `turn_id` to group one turn
- `call_id` to tie tool request/result semantics together

The correct model is additive:

- `turn_id` answers “which turn is this?”
- `call_id` answers “which tool call is this?”
- `client_id` answers “which message object is this?”

## 11. Rollout Plan

### Phase 1: Schema and serialization

1. Add nullable `client_id` to `message`.
2. Backfill existing rows.
3. Expose `client_id` in transcript serializers and canonical persisted message payloads.

### Phase 2: New writes

1. Generate `client_id` for all server-created assistant, tool, and system messages.
2. Accept optional `client_id` in `POST /api/threads/:threadId/messages`.
3. Echo `client_id` in the POST response.

### Phase 3: Runtime and SSE

1. Add `client_id` to `pending_tool` and `draft_assistant` in `/agent/state`.
2. Add `client_id` to assistant and tool SSE events.

### Phase 4: First-party client adoption

1. Web generates UUIDv7 `client_id` for user sends.
2. Web keys transcript items by `client_id`.
3. Web removes `temp_*`, `assistant_draft:<turn_id>`, and `tool_call:<call_id>` as primary message identities.
4. iOS adopts the same contract.

### Phase 5: Hardening

1. Make `client_id` non-null.
2. Enforce a full unique index.
3. Update docs/specs/fixtures across service, web, and mobile handoff docs.

## 12. Migration Notes

### 12.1 Backfill

Historical rows need a one-time backfill.

Recommended approach:

- use the same application-side UUIDv7 generator intended for runtime writes
- run a service-owned backfill script in batches
- then tighten the schema to `NOT NULL`

There is no need to preserve original historical creation order in the `client_id` itself because ordering remains based on `created_at` and `message_id`.

### 12.2 Dependency

The current repo does not already carry a UUIDv7 helper in the service/web packages.

Implementation will need one of:

- a small shared UUIDv7 dependency
- a shared local helper if the chosen runtime/tooling stack supports UUIDv7 directly

The important requirement is consistency across service and first-party clients.

## 13. Alternatives Considered

### 13.1 Replace `message_id` entirely

Rejected for this tranche.

- too much contract churn
- not required for the user’s stated goal
- would force cursor, docs, and client changes that are orthogonal to stable UI identity

### 13.2 Keep local temp IDs, but never replace them

Better than today for web-only rendering, but still weaker than a real persisted `client_id`.

It does not solve:

- `/agent/state` bootstrap identity
- cross-client convergence
- persisted transcript reconciliation by a shared public ID

### 13.3 Keep using `turn_id` and `call_id` as synthetic message IDs

Rejected.

Those fields are correlation fields, not message identities.

They should remain in the protocol, but they should not be overloaded as the message key shown in the transcript UI.

## 14. Decision Summary

Bud should add a UUIDv7 `client_id` to every message and treat it as the stable public/UI identity, while keeping `message_id` as the persisted row identifier.

This gives Bud the benefits from the reference recommendation without forcing a risky external-ID replacement:

- user messages can be optimistic without identity swaps
- assistant drafts can stream under the same identity they later persist with
- tool rows can do the same
- `/agent/state` can describe in-flight messages using their future stable transcript identity
- `message_id` remains available for cursors, storage, and debugging

That is the cleanest additive path from Bud’s current implementation to a stable streamed message identity model.
