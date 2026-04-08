# Phase 1: Backend Title Generation Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Add a dedicated backend-owned sidecar that can generate, sanitize, persist, and emit a short thread title from the first user message without blocking the main assistant turn.

By the end of this phase:

- the service can decide whether a thread qualifies for automatic title generation
- the service can call Anthropic Haiku with a fixed short-title prompt
- the generated title is sanitized and validated before persistence
- the title is written only if `thread.title` is still null
- a successful write emits `thread.title` on the existing thread agent stream

## Current Problem

Today the title field exists, but the normal chat flow never uses it:

- new thread creation does not send a title
- first message send updates preview/count/activity only
- there is no background title-generation path
- there is no thread metadata event on the thread agent stream

That leaves web and mobile on placeholder labels even though the data model already has a title column.

## Scope

### In Scope

- title-generation service/helper
- fixed Anthropic Haiku invocation path
- first-message qualification logic
- sanitization and validation
- conditional DB update
- `thread.title` stream emission
- backend tests for qualification, persistence, and event behavior
- backend spec updates for the new stream event and helper behavior

### Out Of Scope

- web consumption of the new event
- active workspace title rendering
- protocol/mobile handoff finalization
- manual rename UX

## Contract Direction

### Trigger rule

Automatic generation should run only when:

- the thread currently has no title
- the newly inserted message is a user message
- it is the first real user message for that thread
- the request was not short-circuited by duplicate `client_id` handling
- the assistant turn has already been queued successfully

### Model rule

Use Anthropic `claude-haiku-4-5` specifically.

For this phase:

- do not expose a new user-facing model selector
- do not add a fallback to `config.defaultModel`
- do not silently swap providers if Anthropic is missing

### Persistence rule

Write only through a conditional update:

- `WHERE thread_id = ? AND title IS NULL`

If the update does not return a row:

- emit nothing
- treat the attempt as a no-op

### Stream rule

On successful persistence, emit:

```json
{
  "event": "thread.title",
  "data": {
    "thread_id": "uuid",
    "title": "Short Title",
    "source": "generated_first_user_message",
    "updated_at": "ISO timestamp"
  }
}
```

The event should share the existing thread-stream cursor space managed by `AgentRuntimeStateManager`.

## Implementation Tasks

### Task 1: Add a dedicated title-generation helper/service

Add a small helper, likely under `service/src/agent/`, for example:

- `thread-title-service.ts`

Responsibilities:

- `generateTitleFromFirstMessage(text)`
- `sanitizeGeneratedTitle(text)`
- `validateGeneratedTitle(text)`
- `generateAndPersistThreadTitle({ threadId, ownerUserId, firstUserMessageText })`

Keep it separate from `AgentService` because:

- it is not part of the assistant tool loop
- it uses a different prompt/model contract
- it should remain best-effort and fire-and-forget

### Task 2: Define the fixed title-generation prompt and invocation config

Use the provider abstraction, but with a tight title-generation config:

- model: `claude-haiku-4-5`
- no tools
- reasoning disabled
- low output-token budget
- short timeout

Prompt contract:

- return title text only
- 3-5 words
- no quotes
- no markdown
- no explanation

Keep the model target and prompt local to the title-generation service in the first pass unless implementation proves a broader config surface is necessary.

### Task 3: Add sanitization and validation

Sanitize:

- trim
- collapse whitespace
- strip wrapping quotes/backticks
- strip trailing punctuation

Validate:

- non-empty
- single line
- short enough for UI usage
- reject obvious full-sentence or explanation-style outputs

Fail closed:

- if validation fails, log and leave `thread.title` unchanged

### Task 4: Add a small DB helper for conditional title persistence

Add a helper near `thread-metadata.ts` or beside it that:

- updates `thread.title` only when null
- returns the updated thread summary fields needed by callers

No schema change is expected in this plan because `thread.title` already exists.

### Task 5: Trigger the sidecar from `POST /api/threads/:thread_id/messages`

Update `service/src/routes/threads.ts` so that after:

1. user message insert succeeds
2. thread metadata preview/count/activity update succeeds
3. `agentService.startUserMessage(...)` succeeds

the route launches the title-generation sidecar without awaiting it.

Recommended qualification check:

- confirm there is exactly one user message for the thread after the insert
- confirm the thread still has no title before scheduling generation

If the request takes the duplicate-message `200 { message_id, client_id }` path:

- do not schedule title generation

### Task 6: Emit `thread.title` through the thread runtime stream

Use `AgentRuntimeStateManager` so the event:

- gets an SSE `id:`
- participates in the same bounded resume window as the rest of the thread stream
- can be replayed on short reconnect if still buffered

Do not add a second event bus for this first pass.

### Task 7: Add backend tests

Add coverage for:

- valid short-title generation path
- invalid output gets rejected
- missing Anthropic provider/model logs and skips
- first-message qualification logic
- duplicate `client_id` retry does not re-trigger generation
- conditional persistence only writes once
- `thread.title` emits only after successful write
- emitted event shape uses snake_case

### Task 8: Update backend specs

Update:

- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`

The spec updates should describe:

- the new title-generation sidecar
- the `thread.title` stream event
- the non-blocking trigger point on first user message

## Validation Checklist

- [ ] first qualifying user message schedules title generation
- [ ] title generation does not block the `POST /messages` response
- [ ] duplicate `client_id` retries do not schedule a second meaningful generation pass
- [ ] non-first user messages do not schedule generation
- [ ] invalid generated output is rejected and logged
- [ ] missing Anthropic provider/model skips generation and logs
- [ ] successful generation writes `thread.title`
- [ ] the conditional write prevents a second overwrite once title is set
- [ ] successful persistence emits `thread.title`
- [ ] emitted payload includes `thread_id`, `title`, `source`, and `updated_at`
- [ ] the stream event uses the same cursor space as the existing thread agent stream

## Exit Criteria

This phase is done when the backend can produce a durable thread title from the first user message and surface it on the thread stream without slowing down the main assistant turn.
