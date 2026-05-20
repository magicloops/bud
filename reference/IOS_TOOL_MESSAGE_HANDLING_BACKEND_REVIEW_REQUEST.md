# iOS Tool and Message Handling Backend Review Request

Date: 2026-05-19

## Purpose

This is a request for the backend/runtime team to validate the assumptions iOS is currently making about agent messages, tool calls, persisted tool messages, agent state, and terminal streams.

The immediate trigger was a `web_view.open` payload that used `tool` and `call_id`, but not `name` or `client_id`. iOS has been updated to handle that stream shape for live tool results. A later repro showed a second mobile-side issue: an embedded canonical persisted tool message carried generic `display_role: "Tool"` plus structured `metadata.tool: "web_view.open"`, and iOS was incorrectly preferring the display label as the tool identity. iOS now prefers structured metadata for tool identity, but the investigation exposed broader contract questions. Some fields may be obsolete, aliases may have emerged accidentally, and our current reducers may be duplicating what should be one shared tool envelope.

Please review this doc and mark each assumption as:

- Guaranteed contract.
- Supported but legacy / should migrate.
- Incorrect.
- Unknown / needs backend instrumentation.

## Current iOS Ingestion Surfaces

iOS currently handles tool/message data through four related but separate paths.

### 1. Persisted Transcript Messages

Endpoint:

```text
GET /api/threads/:thread_id/messages
```

DTO path:

```text
MessagePageEnvelopeDTO.messages[] -> MessageDTO -> NetworkChatDTOMapper.mapTurn(_:)
```

Current assumptions:

- `message_id` is always present.
- `client_id` is currently required by iOS for every persisted message row. If absent, iOS drops the message from the transcript.
- `role` is one of `user`, `assistant`, `tool`, or `system`.
- `content` is a string.
- `metadata` is a flat JSON object used to recover tool fields for `role=tool`.
- For `role=tool`, iOS renders a `toolUse` block from:
  - tool name / identity: `metadata.tool`, else `metadata.name`, else `metadata.tool_name`, else `display_role`, else `"Tool"`.
  - summary: `metadata.summary`, else `metadata.output`, else `metadata.input`, else `content`, else `display_role`.
  - status: `metadata.status`, with accepted values `queued`, `running`, `succeeded`, `success`, `failed`, `failure`, `canceled`, `cancelled`; default is `success`.
  - call id: `metadata.call_id`.
  - wait mode: `metadata.wait_for`, `metadata.waitFor`, `metadata.args.wait_for`, or `metadata.args.waitFor`.
  - timing/output fields: `started_at`, `finished_at`, `duration_ms`, `output`, `output_bytes`, `truncated`, `output_truncation_reason`.

Review questions:

- Is `client_id` guaranteed on persisted messages for all roles? If not, should iOS use `message_id` as the row id fallback for all roles?
- For persisted tool messages, is `metadata.tool` the canonical tool name? Should iOS continue accepting `metadata.name` / `metadata.tool_name`, or should those be removed from the fallback list?
- Are any metadata fields above obsolete or incorrectly named?
- Is `display_role` intended to be user-facing display text only? The latest `web_view.open` repro suggests generic values like `"Tool"` should not be treated as authoritative tool identity.
- Should persisted tool messages contain a common structured tool envelope instead of iOS reconstructing one from metadata?

### 2. Agent Stream Events

Endpoint:

```text
GET /api/threads/:thread_id/agent/stream?after=:cursor
```

DTO/reducer path:

```text
SSEFrame -> AgentStreamReducer
```

Current event names iOS recognizes:

- `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.message`
- `agent.resync_required`
- `final`

Current cursor assumptions:

- SSE `id` is the resume/dedup cursor for every non-`heartbeat`, non-`agent.resync_required` event.
- iOS resumes with query parameter `after=<last_event_id>`.
- Duplicate frame ids are skipped locally.
- `agent.resync_required` is not itself used as the next cursor. iOS reloads conversation/agent state and restarts from the fresh agent-state cursor.

Review questions:

- Is `after` the preferred resume mechanism for agent stream, rather than `Last-Event-ID`?
- Are all non-heartbeat event ids globally ordered within a thread stream?
- Should `agent.resync_required` have an event id that iOS stores, or is the current behavior correct?

## Current Live Tool Event Handling

iOS now treats `name` and `tool` as aliases for tool name on:

- `pending_tool`
- `agent.tool_call`
- `agent.tool_result`

Current `agent.tool_call` shape iOS supports:

```json
{
  "id": "optional-event-or-payload-id",
  "turn_id": "optional-agent-turn-id",
  "client_id": "optional-stable-row-id",
  "call_id": "optional-tool-call-id",
  "name": "terminal.send",
  "tool": "terminal.send",
  "args": {},
  "started_at": "2026-05-19T20:00:00.000Z"
}
```

Current `agent.tool_result` shape iOS supports:

```json
{
  "turn_id": "optional-agent-turn-id",
  "client_id": "optional-stable-row-id",
  "call_id": "optional-tool-call-id",
  "message_id": "optional-persisted-message-id",
  "name": "terminal.send",
  "tool": "terminal.send",
  "summary": "Completed",
  "output": "ok",
  "output_bytes": 2,
  "started_at": "2026-05-19T20:00:00.000Z",
  "finished_at": "2026-05-19T20:00:01.000Z",
  "duration_ms": 1000,
  "truncated": false,
  "omitted_lines": 0,
  "output_truncation_reason": null,
  "message": {}
}
```

Identity resolution for live tool rows:

1. `client_id`
2. existing active row by `call_id`
3. existing active row by tool name
4. `call_id`
5. payload `id`
6. `message_id`

Current assumptions:

- `agent.tool_call` means the tool is running.
- `agent.tool_result` means the tool succeeded unless an embedded canonical `message` maps to a persisted tool message whose metadata says otherwise.
- `call_id` is stable across call/result and unique enough within a thread to use as a fallback row id.
- `turn_id` is not currently used for row identity.
- If `agent.tool_result.message` is present and maps to a canonical `MessageDTO`, iOS prefers that canonical message over the synthetic stream tool row.
- When iOS maps an embedded canonical `role=tool` message, structured metadata tool identity takes precedence over generic `display_role` labels.
- If `args.input` is present, iOS uses it as the running summary. Otherwise, iOS summarizes generic args as sorted `key: value` lines.
- `wait_for` / `waitFor` is currently meaningful only for terminal tools, with default `.settled` for `terminal.send`.

Review questions:

- Should `name` or `tool` be canonical going forward? Can backend emit both during migration?
- Is `client_id` still intended to be the stable transcript row id for tools, or should iOS standardize on `call_id` or `message_id`?
- Is `call_id` unique within a thread, globally unique, or only unique within an agent run?
- What is the intended semantic difference between `turn_id`, `client_id`, `call_id`, payload `id`, SSE `id`, and `message_id`?
- Can `agent.tool_result` represent failure/cancellation? If yes, what field carries status? iOS currently ignores top-level result status and marks synthetic results as success.
- Is the embedded `message` field always the durable persisted message shape? Can it omit `client_id`?
- Should the embedded `message.metadata.tool` always match the top-level `name` / `tool` on `agent.tool_result`?
- Are `summary`, `output`, and `args` safe for user-visible rendering? Or should iOS only render backend-provided summaries?
- Are `output_bytes`, `omitted_lines`, and `output_truncation_reason` still current?

## Agent Message Event Handling

Current `agent.message_*` assumptions:

- `agent.message_start` sets the active assistant row id from `client_id`.
- `agent.message_delta` requires `client_id`; if missing, iOS drops the delta.
- `delta` may be either cumulative text or incremental text. iOS attempts to merge both forms.
- `agent.message_done` currently only records the active assistant `client_id`; it does not mark the row completed.
- `agent.message` is the canonical assistant message event. If it contains `message`, iOS maps that persisted message. Otherwise it uses `text` / `message.content` and the active row id.
- `final` marks the active assistant turn completed or failed and clears active tool maps.
- `final.status` values `failed`, `canceled`, and `cancelled` map to failed; all other statuses map to completed.

Review questions:

- Is `delta` intended to be cumulative, incremental, or allowed to be either?
- Should iOS require `client_id` on deltas, or should it fall back to `turn_id`?
- Is `agent.message_done` supposed to carry final content/state that iOS is currently ignoring?
- Is `agent.message` guaranteed before `final`, after `final`, or not guaranteed?
- Is `final` still part of the contract, or is it legacy relative to `agent.message_done` / `agent.message`?
- Should `final` complete tools, assistant messages, or the whole agent run?

## Agent State Handling

Endpoint:

```text
GET /api/threads/:thread_id/agent/state
```

Current assumptions:

- `active` indicates whether an agent run is active.
- `phase` is free text; iOS treats any active phase containing `"tool"` as an active tool phase.
- `stream_cursor` is the cursor iOS should use when opening/reopening the agent stream.
- `pending_tool` uses the same basic fields as live tool call events.
- Although DTO decoding now accepts `pending_tool.tool`, iOS still requires `pending_tool.client_id` when mapping agent state. If `pending_tool` only has `call_id`, it is currently dropped.

Review questions:

- Is `pending_tool.client_id` guaranteed? If not, should iOS apply the same `call_id` fallback here?
- Is `phase` intentionally free text, or should iOS switch to an enum?
- Should `pending_tool` include `status`, `summary`, or a full common tool envelope?
- Does `stream_cursor` point to the next event after current state, or the last durable event included in state?

## Terminal Stream Handling

Endpoint:

```text
GET /api/threads/:thread_id/terminal/stream
```

Current event names iOS recognizes:

- `heartbeat`
- `terminal.output`
- `terminal.status`
- `terminal.ready`
- `terminal.bud_online`
- `terminal.bud_offline`

Current assumptions:

- Terminal stream events are session/output telemetry, not transcript tool-call events.
- Terminal stream resume uses the `Last-Event-ID` header, not the `after` query parameter.
- `terminal.output` uses `data` or `data_base64`; iOS decodes either.
- `terminal.output.seq` and `byte_offset` are optional.
- `terminal.status.state` and `terminal.status.info` are free-form strings.
- `terminal.ready.assessment` may be any JSON and is flattened to display text.
- Agent stream tool calls like `terminal.send` are separate transcript-visible tool events. Terminal stream output is what updates the live terminal UI.

Review questions:

- Should terminal stream continue using a separate event family, or should any terminal tool invocation also share the common tool envelope?
- Is `Last-Event-ID` intentionally different from agent stream's `after` query parameter?
- Are `terminal.ready`, `terminal.bud_online`, and `terminal.bud_offline` current, or legacy?

## Web View Tool Handling

Current web-view assumptions:

- A successful transcript-visible tool named `web_view.open`, `web_proxy.open`, `proxied_site.open`, `proxy.open_web_view`, or similar means a thread web view should be discoverable.
- iOS does not parse human-readable phrases like `"Reused web view"` to infer web-view readiness.
- On a successful web-view-looking tool result, iOS fetches:

```text
GET /api/threads/:thread_id/web-view
```

- If a thread web-view attachment exists, iOS requests a fresh viewer grant and opens the native modal.
- The clean proxied URL is not directly openable until iOS has minted a viewer grant.

Review questions:

- Is `web_view.open` the canonical tool/event name for both create and reuse?
- Should backend emit a dedicated `thread.web_view.updated` event in addition to a transcript tool result?
- Should `agent.tool_result` include the web-view attachment directly, or should iOS always refetch it from `/web-view`?
- Can the tool result arrive before `/web-view` is visible? If yes, iOS should add a bounded retry.

## Known iOS Tech Debt Exposed By This Review

1. Tool schema is duplicated across `AgentPendingToolDTO`, `AgentToolCallEventDTO`, `AgentToolResultEventDTO`, and persisted `MessageDTO.metadata`.
2. Live stream tool rows can now survive without `client_id`, but `pending_tool` and persisted messages still mostly require `client_id`.
3. Top-level `agent.tool_result.status` is not modeled, so synthetic stream results are assumed successful.
4. `turn_id` is decoded but mostly unused; if backend considers it authoritative, iOS is missing that relationship.
5. Generic arg summarization may expose implementation detail or low-quality text. Backend-provided summaries would be cleaner.
6. Tool identity can be present in multiple places (`name`, `tool`, `metadata.tool`, `display_role`), and iOS still needs backend confirmation on the canonical source of truth.
7. Malformed or contract-mismatched stream events are often silently dropped after decode failure. This keeps the UI stable but hides backend/client drift.
8. Tool grouping is a client-side projection of adjacent `role=tool` turns. There is no explicit backend group id.
9. Web-view availability is inferred from a tool row plus a second attachment fetch. A direct attachment update event would be more robust.

## Requested Backend Feedback

Please provide:

1. The canonical envelope for all tool call/result shapes, including required and optional fields.
2. The canonical stable identity field iOS should use for transcript rows.
3. The canonical source of tool identity across live stream payloads and embedded/persisted messages, including whether `display_role` should ever be treated as a machine-readable tool name.
4. Which aliases iOS should keep supporting during migration: `name` vs `tool`, `metadata.tool` vs `metadata.name` / `metadata.tool_name`, `wait_for` vs `waitFor`, `succeeded` vs `success`, `canceled` vs `cancelled`.
5. The intended lifecycle ordering among `agent.tool_call`, `agent.tool_result`, embedded/persisted `message`, `agent.message`, and `final`.
6. A list of fields/events that are deprecated or no longer emitted.
7. Whether terminal stream events should remain separate from the tool envelope.
8. Whether web-view availability should be represented as a tool result, a dedicated stream event, or both.
