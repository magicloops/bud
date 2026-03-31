# iOS Agent Stream State And Resume Fixtures

**Status:** Current backend fixtures  
**Audience:** Backend, web, iOS  
**Last Updated:** 2026-03-30

This document publishes concrete example sequences for the current contract described in:

- [`IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`](./IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)

These fixtures reflect the shipped `/agent/state` plus bounded-resume `/agent/stream` model.

For agent stream fixtures below:

- SSE frame `id:` is the opaque resume cursor
- the client should store the latest seen `id:` as the next `after=<cursor>` value
- `heartbeat` and `agent.resync_required` may omit `id:` and do not advance the cursor

## Fixture 1: Passive Open Of A Completed Thread

Thread-open sequence:

```http
GET /api/threads/:thread_id/messages?limit=100
GET /api/threads/:thread_id/agent/state
GET /api/threads/:thread_id/agent/stream?after=01CUR_IDLE_1
```

Expected behavior:

- `/messages` returns the completed canonical transcript
- `/agent/state` returns `active: false`
- stream opens with the idle snapshot cursor
- because nothing newer exists after that cursor, the attach behaves like live-only
- no old `agent.tool_call`, `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.message`, or `final` is replayed

Example state:

```json
{
  "active": false,
  "turn_id": null,
  "phase": "idle",
  "can_cancel": false,
  "stream_cursor": "01CUR_IDLE_1",
  "pending_tool": null,
  "draft_assistant": null,
  "updated_at": "2026-03-26T21:00:00.000Z"
}
```

Example stream start:

```text
event: heartbeat
data: {"ts":1774568400000}
```

## Fixture 2: Active-Turn Open With Bounded Catch-Up

Thread-open sequence:

```http
GET /api/threads/:thread_id/messages?limit=100
GET /api/threads/:thread_id/agent/state
GET /api/threads/:thread_id/agent/stream?after=01CUR_ACTIVE_4
```

Example state:

```json
{
  "active": true,
  "turn_id": "01TURN_ACTIVE_1",
  "phase": "streaming_message",
  "can_cancel": true,
  "stream_cursor": "01CUR_ACTIVE_4",
  "pending_tool": null,
  "draft_assistant": {
    "client_id": "0195f8dd-85d0-7ad7-9377-9fa6990f8774",
    "text": "Working through the repo",
    "updated_at": "2026-03-26T21:01:00.000Z"
  },
  "updated_at": "2026-03-26T21:01:00.000Z"
}
```

Expected stream catch-up:

```text
id: 01CUR_ACTIVE_5
event: agent.message_delta
data: {"turn_id":"01TURN_ACTIVE_1","client_id":"0195f8dd-85d0-7ad7-9377-9fa6990f8774","delta":" now."}

id: 01CUR_ACTIVE_6
event: agent.message_done
data: {"turn_id":"01TURN_ACTIVE_1","client_id":"0195f8dd-85d0-7ad7-9377-9fa6990f8774","text":"Working through the repo now."}

id: 01CUR_ACTIVE_7
event: agent.message
data: {"turn_id":"01TURN_ACTIVE_1","client_id":"0195f8dd-85d0-7ad7-9377-9fa6990f8774","message_id":"01MSG_ASSISTANT_9","text":"Working through the repo now.","message":{...}}

id: 01CUR_ACTIVE_8
event: final
data: {"turn_id":"01TURN_ACTIVE_1","status":"succeeded","text":"Working through the repo now.","message_id":"01MSG_ASSISTANT_9"}
```

Only effects after `01CUR_ACTIVE_4` are delivered.

## Fixture 3: Resume Cursor Too Old Or Unknown

Reconnect attempt:

```http
GET /api/threads/:thread_id/agent/stream?after=01CUR_STALE_1
```

Expected behavior:

- the server does not silently drop the gap
- the server does not replay unrelated old history
- the server responds with explicit `resync_required`

```text
event: agent.resync_required
data: {"error":"resync_required","provided_cursor":"01CUR_STALE_1"}
```

Then the service closes that SSE response and the client performs the normal resync flow.

Expected client follow-up:

```http
GET /api/threads/:thread_id/messages?limit=100
GET /api/threads/:thread_id/agent/state
GET /api/threads/:thread_id/agent/stream?after=<new_state_cursor>
```

## Fixture 4: Idle Snapshot Before A New Turn Starts

State:

```json
{
  "active": false,
  "turn_id": null,
  "phase": "idle",
  "can_cancel": false,
  "stream_cursor": "01CUR_IDLE_7",
  "pending_tool": null,
  "draft_assistant": null,
  "updated_at": "2026-03-26T21:02:00.000Z"
}
```

Client attaches:

```http
GET /api/threads/:thread_id/agent/stream?after=01CUR_IDLE_7
```

Then a new turn starts.

Expected behavior:

- the cursor closes the `idle -> new turn` race
- the client receives new effects after `01CUR_IDLE_7`
- the client does not need special gap-detection logic

Example first post-attach event:

```text
id: 01CUR_IDLE_8
event: agent.message_start
data: {"turn_id":"01TURN_NEW_1","client_id":"0195f8dd-85d2-7b57-8d03-6cbce5d6b0a0"}
```

## Fixture 5: `/messages` Succeeds But `/agent/state` Fails

Thread-open sequence:

```http
GET /api/threads/:thread_id/messages?limit=100
GET /api/threads/:thread_id/agent/state
```

Example result:

```http
GET /api/threads/:thread_id/messages?limit=100 -> 200 OK
GET /api/threads/:thread_id/agent/state -> 500 Internal Server Error
```

Expected client behavior:

- render the canonical transcript returned by `/messages`
- do not synthesize pending-tool or draft-assistant rows
- do not show stop/cancel affordance without confirmed runtime state
- retry `/agent/state`
- if product chooses to attach stream before `/agent/state` recovers, attach with no cursor and treat that stream as live-only until state becomes available

## Fixture 6: `agent.resync_required` While The User Is Reading Older History

Reconnect attempt:

```http
GET /api/threads/:thread_id/agent/stream?after=01CUR_STALE_9
```

Server response:

```text
event: agent.resync_required
data: {"error":"resync_required","provided_cursor":"01CUR_STALE_9"}
```

Expected client behavior:

- refetch `/messages` plus `/agent/state`
- update the local model to the latest canonical state
- preserve the user's current scroll/read position when possible
- do not auto-jump to latest unless the user was already there or explicitly chooses to jump

## Identity Rule For All Fixtures

- Use `client_id` as the primary rendered message identity for optimistic users, pending tools, draft assistants, and canonical transcript rows.
- Keep `message_id` on canonical persisted rows for cursor ordering, debugging, and row-level correlation.
- During rollout fallback, use `client_id ?? message_id` only when older historical or transitional payloads still omit `client_id`.
