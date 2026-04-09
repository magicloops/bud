# Handoff: Mobile Thread Title Stream Updates

Audience: iOS / mobile team

Last updated: 2026-04-08 (post-implementation)

## 1. What Is Changing

The thread agent stream now emits a thread-metadata event so the app can replace provisional conversation labels without making a second title-specific API call.

New event on:

- `GET /api/threads/:thread_id/agent/stream`

New event name:

- `thread.title`

Current shipped trigger:

- generated from the first user message of a thread

The backend currently uses Anthropic `claude-haiku-4-5` to create the title, but from the mobile client's perspective this is just a streamed thread metadata update.

## 2. Why This Exists

Today, new conversations can remain labeled with placeholders such as:

- `New thread`
- `Untitled thread`

The goal is to let the app update the visible thread name during the first assistant response flow, without a second request that exists only to learn the generated title.

## 3. New Event Contract

### Event

```text
event: thread.title
data: {"thread_id":"3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2","title":"Summarize Failing Tests","source":"generated_first_user_message","updated_at":"2026-04-08T19:15:04.000Z"}
```

### Payload

```json
{
  "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
  "title": "Summarize Failing Tests",
  "source": "generated_first_user_message",
  "updated_at": "2026-04-08T19:15:04.000Z"
}
```

Field notes:

- `thread_id`
  - canonical thread identity to patch in local state
- `title`
  - new durable thread title
  - this is the server-approved display string; mobile should render it as-is
  - titles may be short, including one-word or two-word titles such as `Bugfix` or `Assistant Introduction`
- `source`
  - metadata for debugging/analytics
  - current shipped value: `generated_first_user_message`
- `updated_at`
  - server timestamp for last-write-wins reducers if needed

Durability note:

- `thread.title` is emitted only after the backend has successfully persisted the new title on the thread row

## 4. Ordering Expectations

Do not assume this event has a fixed position relative to `agent.*` events.

It may arrive:

- before `agent.message_start`
- between assistant draft events
- after `agent.message`
- after `final`

Client rule:

- apply the title whenever it arrives
- do not gate title updates on assistant event ordering
- do not assume titles are sentence-like or 3-5 words long

## 5. Client Behavior

### 5.1 Provisional naming

Until a real title exists, mobile can keep using its current provisional label, for example:

- `New thread`
- `Untitled thread`

### 5.2 When `thread.title` arrives

Update all cached state keyed by `thread_id`:

- active conversation header
- thread list row
- any local thread detail cache

No title-specific follow-up fetch is needed on the happy path.

Do not locally rewrite or validate the title beyond normal UI-safe rendering:

- do not impose a minimum word count
- do not truncate based on a client-only 3-5 word rule
- do not title-case or otherwise restyle the string before storing it in thread state

### 5.3 Idempotency

Treat `thread.title` as idempotent and last-write-wins.

If the same title arrives more than once:

- just overwrite local state with the latest payload

### 5.4 Persistence fallback

If the event is missed because of reconnect, resume miss, or app lifecycle timing, the durable title still comes from the normal read surfaces:

- `GET /api/threads`
- `GET /api/threads/:thread_id`

So mobile should not treat the stream event as the only source of truth.

## 6. Interaction With Existing Agent Stream Logic

This event is additive.

Existing agent-stream handling for:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `agent.resync_required`
- `final`

should remain unchanged.

The only new requirement is:

- listen for `thread.title`
- patch thread metadata state without forcing a transcript refetch
- keep using the same stream-resume handling you already use for the rest of the thread agent stream

## 7. Suggested Mobile Reducer Rule

Pseudocode:

```ts
onSseEvent('thread.title', payload) {
  upsertThread(payload.thread_id, {
    title: payload.title,
    updated_at: payload.updated_at,
  })
}
```

If your local state separates:

- thread list entities
- active thread detail entities

patch both with the same `thread_id`.

## 8. Recommended UX

For a newly created conversation:

1. create thread
2. send first message
3. show provisional name immediately
4. attach to `/agent/stream`
5. replace provisional name when `thread.title` arrives

This should feel like a normal live upgrade of the conversation label, not a refresh.

Recommended presentation rule:

- once a server title exists, prefer it everywhere over local placeholders like `New thread`

## 9. No Special Resume Logic Needed

`thread.title` should use the same stream attach/resume path as the rest of the thread agent stream.

If the app receives:

- `agent.resync_required`

then the existing recovery flow still applies:

1. refetch canonical thread/message state
2. refetch `/agent/state` if already part of your attach sequence
3. reattach the stream

There is no title-specific recovery path.

Because `thread.title` shares the same SSE frame-id cursor space as the rest of the agent stream:

- store resume cursors exactly as you do for other thread agent events
- do not build a separate resume mechanism for title updates

## 10. One Future-Proofing Note

Even though the first shipped backend trigger is "first user message", mobile should not hardcode that assumption into UI logic.

Safer client mental model:

- any thread agent stream may emit thread metadata updates

That keeps the client ready for future server-side rename sources without another adapter rewrite.
