# iOS Agent Stream State And Resume Fixtures

**Status:** Draft proposed fixtures, not yet shipped  
**Audience:** Backend, web, iOS  
**Last Updated:** 2026-03-26

This document publishes concrete example sequences for the proposed next contract described in:

- [`IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`](./IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)

These are draft fixtures for review before implementation. They are not yet normative shipped examples.

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
- stream opens live-only
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
data: {"ts":1774568400000,"initial":true}
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
    "text": "Working through the repo",
    "updated_at": "2026-03-26T21:01:00.000Z"
  },
  "updated_at": "2026-03-26T21:01:00.000Z"
}
```

Expected stream catch-up:

```text
event: agent.message_delta
data: {"turn_id":"01TURN_ACTIVE_1","delta":" now."}

event: agent.message_done
data: {"turn_id":"01TURN_ACTIVE_1","text":"Working through the repo now."}

event: agent.message
data: {"turn_id":"01TURN_ACTIVE_1","message_id":"01MSG_ASSISTANT_9","text":"Working through the repo now.","message":{...}}

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

Draft transport options still under review:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{"error":"resync_required"}
```

or

```text
event: agent.resync_required
data: {"reason":"cursor_not_resumable"}
```

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
