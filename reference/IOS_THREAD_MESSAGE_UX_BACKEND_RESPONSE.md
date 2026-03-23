# iOS Thread Message UX Backend Response

**Status:** Backend response  
**Audience:** Backend, web platform, iOS, product  
**Last Updated:** 2026-03-22

## Summary

This doc answers the questions in `IOS_THREAD_MESSAGE_UX_BACKEND_HANDOFF.md` based on the current implementation in this repo.

The most important correction up front is:

- the backend **now does** expose a real cursor-based thread-message pagination contract
- the reference web app now boots from the latest page and can prepend older pages upward
- successful agent SSE events now expose stable `turn_id`, `call_id`, and `message_id` identifiers for transcript reconciliation
- the remaining gap is no longer pagination or assistant delta streaming; it is replay/resume durability and the broader UI decisions around draft-vs-canonical transcript handling

So iOS can now treat transcript pagination and healthy-turn live reconciliation as shipped backend contracts, while still treating replay/resume durability as a separate unfinished area.

## 1. Real Current Thread-Message Contract

### Current routes

```http
GET /api/threads/:thread_id/messages?limit=<1..200>
GET /api/threads/:thread_id/messages?limit=<1..200>&before=<opaque_cursor>
GET /api/threads/:thread_id/messages?limit=<1..200>&after=<opaque_cursor>
```

### Current request shape actually used by web

Initial thread bootstrap:

```http
GET /api/threads/:thread_id/messages?limit=100
```

Older-page load in the current web thread view:

```http
GET /api/threads/:thread_id/messages?limit=100&before=<page.before_cursor>
```

Canonical refresh after reconnect / stream recovery paths:

```http
GET /api/threads/:thread_id/messages?limit=100
```

### Current response shape

The route now returns a pagination envelope.

Example:

```json
{
  "messages": [
    {
      "message_id": "01KMABCD121",
      "role": "user",
      "display_role": "User",
      "content": "ls",
      "metadata": {},
      "created_at": "2026-03-22T20:15:27.000Z"
    },
    {
      "message_id": "01KMABCD122",
      "role": "tool",
      "display_role": "Tool",
      "content": "{\"tool\":\"terminal.run\",\"call_id\":\"call_123\",\"input\":\"ls\\n\",\"summary\":\"Ran ls\",\"output\":\"file.txt\\n\",\"output_bytes\":9,\"readiness\":{\"ready\":true,\"confidence\":0.97,\"trigger\":\"prompt\",\"hints\":{\"looks_like_prompt\":true}},\"truncated\":false,\"output_truncation_reason\":null,\"omitted_lines\":0,\"context\":{\"mode\":\"shell\"}}",
      "metadata": {
        "tool": "terminal.run",
        "call_id": "call_123",
        "input": "ls\n",
        "summary": "Ran ls",
        "output": "file.txt\n",
        "output_bytes": 9,
        "readiness": {
          "ready": true,
          "confidence": 0.97,
          "trigger": "prompt",
          "hints": {
            "looks_like_prompt": true
          }
        },
        "truncated": false,
        "output_truncation_reason": null,
        "omitted_lines": 0,
        "context": {
          "mode": "shell"
        }
      },
      "created_at": "2026-03-22T20:15:29.000Z"
    },
    {
      "message_id": "01KMABCD123",
      "role": "assistant",
      "display_role": "Bud Agent",
      "content": "Done.",
      "metadata": {
        "status": "succeeded"
      },
      "created_at": "2026-03-22T20:15:31.000Z"
    }
  ],
  "page": {
    "limit": 100,
    "returned": 3,
    "has_more_before": true,
    "has_more_after": false,
    "before_cursor": "opaque_cursor_oldest_in_page",
    "after_cursor": "opaque_cursor_newest_in_page"
  }
}
```

### Sort order guarantee

Current server behavior:

- for latest-page and `before` requests, the service queries newest-first internally
- for `after` requests, the service queries oldest-first internally
- every returned `messages` page is normalized to oldest-to-newest before sending the response
- the cursor boundary uses `(created_at, message_id)` so tied timestamps still have a stable order

Current web behavior:

- web keeps a local ascending sort in the timeline because it mixes canonical transcript rows with temporary live SSE rows
- for canonical paged history alone, iOS can render `messages` in API order

### Pagination mechanism

- `page.before_cursor` points at the oldest message currently held by the client
- `page.after_cursor` points at the newest message currently held by the client
- `before` requests older history than the boundary, exclusive
- `after` requests newer history than the boundary, exclusive
- page metadata includes:
  - `limit`
  - `returned`
  - `has_more_before`
  - `has_more_after`
  - `before_cursor`
  - `after_cursor`

### Older-page loading

Current answer:

- supported as a first-class contract via `before=<page.before_cursor>`
- current page boundaries are exclusive
- current web behavior is to prepend older pages while preserving scroll anchor

### Direct answer to the mobile question

The current backend contract is:

1. load the latest page with `GET /api/threads/:thread_id/messages?limit=<n>`
2. render the returned `messages` array oldest-to-newest
3. if `page.has_more_before` is true, request older history with `before=<page.before_cursor>`
4. if explicit forward catch-up is needed, request newer history with `after=<page.after_cursor>`
5. keep using canonical history as the source of truth after reconnect or suspected drift

So iOS should now treat thread-message paging as **implemented in the backend contract**.

## 2. Assistant SSE Semantics

### Contract answer

Current contract:

- `agent.message_delta.delta` is a true append chunk for assistant text
- `agent.message_done.text` is the full draft assistant text for that turn
- `agent.message.message` is the canonical persisted assistant transcript row
- `agent.message.text` still contains the full final assistant body, but it now arrives after the draft stream as part of the persisted-row event

### Why

Current `AgentService` behavior is:

1. call the model with provider `invoke(...)` streaming
2. emit `agent.message_start` when the first assistant-text chunk appears
3. emit `agent.message_delta { turn_id, delta }` as assistant text arrives
4. emit `agent.message_done { turn_id, text }` when draft generation completes
5. persist the assistant message
6. emit one canonical `agent.message { turn_id, message_id, text, message }`
7. immediately emit `final`

So the backend now supports true assistant-text streaming, but the canonical transcript row still arrives later as `agent.message`.

### `final.text` semantics

For successful turns:

- `final.text` contains the same full final assistant text as `agent.message_done.text` and `agent.message.text`

For failed or canceled turns:

- `final` is still emitted
- but it carries `error`, not `text`

### Recommended client rule

For the current backend:

- create one draft assistant row per `turn_id` on `agent.message_start`
- append `agent.message_delta.delta` to that draft row
- treat `agent.message_done.text` as the full draft snapshot just before persistence
- prefer `agent.message.message` for transcript reconciliation because it carries the persisted canonical row
- replace the draft row with `agent.message.message` when it arrives
- keep using canonical `/messages` history after reconnect or suspected drift

### Realistic success example

```text
event: heartbeat
data: {"ts":1774240000000,"initial":true}

event: agent.tool_call
data: {"turn_id":"01TURNABC123","call_id":"call_123","name":"terminal.run","args":{"input":"ls\n"}}

event: agent.tool_result
data: {
  "turn_id":"01TURNABC123",
  "call_id":"call_123",
  "message_id":"01KMABCD122",
  "name":"terminal.run",
  "summary":"Ran ls",
  "output":"file.txt\n",
  "output_bytes":9,
  "readiness":{"ready":true,"confidence":0.97,"trigger":"prompt","hints":{"looks_like_prompt":true}},
  "truncated":false,
  "output_truncation_reason":null,
  "omitted_lines":0,
  "message":{"message_id":"01KMABCD122","role":"tool","display_role":"Tool","content":"{\"tool\":\"terminal.run\",\"call_id\":\"call_123\",\"input\":\"ls\\n\",\"summary\":\"Ran ls\",\"output\":\"file.txt\\n\",\"output_truncation_reason\":null}","metadata":{"tool":"terminal.run","call_id":"call_123","summary":"Ran ls","output_truncation_reason":null},"created_at":"2026-03-22T20:15:29.000Z"}
}

event: agent.message_start
data: {"turn_id":"01TURNABC123"}

event: agent.message_delta
data: {"turn_id":"01TURNABC123","delta":"I found `file.txt` "}

event: agent.message_delta
data: {"turn_id":"01TURNABC123","delta":"in the current directory."}

event: agent.message_done
data: {"turn_id":"01TURNABC123","text":"I found `file.txt` in the current directory."}

event: agent.message
data: {"turn_id":"01TURNABC123","message_id":"01KMABCD123","text":"I found `file.txt` in the current directory.","message":{"message_id":"01KMABCD123","role":"assistant","display_role":"Bud Agent","content":"I found `file.txt` in the current directory.","metadata":{"status":"succeeded"},"created_at":"2026-03-22T20:15:31.000Z"}}

event: final
data: {"turn_id":"01TURNABC123","status":"succeeded","text":"I found `file.txt` in the current directory.","message_id":"01KMABCD123"}
```

### Realistic failure example

```text
event: agent.tool_call
data: {"turn_id":"01TURNABC123","call_id":"call_123","name":"terminal.run","args":{"input":"bad-command\n"}}

event: agent.tool_result
data: {
  "turn_id":"01TURNABC123",
  "call_id":"call_123",
  "name":"terminal.run",
  "summary":"Ran bad-command",
  "output":"command not found: bad-command\n",
  "output_bytes":31,
  "readiness":{"ready":true,"confidence":0.93,"trigger":"prompt","hints":{"looks_like_prompt":true}},
  "truncated":false,
  "output_truncation_reason":null,
  "omitted_lines":0
}

event: final
data: {"turn_id":"01TURNABC123","status":"failed","error":"agent_failed"}
```

### Realistic canceled example

```text
event: final
data: {"turn_id":"01TURNABC123","status":"canceled","error":"Agent turn canceled"}
```

## 3. Other Transcript / Stream Gotchas

## 3.1 `final` emission behavior

Current behavior:

- success: yes, always emits `final`
- canceled: yes, emits `final` with `status: "canceled"` and `error`
- failed: yes, emits `final` with `status: "failed"` and `error`

Important note:

- only successful turns emit `agent.message`
- failed and canceled turns may still have emitted draft assistant text earlier in the turn, so clients should clear or mark draft rows when `final.status` is not `succeeded`
- failed and canceled turns do not emit a successful assistant message row first

## 3.2 Replay can include already-seen events

Current backend behavior:

- `AgentEventBus` buffers events in memory per thread
- attaching a new SSE listener without a resume cursor replays the entire current in-memory buffer for that thread
- attaching with `Last-Event-ID` or `last_event_id=<sse_frame_id>` replays only the buffered events strictly after that frame when the frame is still present
- the buffer limit is 1000 events
- the buffer is process-local only
- the buffer is cleared at the **start of the next turn**, not immediately after `final`

Direct consequence:

- reconnect replay can include already-seen events
- opening an idle thread can replay stale previous-turn events if the process still has them buffered
- resume-by-id only works while the requested event id is still in the process-local buffer
- process restart loses the replay buffer entirely

This is at-least-once replay behavior, not exactly-once delivery.

### What web currently does

The current web route does **not** dedupe replayed agent events by SSE `id`.

Instead it tolerates replay by:

- upserting canonical `agent.tool_result.message` and `agent.message.message` rows during healthy connected turns
- reconnecting with the last seen SSE frame id so the server can replay only newer buffered events when available
- treating reconnect or suspected drift as a reason to refetch the latest canonical message page

That is why the current web transcript model is “optimistic live events plus canonical refetch,” not “stream is the single source of truth.”

## 3.3 Message history can contain rows never seen in the live stream

Yes.

Examples:

- user messages are created by `POST /api/threads/:thread_id/messages` before agent SSE starts
- `system` rows from context sync can be inserted before a send and are not emitted on the agent SSE stream
- late attach, reconnect, process restart, or buffer clearing can leave persisted rows with no matching live event for the current client
- even though successful live tool and assistant events now carry canonical persisted rows, history can still contain rows the client never saw live

So mobile should assume:

- canonical transcript history is the source of truth
- live SSE is an in-flight augmentation layer, not a complete durable ledger

## 3.4 `system` rows can appear during normal thread usage

Yes.

Current source:

- pre-flight context sync before sending a new user message can insert `system` rows when terminal state changes are detected

Current web behavior:

- the web timeline filters `system` rows out by default unless `config.showSystemMessages` is enabled

So if iOS renders raw history directly, it may see rows that the current web UI usually hides.

## 3.5 Thread titles do not currently auto-change on send/stream completion

I did **not** find any current send/stream path that mutates `thread.title`.

Current automatic thread metadata updates on send/tool/final are:

- `last_activity_at`
- `last_message_preview`
- `message_count`

Those are updated via `recordThreadMessageMetadata(...)`.

So iOS should not expect thread titles to change as a side effect of normal send/stream completion.

## 3.6 Live tool-event correlation is now materially better

This is one of the main backend improvements that landed during this investigation.

Current backend behavior:

- persisted tool messages store `call_id` in `metadata.call_id`
- persisted tool messages now also store a compact server-owned `summary`
- `agent.tool_call` exposes the same stable `call_id`
- `agent.tool_result` exposes both `call_id` and `message_id`
- `agent.tool_result` also exposes `summary` and `output_truncation_reason`
- `agent.tool_result` also carries the canonical persisted tool row under `message`
- `agent.message` exposes `message_id` and the canonical persisted assistant row under `message`
- all live events for a turn share the same `turn_id`

Direct consequence:

- a client can now reconcile healthy connected-turn tool and assistant events to persisted transcript rows using stable backend-provided keys

The current web UI still uses one temporary pending tool row between `agent.tool_call` and `agent.tool_result`, but it no longer has to invent long-lived tool or assistant transcript ids during a healthy connected turn.

## 4. Current Tool Payload Expectations

## 4.1 `terminal.run`

Current persisted tool payload shape:

```json
{
  "tool": "terminal.run",
  "call_id": "call_123",
  "input": "ls\n",
  "summary": "Ran ls",
  "output": "file.txt\n",
  "output_bytes": 9,
  "readiness": {
    "ready": true,
    "confidence": 0.97,
    "trigger": "prompt",
    "hints": {
      "looks_like_prompt": true
    }
  },
  "truncated": false,
  "output_truncation_reason": null,
  "omitted_lines": 0,
  "context": {
    "mode": "shell"
  }
}
```

Important semantics:

- `summary` is the compact server-owned label intended for collapsed UI or transcript previews
- `output` is the decoded text after the service strips ANSI and normalizes line endings
- `output_bytes` is preserved from the Bud-provided run result, so it can differ from the final displayed string length
- `truncated` is passed through from the Bud-provided `terminal_run_result`
- `output_truncation_reason` is `bud_runtime_limit` when a `terminal.run` payload was partial
- the service does **not** impose an additional server-side truncation step on `terminal.run` tool payloads before persisting them

So for `terminal.run`, current truncation is effectively a Bud-side/runtime result, not a separate service-side cap in `AgentService`.

## 4.2 `terminal.capture`

Current behavior:

- persisted with `truncated: false`
- persisted with `output_truncation_reason: null`
- `output_bytes` comes from the capture response
- `summary` is a compact capture label such as `Captured terminal view` or `Captured terminal after waiting for readiness`
- there is no dedicated capture truncation flag beyond `truncated: false` in the current service payload shape

## 4.3 `terminal.interrupt`

Current behavior differs from `terminal.run`:

- the service computes the interrupt tool payload by tailing recent stored terminal output
- the service sets `summary` to `Sent Ctrl+C`
- `output` comes from `tailOutput(...)`
- `output_bytes` reflects total bytes seen in that tailed result set
- `truncated` is derived from whether the recent tail exceeded `TERMINAL_OUTPUT_BACKFILL_BYTES`
- `output_truncation_reason` is `service_backfill_limit` when that backfill tail was partial

Default backfill limit:

- `TERMINAL_OUTPUT_BACKFILL_BYTES`
- default: `4096`

So interrupt tool payloads can legitimately be truncated by the service-side backfill window.

## 4.4 Large terminal output storage versus tool payload truncation are different concerns

The service has a storage soft cap for persisted terminal stream history:

- `TERMINAL_OUTPUT_SOFT_CAP_BYTES`
- default: `100 MB`

That soft cap affects stored terminal output history rows.

It is **not** the same thing as the `metadata.truncated` flag on a tool payload.

For iOS:

- use `metadata.truncated` as the signal for whether the specific tool payload output was partial
- use `metadata.output_truncation_reason` to explain why it was partial
- use `metadata.summary` for compact transcript rows rather than deriving a label from raw tool/input fields
- do not infer tool truncation from the terminal history soft cap alone

## 5. Mobile-Relevant Unknowns And Gaps

## 5.1 Thread-message pagination now exists and web preserves loaded history across canonical refreshes

The backend contract for paged transcript history is now in place.

Current reference web behavior now covers:

- web can prepend older pages with `before=<page.before_cursor>`
- reconnect or suspected-drift paths still refetch the latest canonical page
- those latest-page refreshes now preserve older canonical pages already loaded in the session

So the pagination blocker has moved from backend contract design to replay/resume durability and draft-vs-canonical transcript UI handling.

## 5.2 Assistant text is now truly streamed, but persistence is still a second step

The current backend now emits assistant text deltas.

Today:

- `agent.message_start`
- one or more `agent.message_delta`
- `agent.message_done`
- one canonical `agent.message`
- then one `final`

If iOS wants token-by-token assistant rendering, that backend contract now exists. The remaining UI decision is how to present the temporary draft row before the canonical persisted assistant row replaces it.

## 5.3 Replay is helpful but not a durable resume protocol

Current replay behavior is:

- process-local
- in-memory only
- at-least-once
- vulnerable to stale replay and duplicates

That means clients should continue to reconcile against canonical history after reconnect events or suspected drift. The live stream alone is not sufficient as a durable transcript source.

## 5.4 The current stream now provides strong correlation keys

Because successful live events now carry stable `turn_id`, `call_id`, `message_id`, and canonical `message` rows, clients can do polished in-flight reconciliation without inventing long-lived assistant or tool ids locally. The remaining weak spot is replay/resume durability, not identifier drift.

## 5.5 Web still relies on canonical reconciliation after reconnect or suspected drift

The current web thread view:

- appends one optimistic user row and one temporary pending tool row during the turn
- replaces those temporary ids with backend-provided canonical ids as soon as the POST response and successful SSE payloads arrive
- can now use server-owned tool summaries instead of deriving compact tool labels from raw payload content
- refetches `GET /api/threads/:thread_id/messages?limit=100` on reconnect or suspected drift

That is a real signal about the current backend contract:

- the live stream is strong enough for healthy connected-turn reconciliation
- the live stream is still not treated as a durable resume ledger across reconnects or process restarts

## Direct Answers By Question

### 1. Exact route/query shape for initial message page

Current answer:

```http
GET /api/threads/:thread_id/messages?limit=100
```

Response:

- `{ messages, page }`
- latest page window
- oldest-to-newest within the returned page

### 2. Exact route/query shape for older-page loading

Current answer:

- supported

```http
GET /api/threads/:thread_id/messages?limit=100&before=<page.before_cursor>
```

### 3. Assistant draft events cumulative vs delta

Current answer:

- `agent.message_delta.delta` is incremental
- `agent.message_done.text` is cumulative full draft text
- `agent.message.text` is cumulative full final assistant text on the persisted assistant row

### 4. Stream/transcript gotchas web already handles

Current answer:

- `final` is emitted for success, failure, and cancellation
- replay can include already-seen events
- replay is process-local and in-memory only
- history can contain rows never seen in the live stream
- `system` rows can appear in normal usage
- thread titles do not auto-change on send/stream completion
- web reconciles with canonical history after reconnect or suspected drift

### 5. Current truncation / size-limit rules

Current answer:

- `terminal.run`: `truncated` comes from the Bud-provided run result
- `terminal.run`: `output_truncation_reason` is `bud_runtime_limit` when truncated
- `terminal.capture`: currently persisted with `truncated: false` and `output_truncation_reason: null`
- `terminal.interrupt`: truncation is derived from service-side backfill and reports `output_truncation_reason: "service_backfill_limit"`
- compact tool labels now live in `summary` on both the live `agent.tool_result` payload and the persisted tool-row metadata
- terminal history storage has a separate soft cap (`100 MB` by default) that should not be confused with per-tool payload truncation

## Related Docs

- [reference/AGENT_STREAM_EVENT_FIXTURES.md](./reference/AGENT_STREAM_EVENT_FIXTURES.md)
- [IOS_MOBILE_BACKEND_HANDOFF.md](./IOS_MOBILE_BACKEND_HANDOFF.md)
