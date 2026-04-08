# Design: Thread Title Generation And Streaming

Status: Draft

Audience: Backend, web platform, iOS

Last updated: 2026-04-08

## 1. Goal

Generate a short conversation title for a thread from the first user message, using Anthropic's latest Haiku model, without blocking the assistant turn.

The title should:

- be generated from the first user message only
- be 3-5 words
- be persisted onto `thread.title`
- arrive on the existing thread agent stream so clients can update live without a second title-specific fetch
- be treated by clients as a normal thread metadata update, even though the first shipped trigger is "first user message"

## 2. Current Implementation Review

### 2.1 Service already has a durable thread title field, but it is write-once at create time

The current service already exposes `thread.title` end to end:

- [`service/src/db/schema.ts`](../service/src/db/schema.ts) stores `thread.title`
- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts) accepts optional `title` on `POST /api/threads`
- the same route family returns `title` on:
  - `GET /api/threads`
  - `GET /api/threads/:thread_id`

Current behavior:

- `POST /api/threads` writes `title: body.title ?? null`
- `POST /api/threads/:thread_id/messages` does not update `thread.title`
- [`service/src/db/thread-metadata.ts`](../service/src/db/thread-metadata.ts) only updates:
  - `last_activity_at`
  - `last_message_preview`
  - `message_count`

So the field exists, but the product never populates it for normal chat creation.

### 2.2 The first-message flow is already split cleanly enough for a title-generation sidecar

The current first-message flow is:

1. web `/$budId/new` calls `POST /api/threads`
2. web calls `POST /api/threads/:thread_id/messages`
3. the service inserts the user message
4. the service updates thread metadata via `recordThreadMessageMetadata(...)`
5. the service starts the agent turn via `agentService.startUserMessage(...)`
6. the web route navigates into `/$budId/$threadId`
7. the thread view loads `/messages` and `/agent/state`
8. the thread view attaches `/agent/stream?after=<stream_cursor>`

This is a good place to hang a non-blocking sidecar:

- the user message is already durable
- the title input text is already available
- the assistant turn is already kicked off asynchronously
- the title work does not need to block `POST /messages`

### 2.3 The existing agent stream is the right transport for this first pass

The current thread stream already has the right properties:

- it is thread-scoped: `GET /api/threads/:thread_id/agent/stream`
- it is already the primary live transport for the first assistant turn
- it uses the bounded replay machinery in [`service/src/runtime/agent-runtime-state.ts`](../service/src/runtime/agent-runtime-state.ts)
- web already keeps this stream attached across the first turn and later turns

That means a title update can ride the same stream instead of requiring:

- a second polling route
- a title-only SSE route
- a forced post-send refetch just to learn the generated name

### 2.4 The current web data flow will not automatically reflect a streamed title update

This is the main frontend constraint.

Today:

- [`web/src/routes/$budId.tsx`](../web/src/routes/%24budId.tsx) seeds the thread list from loader data
- that thread list is converted with `useMemo(...)` and treated as immutable route data
- [`web/src/components/workbench/thread-panel.tsx`](../web/src/components/workbench/thread-panel.tsx) renders `thread.title ?? 'Untitled thread'`
- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/%24budId/%24threadId.tsx) listens to the thread agent stream, but only owns local message/runtime state

Direct consequence:

- even if the service emits a title event tomorrow, the current active thread view has nowhere to patch the parent thread list row
- the main thread workspace header also does not currently display the thread title; it renders static labels:
  - `New Thread` in [`web/src/routes/$budId/new.tsx`](../web/src/routes/%24budId/new.tsx)
  - `Thread` in [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/%24budId/%24threadId.tsx)

So the service-side event is necessary, but not sufficient, for the web UI.

## 3. Requirements

### 3.1 Product requirements

- Generate a title from the first user message only.
- Use Anthropic's latest Haiku model.
- Keep titles short, ideally 3-5 words.
- Do not block the assistant turn or the message POST response on title generation.
- Persist the generated title to the database.
- Stream the title update during the first assistant response flow when possible.

### 3.2 Client contract requirements

- Clients should treat title updates as normal thread metadata changes.
- Clients should not need a title-specific follow-up request on the happy path.
- Clients should tolerate the event arriving:
  - before `agent.message_start`
  - between assistant draft events
  - after `final`
- If the event is missed, the canonical recovery surface remains the normal thread reads:
  - `GET /api/threads`
  - `GET /api/threads/:thread_id`

### 3.3 Backend constraints

- Keep the implementation thread-owner scoped.
- Avoid starting more than one meaningful DB title write for the same thread.
- Do not silently switch to a different provider/model if the Anthropic Haiku model is unavailable.

## 4. Model Choice

As of 2026-04-08, Anthropic's current Haiku line is `Claude Haiku 4.5`.

Useful identifiers:

- public alias: `claude-haiku-4-5`
- current dated model already present in this repo's registry: `claude-haiku-4-5-20251001`

Relevant sources:

- [Anthropic model system cards](https://www.anthropic.com/system-cards)
- [Anthropic model overview](https://docs.anthropic.com/ru/docs/about-claude/models/overview)

Recommendation:

- use the alias `claude-haiku-4-5` in the title-generation feature config
- let the existing provider registry resolve it to the dated model ID
- keep this model fixed and not user-selectable from `/api/models`

## 5. Proposed Design

### 5.1 Add a dedicated title-generation sidecar service

Add a small backend service, for example `ThreadTitleService`, responsible for:

- deciding whether a thread qualifies for automatic generation
- calling Anthropic Haiku with a short prompt
- sanitizing and validating the returned title
- conditionally updating `thread.title`
- emitting a thread-title stream event when the DB write succeeds

This should be separate from `AgentService` because:

- it is not part of the agent tool loop
- it has a different model, latency target, and prompt
- it should remain fire-and-forget and low-risk

### 5.2 Trigger point

Trigger automatic title generation from `POST /api/threads/:thread_id/messages` after:

1. the user message insert succeeds
2. `recordThreadMessageMetadata(...)` succeeds
3. `agentService.startUserMessage(...)` succeeds

Then launch title generation without awaiting it.

Recommended gating:

- only when the thread currently has no title
- only when this is the thread's first user message
- only when the inserted message is not a duplicate retry path

Why after `startUserMessage(...)` instead of before:

- the agent turn is guaranteed to exist
- the title work still overlaps almost the entire first assistant response
- title generation does not run for a failed-to-start turn

### 5.3 Determining "first user message"

Use a stricter check than "first POST on this route" alone.

Recommended rule:

- qualify only if the thread has no title and no prior user messages before the newly inserted message

Implementation options:

1. Minimal first pass:
   - use the pre-insert thread row and require `thread.title == null` and `thread.message_count === 0`
2. Safer first pass:
   - additionally confirm there is no prior `message.role = 'user'` row for the thread

Recommendation:

- use option 2 if the code change remains small
- use option 1 only if we explicitly accept a tiny edge-case window around concurrent first writes

### 5.4 Invocation shape

Use the existing provider abstraction, but with a fixed model config:

- model: `claude-haiku-4-5`
- tools: none
- reasoning: disabled
- max output tokens: small, for example `24-32`
- timeout: short, for example `3000-5000 ms`

The title prompt should be optimized for strict plain-text output, for example:

System guidance:

- generate a concise thread title from the user's first message
- return only the title text
- 3-5 words
- no quotes
- no markdown
- no trailing punctuation

User input:

- the raw first user message text

### 5.5 Sanitization and validation

Even with a constrained prompt, the service should sanitize before writing:

- trim whitespace
- collapse internal whitespace
- strip wrapping quotes or backticks
- strip trailing `.`, `!`, `?`, `:`, `;`
- cap total length, for example `<= 80` characters

Recommended validation:

- non-empty
- ideally 3-5 words
- reject obviously malformed outputs such as:
  - multi-line answers
  - markdown bullets
  - explanatory sentences

Recommendation:

- fail closed on invalid output
- log the miss
- leave the title null

This is preferable to a low-quality heuristic title in the first pass.

### 5.6 Conditional persistence

Persist with a conditional update:

```sql
UPDATE thread
SET title = $title
WHERE thread_id = $thread_id
  AND created_by_user_id = $owner_user_id
  AND title IS NULL
RETURNING thread_id, bud_id, title, created_at, last_activity_at, last_message_preview, message_count, pinned, archived;
```

Important behavior:

- only emit the stream event if this update returns a row
- if the row is not returned, another path already set the title and this sidecar should do nothing else

This gives us idempotent DB behavior even if:

- the request retries
- two workers race
- a future manual-rename feature lands later

### 5.7 Stream event

Add a new event on `GET /api/threads/:thread_id/agent/stream`.

Recommended event name:

- `thread.title`

Recommended payload:

```json
{
  "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
  "title": "Summarize Failing Tests",
  "source": "generated_first_user_message",
  "updated_at": "2026-04-08T19:15:04.000Z"
}
```

Notes:

- field names stay snake_case
- `thread_id` is included even though the stream is already thread-scoped; it makes client reducers simpler and future-proofs shared handlers
- `source` is optional but useful for analytics/debugging and future manual-rename differentiation

### 5.8 How the event should be emitted

Use the existing thread agent runtime stream transport.

Recommendation:

- continue streaming over `AgentRuntimeStateManager`
- add a small helper so non-agent thread events can be emitted in a cursor-aware way

Important nuance:

- if a `thread.title` event participates in the same bounded resume stream, we should not treat it as an invisible side effect
- clients that fetch `/agent/state` and then attach `/agent/stream?after=<cursor>` must still converge correctly

Recommended rule:

- emitting `thread.title` should also advance the thread stream cursor space

This does not require `agent/state` to become a durable thread metadata source, but it does mean the stream cursor remains monotonic across both `agent.*` and `thread.title`.

### 5.9 Recommended route semantics

The new stream contract for this feature should be:

- `thread.title` is a thread-scoped metadata event carried on the thread agent stream
- it may appear during any turn, though the initial shipped trigger is the first user message
- clients should treat it as idempotent
- clients should not assume it appears before or after a specific `agent.*` event

## 6. Web Integration Design

### 6.1 Problem to solve

The active web thread route already consumes the stream, but the thread list lives one route level above it and is currently loader-only.

Without a shared mutable thread summary layer:

- the streamed title will not update the thread panel
- the newly created thread row may remain stale as well

### 6.2 Recommended web shape

At `/$budId`:

- replace the current immutable `initialThreads -> useMemo(...)` pattern with mutable thread summary state seeded from loader data
- expose a small `upsertThreadSummary(...)` helper to child routes via outlet context or a dedicated React context

At `/$budId/$threadId`:

- fetch `GET /api/threads/:thread_id` in the loader alongside:
  - `/messages`
  - `/agent/state`
- on mount, upsert that thread summary into the parent store
- listen for `thread.title` and patch the same parent store row

This yields correct behavior in both races:

1. Title generated before stream attach
   - child loader sees the persisted title
   - child upserts it into the parent thread list state
2. Title generated after stream attach
   - `thread.title` patches the thread list state live

### 6.3 Optional web UX improvement

Right now the workspace top bar uses static labels:

- `New Thread`
- `Thread`

Optional improvement:

- show the current thread title in [`web/src/components/workbench/workspace-top-bar.tsx`](../web/src/components/workbench/workspace-top-bar.tsx) once known

This is not required to satisfy the title-generation feature, but it is the most obvious follow-up once the title exists.

## 7. Mobile Contract Notes

From the mobile client's perspective, the important rule is simple:

- any thread agent stream may emit a thread title update

The mobile app should:

- keep showing its provisional label (`New thread`, `Untitled thread`, or equivalent) until it has a real title
- update the active thread header when `thread.title` arrives
- update any cached thread-list row keyed by `thread_id`
- treat the event as idempotent and last-write-wins
- avoid a title-only secondary fetch on the happy path

If the event is missed:

- the canonical title still comes from `GET /api/threads` or `GET /api/threads/:thread_id`

## 8. Options Considered

### Option A: Specific `thread.title` event

Pros:

- small change
- directly matches the product ask
- low client complexity

Cons:

- only fixes title drift
- does not address broader thread list drift for preview/count/activity

### Option B: Generic `thread.updated` event with a partial thread summary

Pros:

- more extensible
- could also keep preview/count/activity live

Cons:

- larger scope
- requires more reducer logic immediately
- adds more contract surface than the current ask needs

Recommendation:

- ship Option A first
- keep Option B as the next step if we decide to make the thread list fully live-synced

## 9. Open Questions

### 9.1 Should we add bookkeeping columns for generated titles?

Examples:

- `title_source`
- `title_generated_at`
- `title_model`

Recommendation:

- do not add schema for the first pass
- keep only `thread.title`
- add metadata columns later only if product needs auditability or manual-rename conflict handling

### 9.2 Should we include current title in `/api/threads/:thread_id/agent/state`?

Pros:

- makes the open-sequence race even cleaner

Cons:

- mixes durable thread metadata into a route explicitly meant for in-flight runtime state

Recommendation:

- no for the first pass
- use `GET /api/threads/:thread_id` plus the new stream event instead

### 9.3 Should we silently fall back if Anthropic Haiku is unavailable?

Options:

- fallback to `config.defaultModel`
- fallback to a heuristic title
- skip generation and log

Recommendation:

- skip generation and log
- do not silently violate the product requirement that title generation use Anthropic Haiku

### 9.4 Do we want the web app to show the title in the top bar right away?

Recommendation:

- treat this as optional but desirable
- the required feature is thread naming plus thread-list update, not a larger workbench header redesign

## 10. Expected File Areas

Service:

- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
- new title-generation service file under `service/src/agent/` or `service/src/llm/`
- [`service/src/runtime/agent-runtime-state.ts`](../service/src/runtime/agent-runtime-state.ts)
- possibly a small thread-title DB helper alongside [`service/src/db/thread-metadata.ts`](../service/src/db/thread-metadata.ts)
- [`service/src/config.ts`](../service/src/config.ts) for title-generation config

Web:

- [`web/src/routes/$budId.tsx`](../web/src/routes/%24budId.tsx)
- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/%24budId/%24threadId.tsx)
- optionally [`web/src/components/workbench/workspace-top-bar.tsx`](../web/src/components/workbench/workspace-top-bar.tsx)

Docs to update when implemented:

- [`docs/proto.md`](../docs/proto.md)
- [`service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md)
- [`service/src/runtime/runtime.spec.md`](../service/src/runtime/runtime.spec.md)
- [`service/src/agent/agent.spec.md`](../service/src/agent/agent.spec.md)
- [`web/src/routes/$budId/budId.spec.md`](../web/src/routes/%24budId/budId.spec.md)
- [`web/src/components/workbench/workbench.spec.md`](../web/src/components/workbench/workbench.spec.md)

## 11. Recommendation Summary

Use a dedicated, fire-and-forget title-generation sidecar triggered from the first successful user message, invoke Anthropic `claude-haiku-4-5`, persist the result with a conditional `title IS NULL` update, and emit a `thread.title` event on the existing thread agent stream.

On the web side, do not rely on the current immutable parent loader data. Add a mutable thread summary layer at `/$budId`, seed it from loader data, and patch it from both:

- `GET /api/threads/:thread_id` on thread open
- the new `thread.title` stream event

That gives us the desired UX:

- no assistant-turn blocking
- no title-specific secondary fetch on the happy path
- live title updates during the first response stream
- durable DB convergence when the stream is missed
