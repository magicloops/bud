# Handoff: Mobile Context Compaction UI

Status: Current branch contract

Audience: iOS / mobile team

Last updated: 2026-05-25

Reviewed against: `auto-compaction` branch compared to `origin/main`

Related backend source:

- `docs/proto.md`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/models.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/agent/context-budget-state.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/context-budget.ts`
- `service/src/agent/context-compactor.ts`
- `service/src/agent/agent-service.ts`
- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/context-budget-meter-state.ts`
- `web/src/components/workbench/context-send-button.tsx`

## 1. Executive Summary

This branch adds automatic model-context compaction plus web UI affordances for
showing context usage and compaction activity.

Mobile does not need to implement compaction itself. The service owns all
checkpointing, summarization, token estimates, and model replay boundaries.

Mobile should implement three client behaviors:

1. Read and render `context_budget` from `GET /api/threads/:thread_id/agent/state`.
2. Listen for `agent.compaction_start`, `agent.compaction_done`, and
   `agent.compaction_failed` on the existing thread agent SSE stream.
3. Show compaction as activity or a non-transcript marker, never as a persisted
   chat message.

The visible transcript is unchanged by automatic compaction. Older messages
remain available through normal `/messages` pagination. Compaction only changes
the service-owned model-visible replay state used for future LLM requests.

There is no public manual "compact now" endpoint in this branch.

All new browser/mobile payload fields use Bud's normal API convention:
snake_case at the HTTP/SSE boundary. Swift models should decode these fields
with explicit `CodingKeys` or a snake_case decoding strategy.

## 2. Branch Review Summary

Compared to `origin/main`, this branch adds:

- A durable `agent_context_checkpoint` table and migration
  `service/drizzle/migrations/0021_worried_luminals.sql`.
- Conversation loading that starts from the fresh system prompt, latest completed
  checkpoint replacement history, and post-checkpoint transcript/provider-ledger
  deltas.
- A local summary compactor that writes service-owned checkpoints and keeps raw
  summaries/replacement history out of browser APIs.
- Automatic pre-turn and mid-turn compaction checks, plus one forced compaction
  retry after normalized provider context-window errors.
- `/agent/state.context_budget`, backed by the same budget estimate used by the
  backend compaction trigger.
- Additive agent SSE events for compaction activity.
- `/api/models` capability fields for hard context window, Bud usable context
  window, output reserve, and usable input window.
- Web UI state for a context meter, active "Compacting context..." indicator,
  post-compaction budget refresh, and subtle non-transcript timeline markers.

## 3. Core Concepts

### Visible Transcript

The durable user-visible chat history returned by:

```http
GET /api/threads/:thread_id/messages
```

Automatic compaction does not delete, hide, rewrite, or append visible transcript
rows.

### Model-Visible Context

The reconstructed input the service sends to the selected model. It includes the
current Bud Agent system prompt, tool schemas, checkpoint replacement history if
one exists, post-checkpoint transcript rows, and provider-ledger items where
applicable.

Mobile must not try to reconstruct or count this context locally.

### Context Checkpoint

A service-owned durable record that stores:

- a raw summary,
- provider-neutral replacement history,
- compacted-through transcript and provider-ledger boundaries,
- token estimates,
- owner stamps.

Checkpoint summaries may contain user data and terminal output. They are not
exposed through normal browser/mobile routes.

### Context Budget

The client-safe estimate returned in `/agent/state.context_budget`.

The primary meter fields are authoritative for the backend compaction trigger.
The UI should use `percent_of_context_budget`, not a locally computed ratio.

## 4. API Surfaces Mobile Needs

### 4.1 Model List

```http
GET /api/models
```

This route is authenticated. It returns model capability metadata used by model
pickers and details sheets.

Response shape:

```json
{
  "models": [],
  "service_default_model": "gpt-5.5",
  "default_model": "gpt-5.5",
  "default_reasoning_effort": "low"
}
```

Context-related fields per model:

```json
{
  "id": "gpt-5.5",
  "provider": "openai",
  "provider_model": "gpt-5.5",
  "display_name": "GPT-5.5",
  "is_default": true,
  "capabilities": {
    "vision": true,
    "tools": true,
    "streaming": true,
    "structured_outputs": true,
    "context_window_tokens": 1050000,
    "usable_context_window_tokens": 400000,
    "reserved_output_tokens": 128000,
    "usable_input_window_tokens": 272000,
    "max_output_tokens": 128000
  },
  "reasoning": {
    "levels": [
      { "value": "none", "label": "Fast" },
      { "value": "low", "label": "Low" }
    ],
    "default_level": "low"
  }
}
```

Use these fields for display only. Do not compute the thread context meter from
`/api/models`; use `/agent/state.context_budget`.

Nullability:

- `context_window_tokens` and `max_output_tokens` are always numbers.
- `usable_context_window_tokens`, `reserved_output_tokens`, and
  `usable_input_window_tokens` can be `null` if the service cannot resolve a
  valid Bud context policy for that model.

### 4.2 Agent State

```http
GET /api/threads/:thread_id/agent/state
```

This is the bootstrap and recovery source for runtime state and context budget.

Relevant response shape:

```json
{
  "active": true,
  "turn_id": "01J...",
  "phase": "thinking",
  "can_cancel": true,
  "stream_cursor": "01J...",
  "pending_tool": null,
  "draft_assistant": null,
  "context_budget": {
    "status": "available",
    "model": "gpt-5.5",
    "provider": "openai",
    "context_window_tokens": 1050000,
    "usable_context_window_tokens": 400000,
    "reserved_output_tokens": 128000,
    "usable_input_window_tokens": 272000,
    "compaction_enabled": true,
    "compaction_threshold_ratio": 0.95,
    "compaction_threshold_tokens": 258400,
    "effective_budget_tokens": 258400,
    "message_estimated_tokens": 15142,
    "tool_schema_tokens": 426,
    "estimated_input_tokens": 15568,
    "remaining_context_tokens": 242832,
    "percent_of_context_budget": 0.060247678,
    "percent_of_model_window": 0.014826667,
    "basis": "model_agnostic_estimate",
    "confidence": "medium",
    "source": "active_agent_decision",
    "phase": "pre_turn",
    "reason": "context_limit",
    "turn_id": "01J...",
    "checked_at": "2026-05-25T17:10:00.000Z",
    "stale": false,
    "updated_at": "2026-05-25T17:10:00.000Z",
    "latest_checkpoint_id": null,
    "compacted_through_message_id": null,
    "compacted_through_llm_call_id": null
  },
  "updated_at": "2026-05-25T17:10:00.000Z"
}
```

Important route behavior:

- If a turn is active and runtime has an active budget decision, the service
  returns that active decision.
- Otherwise the service recomputes a durable snapshot from persisted state.
- If the service cannot build a budget, it returns an `unknown` snapshot rather
  than failing the whole agent-state route.
- The field is optional for compatibility. Treat `context_budget: null` or a
  missing field the same as "no current budget snapshot" in UI.

### 4.3 Agent Stream

```http
GET /api/threads/:thread_id/agent/stream?after=<stream_cursor>
```

The existing stream now emits these additional events:

- `agent.compaction_start`
- `agent.compaction_done`
- `agent.compaction_failed`

These events share the same SSE frame `id:` cursor space as all other agent
events. Store the frame id as the next resume cursor after successfully applying
the event.

The service accepts the cursor through `after`, `last_event_id`, or the standard
`Last-Event-ID` request header. Mobile should keep using the same cursor path it
uses for the rest of the agent stream.

Do not advance the stored cursor on `heartbeat`. Commit the new cursor only
after the event payload has decoded and the reducer has applied it. If the
server sends `agent.resync_required`, refetch `/messages` plus `/agent/state`
and reconnect with the new `stream_cursor`.

### 4.4 Message Send And Model Changes

After sending a message:

```http
POST /api/threads/:thread_id/messages
```

Refresh `/agent/state` after the message is accepted. This lets the context
meter include the new durable user message and gives mobile the correct stream
cursor for active-turn attachment.

After changing model or reasoning:

```http
PATCH /api/threads/:thread_id/model-preference
```

Refresh `/agent/state` after the patch succeeds. The context budget is tied to
the selected model's policy.

## 5. Context Budget Contract

### 5.1 Available Snapshot

```ts
type ApiContextBudgetAvailable = {
  status: "available";
  model: string;
  provider: string;
  context_window_tokens: number;
  usable_context_window_tokens: number;
  reserved_output_tokens: number;
  usable_input_window_tokens: number;
  compaction_enabled: boolean;
  compaction_threshold_ratio: number;
  compaction_threshold_tokens: number;
  effective_budget_tokens: number;
  message_estimated_tokens: number;
  tool_schema_tokens: number;
  estimated_input_tokens: number;
  remaining_context_tokens: number;
  percent_of_context_budget: number;
  percent_of_model_window: number;
  basis: "model_agnostic_estimate" | "provider_usage_trigger" | "provider_token_count";
  confidence: "low" | "medium" | "high";
  source: "durable_reconstruction" | "active_agent_decision" | "compaction_event" | "unknown";
  phase: "idle" | "pre_turn" | "mid_turn" | "standalone_turn" | null;
  reason: "context_limit" | "context_error_retry" | "model_downshift" | "user_requested" | null;
  turn_id: string | null;
  checked_at: string | null;
  stale: boolean;
  updated_at: string;
  latest_checkpoint_id: string | null;
  compacted_through_message_id: string | null;
  compacted_through_llm_call_id: string | null;
  provider_usage_estimate?: {
    estimated_input_tokens: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    delta_tokens: number;
    llm_call_id: string;
    confidence: "medium" | "high";
  } | null;
};
```

Field notes:

- `estimated_input_tokens` is the primary backend estimate. It equals
  `message_estimated_tokens + tool_schema_tokens`.
- `tool_schema_tokens` is included because ordinary agent turns send the normal
  agent tool schemas to the provider.
- `percent_of_context_budget` is the primary visual ratio.
- `percent_of_model_window` is diagnostic. Do not use it for the main meter.
- `basis` describes the primary estimate. In this branch the primary basis is
  usually `model_agnostic_estimate`.
- `provider_usage_estimate` is optional calibration/debug data. Do not render it
  in the product context meter.
- `source` explains where the snapshot came from:
  - `durable_reconstruction`: computed from persisted rows/checkpoint.
  - `active_agent_decision`: latest active backend compaction decision.
  - `compaction_event`: post-compaction snapshot from `agent.compaction_done`.
  - `unknown`: reserved fallback.
- `stale: true` means the estimate is safe to show, but active in-memory agent
  work may have moved ahead. Use copy like "Refreshing after this turn settles."
- `latest_checkpoint_id` means the service has already compacted earlier model
  context. Treat it as diagnostic; do not show raw ids in normal UI.
- Token fields can be large. Use 64-bit integer storage in Swift models.
- Percent fields are ratios, not percentage integers. `0.42` means `42%`.

### 5.2 Unknown Snapshot

```ts
type ApiContextBudgetUnknown = {
  status: "unknown";
  model: string;
  provider: string | null;
  reason:
    | "unknown_model_context_window"
    | "invalid_context_policy"
    | "conversation_unavailable"
    | "count_failed";
  source: "durable_reconstruction" | "active_agent_decision" | "compaction_event" | "unknown";
  phase: "idle" | "pre_turn" | "mid_turn" | "standalone_turn" | null;
  turn_id: string | null;
  checked_at: string | null;
  stale: boolean;
  updated_at: string;
};
```

UI rule:

- Show `Context unknown` or equivalent.
- Do not block message send.
- Do not hide the composer.
- Treat absent/null `context_budget` the same as an unavailable snapshot, but
  without an explicit unknown reason.

### 5.3 Budget Formula

The backend formula is:

```text
usable_input_window_tokens =
  usable_context_window_tokens - reserved_output_tokens

compaction_threshold_tokens =
  floor(usable_input_window_tokens * compaction_threshold_ratio)

effective_budget_tokens =
  compaction_enabled
    ? compaction_threshold_tokens
    : usable_input_window_tokens

remaining_context_tokens =
  max(0, effective_budget_tokens - estimated_input_tokens)

percent_of_context_budget =
  estimated_input_tokens / effective_budget_tokens
```

Mobile should not recompute these fields. This formula is included so the
meaning of the numbers is clear.

Current GPT-5.5 example:

```text
hard model window:          1,050,000
Bud usable context window:    400,000
reserved output:              128,000
usable input window:          272,000
ratio:                           0.95
auto-compact threshold:       258,400
```

The ratio is configurable on the service and clamped to at most `0.95`. Do not
hardcode `0.95` in the mobile UI; display the server value.

All numbers in the meter are backend estimates. They are intended to match the
backend compaction trigger, not exact provider billing tokens.

## 6. Compaction SSE Events

### 6.1 `agent.compaction_start`

Emitted when automatic model-visible compaction begins. No transcript row is
created.

```json
{
  "turn_id": "01J...",
  "trigger": "auto",
  "reason": "context_limit",
  "phase": "pre_turn",
  "tokens_before": 260112,
  "threshold_tokens": 258400,
  "context_window_tokens": 1050000,
  "usable_context_window_tokens": 400000,
  "reserved_output_tokens": 128000,
  "usable_input_window_tokens": 272000,
  "effective_budget_tokens": 258400,
  "started_at": "2026-05-25T17:10:00.000Z"
}
```

Client behavior:

- Show active work, for example `Compacting context...`.
- Do not create a message row.
- Do not assume where this appears relative to draft assistant/tool events.
- Treat nullable budget fields in this event as "budget unavailable for this
  compaction attempt". The event is still valid.

### 6.2 `agent.compaction_done`

Emitted after the completed checkpoint is persisted.

```json
{
  "turn_id": "01J...",
  "trigger": "auto",
  "reason": "context_limit",
  "phase": "pre_turn",
  "tokens_before": 260112,
  "threshold_tokens": 258400,
  "context_window_tokens": 1050000,
  "usable_context_window_tokens": 400000,
  "reserved_output_tokens": 128000,
  "usable_input_window_tokens": 272000,
  "effective_budget_tokens": 258400,
  "started_at": "2026-05-25T17:10:00.000Z",
  "checkpoint_id": "01J...",
  "tokens_after": 12000,
  "finished_at": "2026-05-25T17:10:09.000Z",
  "context_budget": null
}
```

`context_budget` is nullable and optional. When present, it uses the full
snapshot shape from section 5 with `source: "compaction_event"`; it never
contains raw checkpoint summaries or replacement history.

Client behavior:

- Clear active compaction UI.
- If `context_budget` is present, apply it immediately.
- Also refresh `/agent/state` soon after, because `/agent/state` is the recovery
  source if the event was missed or the stream replay window expires.
- Optionally add a local non-transcript timeline marker such as
  `Context compacted - 260k -> 12k`.
- Dedupe local completion markers by `checkpoint_id`.

### 6.3 `agent.compaction_failed`

Emitted after a failed checkpoint attempt is recorded when possible.

```json
{
  "turn_id": "01J...",
  "trigger": "auto",
  "reason": "context_error_retry",
  "phase": "mid_turn",
  "tokens_before": 280901,
  "threshold_tokens": 258400,
  "context_window_tokens": 1050000,
  "usable_context_window_tokens": 400000,
  "reserved_output_tokens": 128000,
  "usable_input_window_tokens": 272000,
  "effective_budget_tokens": 258400,
  "started_at": "2026-05-25T17:10:00.000Z",
  "error_code": "context_compaction_failed",
  "retryable": false,
  "finished_at": "2026-05-25T17:10:09.000Z"
}
```

Known error codes in this branch:

- `context_window_exceeded`
- `empty_summary`
- `context_compaction_failed`

Client behavior:

- Clear active compaction UI.
- Optionally add a local non-transcript marker such as
  `Context compaction failed`.
- Keep normal `final` handling. The `final` event still determines whether the
  agent turn ultimately succeeded, failed, or was canceled.
- Dedupe local failure markers by a deterministic local key such as
  `turn_id + phase + finished_at`.

### 6.4 Enum Values

Current automatic compaction mostly emits:

- `trigger: "auto"`
- `phase: "pre_turn"` or `"mid_turn"`
- `reason: "context_limit"` or `"context_error_retry"`

Other enum values are reserved or future-facing:

- `trigger`: `manual`, `model_downshift`
- `phase`: `standalone_turn`
- `reason`: `model_downshift`, `user_requested`

Mobile should decode unknown future enum values without crashing. A safe Swift
implementation should either use string-backed enums with an `unknown(String)`
case or keep raw strings in the transport layer and map known cases in UI code.

All timestamps are ISO-8601 strings generated by the service.

## 7. Recommended Mobile Flows

### 7.1 Thread Open

Use the existing state-first agent stream model:

1. Fetch latest messages:
   ```http
   GET /api/threads/:thread_id/messages?limit=<n>
   ```
2. Fetch agent state:
   ```http
   GET /api/threads/:thread_id/agent/state
   ```
3. Render transcript from `/messages`.
4. Overlay pending runtime rows from `/agent/state` as before.
5. Store `agent_state.context_budget` in thread UI state.
6. Attach stream:
   ```http
   GET /api/threads/:thread_id/agent/stream?after=<agent_state.stream_cursor>
   ```

No-cursor stream attach is live-only. For normal thread open, use the state
cursor.

The ordering matters: fetch `/agent/state` before opening the stream so the
client has both the current runtime overlays and the correct resume cursor.

### 7.2 Message Send

After `POST /messages` succeeds:

1. Reconcile the optimistic user message with the canonical response.
2. Refresh `/agent/state`.
3. Apply `context_budget`.
4. Store the returned `stream_cursor`.
5. Ensure the agent stream is attached using that cursor.

### 7.3 Reconnect And Resync

On a normal stream disconnect:

1. Reconnect with the latest stored cursor.
2. If resumed, apply newer events and continue.
3. If `agent.resync_required` arrives, refetch `/messages` and `/agent/state`.
4. Reattach with the new `stream_cursor`.

Missed compaction events are safe. The durable recovery path is:

- `/messages` for visible transcript,
- `/agent/state.context_budget` for current budget,
- `/agent/state.stream_cursor` for stream resume.

The in-memory replay window is intentionally bounded. Treat compaction notices
as live activity markers, not durable history.

On app cold start, do not attempt to restore compaction notices from the visible
message list. Rebuild the transcript from `/messages` and the current budget
from `/agent/state`.

### 7.4 Model Or Reasoning Change

After model or reasoning selection changes:

1. Persist the preference through the existing thread model-preference route.
2. Refresh `/agent/state`.
3. Apply the new `context_budget`.

The same visible transcript can have a different budget under a different
model, because each model has its own usable window and output reserve.

## 8. Recommended Mobile UI

### 8.1 Placement

Use a compact chip, ring, or progress indicator near the composer send button,
model selector, or thread status area.

Suggested default collapsed copy:

- `Context 42%`
- `Compact soon` when near threshold
- `Context unknown` when unavailable
- `Compacting` while `activeCompaction != nil`

Tapping the control should open a detail sheet.

### 8.2 Visual Thresholds

Use the server-provided `percent_of_context_budget`.

Suggested tones:

| Percent | Tone | Suggested Copy |
| --- | --- | --- |
| unknown | unavailable | `Context unknown` |
| `< 70%` | normal | `Context 42%` |
| `70% - < 85%` | elevated | `Context 78%` |
| `85% - < 100%` | near | `Compact soon` or `Context 91%` |
| `>= 100%` | over | `Compacting soon` or `Over budget` |

Clamp visual progress to `0...100%`, but do not mutate the raw ratio in state.
It is valid for `percent_of_context_budget` to exceed `1`.

### 8.3 Detail Sheet

Suggested available-state details:

- selected model, for example `GPT-5.5`
- `155k used of 258k`
- `103k remaining before auto-compaction`
- `Bud cap 400k`
- `Output reserve 128k`
- `Usable input window 272k`
- `Hard model window 1.05m`
- `Messages 151k, tool schemas 4k` when `tool_schema_tokens > 0`
- `Backend estimate, medium confidence`
- source and phase, for example `Active agent decision, pre-turn`
- `Already compacted earlier context` when `latest_checkpoint_id != nil`
- stale copy when `stale == true`

If `compaction_enabled == false`, avoid "before auto-compaction" copy. Use
"remaining in usable input window" instead.

Do not show raw checkpoint ids, raw summaries, replacement history, or provider
usage diagnostics in the product UI.

The web implementation intentionally omits `provider_usage_estimate` from the
normal tooltip. Mobile should do the same unless a separate debug surface is
explicitly added.

### 8.4 Timeline Markers

Mobile may render compaction completion/failure as a subtle local marker in the
chat timeline, but it must not be a message entity.

Recommended marker:

```text
Context compacted - Pre-turn - 260k -> 12k
```

Failure marker:

```text
Context compaction failed - Mid-turn
```

These markers can be ephemeral. It is acceptable for them to disappear after a
full app restart or full transcript refetch unless product wants local-only
activity history.

### 8.5 Active Compaction

While `agent.compaction_start` is active and before done/failed:

- show `Compacting context...` in the same activity area used for agent thinking,
  or a compact status chip,
- keep the stream connected,
- do not disable normal transcript rendering,
- do not show it as `waiting_for_user`.

If another active compaction start arrives before a done/failed event, replace
the active compaction state with the newer start event.

## 9. Reducer Pseudocode

State shape:

```swift
struct ThreadRuntimeUIState {
    var contextBudget: ContextBudget?
    var activeCompaction: AgentCompactionStartEvent?
    var compactionNotices: [CompactionNotice]
    var streamCursor: String?
}
```

Agent-state bootstrap:

```swift
func applyAgentState(_ state: AgentState) {
    streamCursor = state.streamCursor
    contextBudget = state.contextBudget
    applyPendingToolOverlay(state.pendingTool)
    applyDraftAssistantOverlay(state.draftAssistant)
}
```

SSE cursor handling:

```swift
func applySSE(eventName: String, id: String?, data: Data) {
    if eventName == "heartbeat" {
        return
    }

    switch eventName {
    case "agent.compaction_start":
        let event = decode(AgentCompactionStartEvent.self, data)
        activeCompaction = event

    case "agent.compaction_done":
        let event = decode(AgentCompactionDoneEvent.self, data)
        activeCompaction = nil
        if let budget = event.contextBudget {
            contextBudget = budget
        }
        appendNotice(.contextCompacted(
            id: "context-compaction:\(event.checkpointId)",
            phase: event.phase,
            createdAt: event.finishedAt,
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter
        ))
        refreshAgentStateSoon()

    case "agent.compaction_failed":
        let event = decode(AgentCompactionFailedEvent.self, data)
        activeCompaction = nil
        appendNotice(.contextCompactionFailed(
            id: "context-compaction-failed:\(event.turnId):\(event.phase):\(event.finishedAt)",
            phase: event.phase,
            createdAt: event.finishedAt,
            tokensBefore: event.tokensBefore,
            errorCode: event.errorCode
        ))

    case "agent.resync_required":
        refetchMessagesAndAgentStateThenReconnect()
        return

    case "final":
        applyFinalEvent(data)
        refreshAgentStateSoon()

    default:
        applyExistingAgentEvent(eventName, data)
    }

    if let id {
        streamCursor = id
    }
}
```

Meter rendering:

```swift
func visualProgress(for budget: ContextBudget?) -> Double {
    guard case let .available(snapshot) = budget else {
        return 0
    }
    return min(max(snapshot.percentOfContextBudget, 0), 1)
}
```

Do not derive `percentOfContextBudget` client-side.

## 10. Compatibility And Ownership

This is an additive contract change.

Existing clients that ignore unknown fields and unknown SSE events continue to
work. Mobile should ignore unknown fields and tolerate future compaction enum
values.

Auth and ownership follow the normal browser/mobile route rules:

- unauthenticated requests return `401`,
- authenticated cross-owner thread requests return `404`,
- SSE authorization happens before the service attaches listeners or replays
  buffered events.

Checkpoint summaries and replacement history are private service data. No mobile
client should try to query or display them.

## 11. Implementation Checklist

- Add mobile API models for `ApiContextBudget`, `ApiAgentCompactionStartEvent`,
  `ApiAgentCompactionDoneEvent`, and `ApiAgentCompactionFailedEvent`.
- Parse `/agent/state.context_budget` on thread open and refresh.
- Store `contextBudget` in thread runtime UI state.
- Render a compact context meter from `percent_of_context_budget`.
- Add a detail sheet for token/window details and stale/unknown states.
- Listen for `agent.compaction_start`, `agent.compaction_done`, and
  `agent.compaction_failed` on the existing agent stream.
- Update stream cursor from SSE `id:` for compaction events.
- Apply `agent.compaction_done.context_budget` immediately when present.
- Refresh `/agent/state` after compaction done, message send, final, cancel, and
  model/reasoning changes.
- Treat compaction notices as non-transcript UI markers.
- Keep `provider_usage_estimate` out of normal product UI.
- Do not add a manual compaction button in this tranche.

## 12. Validation Checklist

Thread open:

- A completed thread shows canonical messages and a context meter from
  `/agent/state.context_budget`.
- A thread with `context_budget.status == "unknown"` shows a non-crashing
  unknown state and still allows message send.

Stream:

- `agent.compaction_start` shows active compaction UI.
- `agent.compaction_done` clears active compaction UI, applies
  `context_budget` when present, and shows a non-transcript marker.
- `agent.compaction_failed` clears active compaction UI and shows a non-
  transcript failure marker.
- SSE cursor storage advances on compaction events with `id:`.

Recovery:

- If a compaction event is missed and `agent.resync_required` is received,
  refetching `/messages` plus `/agent/state` recovers the correct budget.
- Compaction markers do not duplicate when the same event is replayed.
- A full transcript refetch does not create message rows for compaction events.

Budget behavior:

- A successful compaction usually drops the meter sharply.
- `stale: true` displays stale copy but does not block interaction.
- Changing models refreshes the budget against the new model.
- Visual progress clamps at 100% when `percent_of_context_budget > 1`.

Security:

- A signed-in non-owner cannot read another user's `/agent/state` or stream.
- Raw checkpoint summaries and replacement history never appear in mobile logs
  or UI.

## 13. Do Not Build

Do not build these in the mobile first pass:

- local token counting,
- checkpoint summary display,
- checkpoint editing,
- manual "compact now",
- a separate compaction history API,
- durable transcript rows for compaction markers,
- product UI driven by `provider_usage_estimate`.

## 14. Source References

Backend contract:

- `docs/proto.md` documents `/agent/state.context_budget` and compaction SSE
  events.
- `service/src/routes/threads/agent.ts` attaches `context_budget` to
  `/agent/state` after authorization.
- `service/src/routes/models.ts` exposes model context-window and usable-window
  fields for model picker/details UI.
- `service/src/runtime/agent-runtime-state.ts` stores active budget decisions
  and shares cursor space with SSE events.
- `service/src/agent/context-budget-state.ts` defines the client-safe snapshot.
- `service/src/agent/context-budget-snapshot.ts` reconstructs durable
  post-checkpoint budget snapshots for inactive turns and recovery.
- `service/src/agent/agent-service.ts` emits compaction events and post-
  compaction budget snapshots.

Reference web implementation:

- `web/src/lib/api-types.ts` defines the current TypeScript API types.
- `web/src/features/threads/use-agent-stream.ts` parses compaction SSE events.
- `web/src/routes/$budId/$threadId.tsx` owns budget refresh and compaction UI
  state.
- `web/src/components/workbench/context-budget-meter-state.ts` maps snapshots to
  display copy and visual tones.
- `web/src/components/workbench/context-send-button.tsx` renders the meter near
  the composer send action.
- `web/src/components/workbench/chat-timeline.tsx` renders non-transcript
  compaction notices.
