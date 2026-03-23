# Agent Stream Event Fixtures

**Status:** Current reference fixtures  
**Audience:** Backend, web, iOS  
**Last Updated:** 2026-03-22

This document publishes concrete example sequences for the current `GET /api/threads/:thread_id/agent/stream` contract.

These are fixtures, not normative schema definitions. The normative contract still lives in:

- [`docs/proto.md`](../docs/proto.md)
- [`IOS_MOBILE_BACKEND_HANDOFF.md`](../IOS_MOBILE_BACKEND_HANDOFF.md)
- [`IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md`](../IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md)

## Fixture 1: Ordinary Success

```text
id: evt_100
event: agent.tool_call
data: {"turn_id":"01TURNAAA","call_id":"call_123","name":"terminal.run","args":{"input":"pwd\n"}}

id: evt_101
event: agent.tool_result
data: {
  "turn_id":"01TURNAAA",
  "call_id":"call_123",
  "message_id":"01MSG_TOOL_1",
  "name":"terminal.run",
  "summary":"Ran pwd",
  "output":"/Users/adam/bud\n",
  "output_bytes":16,
  "truncated":false,
  "output_truncation_reason":null,
  "omitted_lines":0,
  "message":{
    "message_id":"01MSG_TOOL_1",
    "role":"tool",
    "display_role":"Tool",
    "content":"{\"tool\":\"terminal.run\",\"call_id\":\"call_123\",\"input\":\"pwd\\n\",\"summary\":\"Ran pwd\",\"output\":\"/Users/adam/bud\\n\",\"output_truncation_reason\":null}",
    "metadata":{"tool":"terminal.run","call_id":"call_123","summary":"Ran pwd","output_truncation_reason":null},
    "created_at":"2026-03-22T23:10:00.000Z"
  }
}

id: evt_102
event: agent.message_start
data: {"turn_id":"01TURNAAA"}

id: evt_103
event: agent.message_delta
data: {"turn_id":"01TURNAAA","delta":"The current directory is "}

id: evt_104
event: agent.message_delta
data: {"turn_id":"01TURNAAA","delta":"`/Users/adam/bud`."}

id: evt_105
event: agent.message_done
data: {"turn_id":"01TURNAAA","text":"The current directory is `/Users/adam/bud`."}

id: evt_106
event: agent.message
data: {
  "turn_id":"01TURNAAA",
  "message_id":"01MSG_ASSISTANT_1",
  "text":"The current directory is `/Users/adam/bud`.",
  "message":{
    "message_id":"01MSG_ASSISTANT_1",
    "role":"assistant",
    "display_role":"Bud Agent",
    "content":"The current directory is `/Users/adam/bud`.",
    "metadata":{"status":"succeeded"},
    "created_at":"2026-03-22T23:10:01.000Z"
  }
}

id: evt_107
event: final
data: {"turn_id":"01TURNAAA","status":"succeeded","text":"The current directory is `/Users/adam/bud`.","message_id":"01MSG_ASSISTANT_1"}
```

## Fixture 2: Failure After Tool Activity

```text
id: evt_200
event: agent.tool_call
data: {"turn_id":"01TURNBBB","call_id":"call_456","name":"terminal.run","args":{"input":"bad-command\n"}}

id: evt_201
event: agent.tool_result
data: {
  "turn_id":"01TURNBBB",
  "call_id":"call_456",
  "message_id":"01MSG_TOOL_2",
  "name":"terminal.run",
  "summary":"Ran bad-command",
  "output":"command not found: bad-command\n",
  "output_bytes":31,
  "truncated":false,
  "output_truncation_reason":null,
  "omitted_lines":0,
  "message":{
    "message_id":"01MSG_TOOL_2",
    "role":"tool",
    "display_role":"Tool",
    "content":"{\"tool\":\"terminal.run\",\"call_id\":\"call_456\",\"input\":\"bad-command\\n\",\"summary\":\"Ran bad-command\",\"output\":\"command not found: bad-command\\n\",\"output_truncation_reason\":null}",
    "metadata":{"tool":"terminal.run","call_id":"call_456","summary":"Ran bad-command","output_truncation_reason":null},
    "created_at":"2026-03-22T23:11:00.000Z"
  }
}

id: evt_202
event: final
data: {"turn_id":"01TURNBBB","status":"failed","error":"agent_failed"}
```

## Fixture 3: Canceled Turn

```text
id: evt_300
event: final
data: {"turn_id":"01TURNCCC","status":"canceled","error":"Agent turn canceled"}
```

## Fixture 4: Reconnect Replay With Resume Cursor Hit

Server buffer currently contains:

- `evt_400` `agent.tool_call`
- `evt_401` `agent.tool_result`
- `evt_402` `agent.message_start`
- `evt_403` `agent.message_delta`
- `evt_404` `agent.message_done`
- `evt_405` `agent.message`
- `evt_406` `final`

Client reconnects with:

```http
GET /api/threads/:thread_id/agent/stream?last_event_id=evt_401
```

Expected replay:

```text
id: evt_402
event: agent.message_start
data: {"turn_id":"01TURNDDD"}

id: evt_403
event: agent.message_delta
data: {"turn_id":"01TURNDDD","delta":"Done."}

id: evt_404
event: agent.message_done
data: {"turn_id":"01TURNDDD","text":"Done."}

id: evt_405
event: agent.message
data: {...}

id: evt_406
event: final
data: {"turn_id":"01TURNDDD","status":"succeeded","text":"Done.","message_id":"01MSG_ASSISTANT_4"}
```

Only events strictly after `evt_401` are replayed.

## Fixture 5: Reconnect Replay Miss / Live-Only Fallback

Client reconnects with:

```http
GET /api/threads/:thread_id/agent/stream?last_event_id=evt_missing
```

If `evt_missing` is no longer present in the in-memory buffer:

- the server does **not** replay the whole buffer
- the server primes the stream with heartbeat/live delivery
- the client should reconcile with canonical history via `GET /api/threads/:thread_id/messages?limit=<n>`

This is the current recovery model for stale resume cursors and process restarts.
