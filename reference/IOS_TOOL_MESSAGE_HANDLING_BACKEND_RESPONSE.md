# iOS Tool and Message Handling Backend Response

**Status:** Backend response  
**Last Updated:** 2026-05-19  
**Audience:** Backend, iOS  
**Related docs:** `reference/IOS_TOOL_MESSAGE_HANDLING_BACKEND_REVIEW_REQUEST.md`, `docs/proto.md`, `reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`, `design/message-client-id-and-stable-message-identity.md`

## Summary

The current backend contract is `client_id`-first for first-party transcript/runtime UI identity, `name`-first for live tool event identity, and `metadata.tool`-first for persisted tool message identity.

Short version:

- Use `client_id` as the stable row identity for optimistic, pending, streamed, embedded, and persisted transcript rows.
- Use `message_id` only once a durable row exists, and as a defensive fallback for old or mismatched payloads.
- Use `call_id` to connect one tool call to its result within a turn; do not use it as the primary transcript row id.
- Use live `agent.tool_call.name` / `agent.tool_result.name` for streamed tool identity.
- Use embedded or persisted `message.metadata.tool` for canonical persisted tool identity.
- Treat `display_role` as display text only. It is never a machine-readable tool name.
- Agent SSE and terminal SSE are separate event families. Terminal output telemetry should not be merged into transcript-visible tool rows.

## Assumption Status Matrix

Guaranteed current contract:

- Persisted message rows expose `message_id`, required `client_id`, `role`, string `content`, `metadata`, and `created_at`.
- Current persisted message roles are `user`, `assistant`, `tool`, and `system`.
- Current first-party row identity is `client_id`; `message_id` is durable DB identity.
- Current live tool event identity is `name`.
- Current persisted tool identity is `message.metadata.tool`.
- `agent.tool_call` means a tool is running or waiting for user input.
- `agent.tool_result` means the tool result was recorded durably and sent back into the agent loop.
- `call_id` is stable across `agent.tool_call`, `agent.tool_result`, and persisted `message.metadata.call_id` for the same tool invocation.
- `turn_id` groups one agent turn; it is not a transcript row id.
- `agent.message_delta` is incremental text.
- `final` is still part of the contract and completes the agent turn.
- `/agent/state.stream_cursor` is the cursor to pass to `/agent/stream?after=...`.
- `pending_tool.client_id` is present on current backend snapshots.
- Terminal SSE and agent tool SSE remain separate event families.
- `web_view.open` is the canonical client-facing tool name for creating or reusing a thread web view.

Supported but legacy or migration-only:

- Top-level live `tool` as an alias for `name`.
- `metadata.name` and `metadata.tool_name` as aliases for `metadata.tool`.
- `waitFor` as an alias for `wait_for`.
- `success` as an alias for `succeeded`.
- `cancelled` as an alias for `canceled`.
- `screen_stable` as a historical wait mode normalized to `settled`.
- `shell_ready` as compatibility-only lower-level terminal wait state.
- `terminal.interrupt` historical rows, normalized as `terminal.send` with `key:"ctrl+c"`.
- Old web-view-like aliases such as `web_proxy.open`, `proxied_site.open`, and `proxy.open_web_view`.

Incorrect or risky:

- Using `display_role` as tool identity.
- Matching active tools by tool name.
- Treating a missing top-level `agent.tool_result.status` as proof of underlying tool success.
- Inferring active tool UI from `phase` string contents instead of `pending_tool`.
- Inferring web-view availability from human summary phrases.
- Requiring `session_id` inside current terminal SSE payloads.

Backend gaps or cleanup candidates:

- There is no common first-class tool envelope shared by live events and persisted messages yet.
- There is no top-level `agent.tool_result.status` yet.
- There is no dedicated `thread.web_view.updated` event yet.
- `docs/proto.md` terminal SSE examples include `session_id`, but current terminal SSE implementation omits it on several event payloads.

## Canonical Tool Shapes

### Live `agent.tool_call`

Current backend emits:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_...",
  "name": "terminal.send",
  "args": {},
  "started_at": "2026-05-19T20:00:00.000Z"
}
```

Required for current first-party clients: `turn_id`, `client_id`, `call_id`, `name`, `args`, `started_at`.

`name` is canonical on live stream payloads. The backend does not need clients to read a top-level `tool` field on current `agent.tool_call` events, though iOS can keep accepting `tool` as a migration fallback for older/staged payloads.

### Live `agent.tool_result`

Current backend emits the tool result only after the tool message has been durably inserted:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_...",
  "message_id": "uuid",
  "name": "terminal.send",
  "summary": "Send `git status`; observed terminal output",
  "output_truncation_reason": null,
  "started_at": "2026-05-19T20:00:00.000Z",
  "finished_at": "2026-05-19T20:00:01.000Z",
  "duration_ms": 1000,
  "message": {
    "message_id": "uuid",
    "client_id": "019...",
    "role": "tool",
    "display_role": "Tool",
    "content": "{\"tool\":\"terminal.send\",...}",
    "metadata": {
      "tool": "terminal.send",
      "call_id": "call_...",
      "summary": "Send `git status`; observed terminal output",
      "started_at": "2026-05-19T20:00:00.000Z",
      "finished_at": "2026-05-19T20:00:01.000Z",
      "duration_ms": 1000
    },
    "created_at": "2026-05-19T20:00:01.000Z"
  }
}
```

Terminal results may also include top-level `output`, `output_bytes`, `readiness`, `truncated`, and `omitted_lines`. For `terminal.send`, detailed evidence usually lives in `message.metadata.delta`; top-level `output` may be absent. Web-view results include top-level `web_view` instead of terminal output fields. `ask_user_questions` results include top-level `user_questions`.

Current backend does not emit top-level `status` on `agent.tool_result`. A result means "the backend completed and recorded a tool result for model replay", not necessarily that the underlying user task succeeded. For warning/error display, inspect the embedded canonical message, especially `message.metadata.error`, `message.metadata.readiness.trigger`, or `web_view.error`.

### Persisted Tool Message

`GET /api/threads/:thread_id/messages` returns canonical message rows:

```json
{
  "message_id": "uuid",
  "client_id": "019...",
  "role": "tool",
  "display_role": "Tool",
  "content": "{\"tool\":\"web_view.open\",...}",
  "metadata": {
    "tool": "web_view.open",
    "call_id": "call_...",
    "summary": "Reused web view for localhost:5173/; static HTTP and WebSocket/HMR are available",
    "kind": "web_view",
    "action": "open",
    "web_view": {},
    "proxied_site": {},
    "transport": {},
    "websocket_transport": {},
    "started_at": "2026-05-19T20:00:00.000Z",
    "finished_at": "2026-05-19T20:00:01.000Z",
    "duration_ms": 1000
  },
  "created_at": "2026-05-19T20:00:01.000Z"
}
```

`metadata.tool` is the canonical persisted tool name. `content` is a JSON string used for model replay and also carries `tool` and `call_id`, but clients should prefer `metadata` for display/projection. `display_role` is intentionally generic and should only be shown as a label.

Persisted tool rows do not currently expose a common first-class `tool` envelope separate from `metadata`. That would be a reasonable future cleanup, but it is not the current API.

### Persisted Tool Metadata Field Notes

The iOS metadata fallback list should be adjusted to these current expectations:

- `metadata.tool`: current canonical persisted tool name.
- `metadata.name` / `metadata.tool_name`: legacy fallback only.
- `metadata.call_id`: current call/result link.
- `metadata.summary`: current preferred user-visible compact description.
- `metadata.status`: not emitted for current tool rows.
- `metadata.input`: not a current canonical field; terminal send input is represented by flattened args such as `text`, `submit`, and `key`.
- `metadata.args`: not the current persisted shape; current tool args are flattened into metadata/content.
- `metadata.wait_for`: current terminal wait field; `waitFor` is legacy fallback only.
- `metadata.output`: current only for terminal observations or tools that produce an explicit output field; it may be absent for `terminal.send`.
- `metadata.delta`: current terminal-send evidence, when available.
- `metadata.output_bytes`, `metadata.truncated`, `metadata.omitted_lines`, `metadata.output_truncation_reason`: current terminal fields, usually absent for web-view and user-question tools.
- `metadata.started_at`, `metadata.finished_at`, `metadata.duration_ms`: current authoritative service timing fields.
- `metadata.path_context_before` / `metadata.path_context_after`: current optional terminal cwd context fields for file-link resolution.

`message.metadata.tool` should match top-level `agent.tool_result.name` for the same event. A mismatch should be treated as backend drift; iOS should prefer the embedded canonical message once present.

`summary` is intended to be safe as row-level display text. `args`, `output`, and `delta.text` can contain user commands or raw terminal/program output, so they are better suited for expanded details than primary compact UI.

## Identity Fields

| Field | Meaning | Client use |
| --- | --- | --- |
| SSE `id:` | Opaque runtime resume cursor | Store as stream cursor for resume. Do not use as row identity. |
| `turn_id` | One agent turn/run | Group draft/tool/final lifecycle and clear overlays on `final`. |
| `client_id` | Stable public/UI message identity | Primary row key for optimistic, pending, streamed, embedded, and persisted transcript rows. |
| `call_id` | Provider tool-call id | Link `agent.tool_call` to `agent.tool_result`; use with `turn_id` if forced to fall back. |
| `message_id` | Durable DB message row id | Use for server APIs, read watermarks, debug, and fallback row identity for transitional data. |
| payload `id` | Not part of the current agent-event contract | Ignore if seen in legacy payloads. |

Current schema requires `message.client_id`, and current assistant/tool stream emissions allocate `client_id` before the first runtime event. iOS should not normally see persisted rows, `pending_tool`, or embedded messages without `client_id`. Keeping `message_id` fallback is still prudent for historical/staged payloads, but dropping rows solely because a transitional payload lacks `client_id` is brittle.

`call_id` should be considered unique within one provider response/agent turn, not globally unique. In practice it is stable enough to link a live call/result pair, but fallback row identity should combine it with `turn_id` when possible.

Do not match pending/live tool rows by tool name. Repeated `terminal.send` calls are normal. Fallback identity should be `client_id`, then `(turn_id, call_id)`, then `call_id`, then `message_id`. Matching by `name`/`tool` can merge unrelated calls.

## Agent Stream Resume

For mobile, `after=<cursor>` is the preferred explicit resume mechanism. The backend also accepts `Last-Event-ID` and `last_event_id` for compatibility. Current implementation resolves cursor inputs in this order:

1. `Last-Event-ID`
2. `after`
3. `last_event_id`

So iOS should avoid sending more than one cursor source on the same request.

All replayable agent-stream events get an SSE `id:` cursor from the thread runtime cursor space. That includes `agent.message_*`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `thread.title`, and `final`. `heartbeat` does not advance the cursor. `agent.resync_required` currently has no event id, closes the response after it is sent, and should not be stored as the next cursor.

Agent-stream cursors are ordered within the thread/runtime stream on the current service instance. They are opaque and intentionally not durable transcript history.

## Assistant Message Events

Current semantics:

- `agent.message_start`: starts a client-side draft assistant row keyed by `client_id`.
- `agent.message_delta`: incremental text delta, not cumulative text. iOS can keep tolerant merge logic, but backend intent is incremental.
- `agent.message_done`: carries the full draft text before canonical persistence. It is not the durable transcript row.
- `agent.message`: canonical persisted assistant row. It includes `message_id`, `client_id`, `text`, and embedded `message`.
- `final`: active turn completion status. Still current, not legacy.

On successful final assistant output, backend emits `agent.message` before `final`. On failure or cancellation, `final` may arrive without a preceding `agent.message`. Intermediate visible assistant text before later tool calls is also emitted as `agent.message` and has `message.metadata.segment_kind: "intermediate"`.

`final` completes the agent run and should clear active draft/tool overlays for that `turn_id`. Tool rows complete on `agent.tool_result`; assistant durable rows reconcile on `agent.message`.

Current emitted `final.status` values are `succeeded`, `failed`, and `canceled`. Accepting `cancelled` as a client-side alias is fine, but backend emits `canceled`.

## Agent State

`GET /api/threads/:thread_id/agent/state` returns the authoritative current in-flight snapshot:

- `active`
- `turn_id`
- `phase`
- `can_cancel`
- `stream_cursor`
- `pending_tool`
- `draft_assistant`
- `updated_at`

`pending_tool.client_id` is guaranteed by the current backend and matches the later `agent.tool_result.client_id` and persisted tool `message.client_id`. Keeping a `call_id` fallback is acceptable for old payloads, but current iOS logic that drops `pending_tool` without `client_id` should be considered defensive rather than required by contract.

`phase` is a small backend enum today: `idle`, `starting`, `thinking`, `tool_running`, `waiting_for_user`, `streaming_message`. Clients should still project from fields, not string matching. Render a pending tool because `pending_tool` is present, not because `phase` contains `"tool"`.

`stream_cursor` is the cursor for all runtime effects included in the snapshot. Opening `/agent/stream?after=<stream_cursor>` should deliver only effects after that snapshot boundary or return `agent.resync_required`.

## Terminal Stream

Terminal stream events stay separate from transcript-visible agent tool events.

- `agent.tool_call` / `agent.tool_result` explain what the agent did.
- `terminal.output` / `terminal.status` / `terminal.ready` update the live terminal UI.

`GET /api/threads/:thread_id/terminal/stream` currently resumes through `Last-Event-ID` or `last_event_id`. It does not use the agent stream's `after` query parameter. Terminal SSE replay is an in-memory convenience only; historical terminal bytes come from `/api/threads/:thread_id/terminal/history`.

Current terminal events are still active: `terminal.output`, `terminal.status`, `terminal.ready`, `terminal.bud_online`, `terminal.bud_offline`, and `heartbeat`.

Implementation note: current terminal SSE payloads are emitted on a per-session channel and do not consistently include `session_id` in `terminal.output`, `terminal.status`, or `terminal.ready`, even though examples in `docs/proto.md` show it. iOS should not require `session_id` on those events right now; use the attached thread/session context. Current live output uses `data` as base64. History uses `data_base64`.

## Web View Tools

The canonical client-facing tool name is `web_view.open` for both create and reuse. The model-facing provider tool is `web_view_open`, but clients should not see that name in agent stream or persisted transcript rows.

Current backend web-view tools are:

- `web_view.open`
- `web_view.close`
- `web_view.list`

Older names such as `web_proxy.open`, `proxied_site.open`, and `proxy.open_web_view` are not emitted by current backend. iOS can keep defensive aliases temporarily, but product logic should converge on `web_view.open`.

Current `agent.tool_result` for a web-view open includes a top-level `web_view` payload plus the embedded persisted tool message. That payload is useful for immediate UI state, but iOS should still fetch `GET /api/threads/:thread_id/web-view` before opening the modal because viewer grants are minted through the web-view/proxied-site API, not through the tool result.

By the time `agent.tool_result` is emitted, the thread web-view attachment should already be durable and visible to `/web-view`. A small bounded retry on iOS is reasonable as deployment/proxy defense, but a persistent miss after a successful `web_view.open` result should be treated as backend drift.

There is no dedicated `thread.web_view.updated` agent-stream event today. Adding one later would make native projection cleaner, but the current contract is tool result plus `/web-view` refetch.

## Alias And Deprecation Guidance

| Shape | Backend position | iOS guidance |
| --- | --- | --- |
| live `name` | Canonical live tool identity | Prefer it. |
| live `tool` | Legacy/transitional alias | Accept defensively; do not require. |
| `metadata.tool` | Canonical persisted tool identity | Prefer it. |
| `metadata.name` / `metadata.tool_name` | Legacy fallback only | Keep temporarily if useful, but do not treat as current. |
| `display_role` | User-facing label | Never use as machine-readable tool identity. |
| `wait_for` | Canonical snake_case | Prefer it. |
| `waitFor` | Client-side legacy alias | Accept defensively only. |
| `settled`, `changed`, `none` | Current terminal wait modes | Current contract. |
| `screen_stable` | Legacy alias normalized to `settled` | Accept for old rows only. |
| `shell_ready` | Compatibility-only lower-level wait | Not advertised to model or first-party clients. |
| `succeeded` | Current final success status | Prefer it. |
| `success` | Legacy status alias | Accept defensively only. |
| `canceled` | Current spelling | Prefer it. |
| `cancelled` | Alias | Accept defensively only. |
| `terminal.interrupt` | Deprecated persisted historical tool | Treat as legacy `terminal.send` with `key:"ctrl+c"`. |
| `shell.run` | Deprecated | Do not build new client logic around it. |

## Out-Of-Date Or Risky iOS Logic

- Treating `display_role` as a tool name is incorrect. It should be display-only.
- Matching active tool rows by tool name is risky. Use `client_id` or `(turn_id, call_id)`.
- Assuming a synthetic `agent.tool_result` is successful because top-level `status` is absent is too coarse. Check the embedded canonical message for `metadata.error` and tool-specific error fields.
- Reconstructing user-visible tool text from generic sorted args should be a fallback only. Prefer backend `summary`.
- Treating `phase` as free text and searching for `"tool"` should be replaced with field-driven projection from `pending_tool`.
- Requiring `client_id` on current persisted messages and pending tools matches the current contract, but iOS should keep `message_id` or `(turn_id, call_id)` fallback to avoid dropping old/staged payloads.
- Inferring web-view readiness from phrases such as `"Reused web view"` is unnecessary. Use `name == "web_view.open"`, the `web_view` payload, and `/web-view`.
- Keeping `web_proxy.open` / `proxied_site.open` / `proxy.open_web_view` aliases is only a compatibility hedge. They are not current backend names.
- Silent decode drops should become visible in mobile diagnostics. Unknown fields should be ignored, but missing required fields for current contracts should be logged with event name, SSE id, thread id, and redacted payload keys.

## Source Trail

Most relevant backend files:

- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/web-view-tool-executor.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/terminal.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/terminal/output-store.ts`
- `service/src/db/schema.ts`
