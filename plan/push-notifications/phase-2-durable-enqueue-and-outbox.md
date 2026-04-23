# Phase 2: Durable Enqueue And Outbox

## Goal

Wire assistant completion into the durable attention model so that one successful assistant turn:

1. persists the assistant row
2. updates the thread attention summary
3. enqueues exactly one notification candidate

all as one durable unit.

## Scope

This phase covers assistant completion only.

It does not yet deliver through APNs. It only creates outbox work reliably.

## Implementation Tasks

### Task 1: Define outbox row shape and dedupe key

Recommended dedupe key format:

```text
user:<user_id>:thread:<thread_id>:message:<message_id>:kind:assistant_completed
```

This should guarantee:

- one durable assistant message creates at most one outbox row per user
- repeated retries or duplicate write-path invocations cannot multiply notifications

### Task 2: Update assistant persistence boundary

Modify `AgentTranscriptWriter.recordFinalAssistant(...)` and any nearby orchestration boundary so that assistant completion:

- inserts the assistant `message`
- updates thread metadata preview/activity as it already does
- updates `thread.last_attention_*`
- inserts one pending outbox row

Recommended implementation rule:

- these writes belong in one transaction

This is the core correctness boundary for the feature.

### Task 3: Keep failure semantics explicit

Do not enqueue from:

- draft assistant events
- `final { status: "failed" }` without a durable transcript artifact
- tool results

This phase should leave failure notifications out entirely.

### Task 4: Build suppression inputs

When the worker later claims an outbox row, it will need enough context to suppress correctly.

Ensure the outbox payload includes:

- `thread_id`
- `message_id`
- `client_id`
- `kind`
- `attention_kind`
- `bud_id`

This phase does not perform suppression yet, but it should persist enough data for the worker to do so deterministically.

### Task 5: Add thread-summary update helpers

If useful, create a dedicated helper next to `recordThreadMessageMetadata(...)` for thread attention updates.

Example responsibilities:

- set `last_attention_message_id`
- set `last_attention_message_created_at`
- set `last_attention_kind`

Keep this logic out of route handlers and localized near transcript persistence.

## Tests

Add or update tests to verify:

- assistant completion creates exactly one outbox row
- thread attention summary updates on assistant completion
- outbox rows are not created for tool results
- duplicate assistant persistence paths do not create duplicate outbox rows
- `GET /api/threads` and `GET /api/me/notifications/summary` reflect the new attention summary once the assistant row commits

## Docs / Specs

Update:

- `service/src/agent/agent.spec.md`
- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `docs/proto.md`

## Exit Criteria

- assistant completion is the one V1 attention trigger
- assistant persistence, thread attention update, and outbox enqueue are atomic
- unread-thread and badge-summary queries reflect assistant completions before APNs delivery exists
