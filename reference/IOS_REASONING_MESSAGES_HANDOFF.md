# iOS Reasoning Messages Handoff

**Status:** Current backend/web contract  
**Audience:** iOS, web platform, backend, product  
**Last Updated:** 2026-06-05

## Purpose

Bud now exposes provider reasoning as visible transcript content. This handoff describes what mobile needs to support in order to display reasoning messages consistently with web.

This is a UI/display contract. Provider-native replay remains backend-owned through `llm_call_item`; mobile should not try to reconstruct or send reasoning back to the model.

## Summary

The current model is:

- durable history may include `message.role = "reasoning"`
- live streams may emit `agent.reasoning_start`, `agent.reasoning_delta`, and `agent.reasoning_done`
- `/agent/state` may include `draft_reasoning` while a turn is active
- reasoning rows are visible by default
- reasoning rows are display-only and not assistant final answers
- reasoning rows should not be used for thread previews, push notifications, or model-visible replay

Provider behavior:

- OpenAI and ds4 generally expose reasoning summaries or reasoning text, not necessarily full private chain-of-thought.
- Anthropic thinking text may be visible when the provider returns it.
- Redacted/provider-only reasoning is not surfaced as visible transcript text.

## Durable Message History

`GET /api/threads/:thread_id/messages` uses the existing paginated message endpoint. No new route is needed.

Reasoning rows look like normal transcript messages:

```json
{
  "message_id": "6c06d627-9043-4d71-a9cc-8b35ef3f7c59",
  "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
  "role": "reasoning",
  "display_role": "Reasoning",
  "content": "I should inspect the terminal state before sending another command.",
  "metadata": {
    "artifact_kind": "reasoning",
    "model_visible": false,
    "status": "succeeded",
    "turn_id": "01KT...",
    "llm_call_id": "01LLM...",
    "step_index": 0,
    "provider": "ds4",
    "provider_model": "deepseek-v4-flash",
    "reasoning_index": 0,
    "reasoning_kind": "summary",
    "started_at": "2026-06-05T20:00:01.000Z",
    "finished_at": "2026-06-05T20:00:05.000Z"
  },
  "created_at": "2026-06-05T20:00:05.000Z"
}
```

Mobile should:

- render `role: "reasoning"` as a visible timeline row
- key the row by `client_id`, same as other transcript rows
- show `display_role` when present
- render `content` as Markdown-capable text if the existing message renderer supports that
- visually distinguish reasoning from final assistant output, for example muted styling or a separate label

Mobile should not:

- treat reasoning as an assistant final answer
- use reasoning rows for thread preview text
- include reasoning rows in notification text
- infer model-visible context from reasoning rows

## Runtime State

`GET /api/threads/:thread_id/agent/state` may include `draft_reasoning`:

```json
{
  "active": true,
  "turn_id": "01KT...",
  "phase": "thinking",
  "stream_cursor": "01CUR...",
  "draft_assistant": null,
  "draft_reasoning": [
    {
      "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
      "text": "I should inspect the terminal state",
      "llm_call_id": "01LLM...",
      "index": 0,
      "provider": "ds4",
      "provider_model": "deepseek-v4-flash",
      "started_at": "2026-06-05T20:00:01.000Z",
      "updated_at": "2026-06-05T20:00:03.000Z"
    }
  ],
  "updated_at": "2026-06-05T20:00:03.000Z"
}
```

Mobile thread-open recovery should overlay `draft_reasoning` after loading durable `/messages`, just like pending tool and draft assistant overlays.

Recommended projection:

1. Load `/messages`.
2. Load `/agent/state`.
3. Render durable messages.
4. Add one synthetic reasoning row per `draft_reasoning` item.
5. Attach `/agent/stream?after=<state.stream_cursor>`.
6. Reconcile stream events by `client_id`.

Synthetic draft reasoning row guidance:

- `message_id`: use `client_id` locally until the persisted row arrives
- `client_id`: use the backend-provided `client_id`
- `role`: `reasoning`
- `display_role`: `Reasoning`
- `content`: `draft_reasoning.text`
- `created_at`: `started_at` when present, otherwise `updated_at`
- `metadata.draft`: `true`
- `metadata.turn_id`: current state `turn_id`
- copy `llm_call_id`, `index`, `provider`, and `provider_model` into metadata if useful for debugging

## Agent Stream Events

### `agent.reasoning_start`

Starts a visible reasoning draft row.

```json
{
  "turn_id": "01KT...",
  "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
  "llm_call_id": "01LLM...",
  "index": 0,
  "provider": "ds4",
  "provider_model": "deepseek-v4-flash",
  "started_at": "2026-06-05T20:00:01.000Z"
}
```

Client action:

- create or upsert a draft reasoning row keyed by `client_id`
- set status to active/streaming if the current screen has a turn activity state

### `agent.reasoning_delta`

Appends visible text to the draft reasoning row.

```json
{
  "turn_id": "01KT...",
  "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
  "delta": " before sending another command."
}
```

Client action:

- append `delta` to the draft row with the same `client_id`
- if no draft exists, create one defensively with `content = delta`

### `agent.reasoning_done`

Replaces the draft reasoning row with the persisted canonical message.

```json
{
  "turn_id": "01KT...",
  "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
  "message_id": "6c06d627-9043-4d71-a9cc-8b35ef3f7c59",
  "text": "I should inspect the terminal state before sending another command.",
  "message": {
    "message_id": "6c06d627-9043-4d71-a9cc-8b35ef3f7c59",
    "client_id": "01974d4d-8080-74f0-b5aa-0a09d97f52b1",
    "role": "reasoning",
    "display_role": "Reasoning",
    "content": "I should inspect the terminal state before sending another command.",
    "metadata": {
      "artifact_kind": "reasoning",
      "model_visible": false,
      "llm_call_id": "01LLM..."
    },
    "created_at": "2026-06-05T20:00:05.000Z"
  }
}
```

Client action:

- remove the draft row with matching `client_id`
- insert/upsert `message` as the durable transcript row
- if `message` is missing for any compatibility reason, create a fallback row from `message_id`, `client_id`, and `text`

## Finalization And Cleanup

On `final`:

- remove pending tool rows for the turn
- remove any draft reasoning rows for the turn
- for failed/canceled turns, also remove draft assistant rows

If a successful turn still has a draft reasoning row at `final`, mobile should drop that draft. The durable row should arrive via `agent.reasoning_done`; if it was missed, the next `/messages` refresh is the canonical recovery path.

## Ordering

Reasoning rows are normal timeline items ordered by `created_at` once persisted.

For draft reasoning:

- use `started_at` if available so the row appears where the provider started reasoning
- otherwise use `updated_at` or local receipt time
- reconcile by `client_id`, not by timestamp

Reasoning may appear before a tool call, between tool calls, or before a final assistant response. Mobile should not assume reasoning is only pre-answer content.

## Relationship To Existing Mobile Contracts

This extends the existing message/stream contract from:

- [`IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`](./IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)
- [`IOS_THREAD_MESSAGE_UX_BACKEND_HANDOFF.md`](./IOS_THREAD_MESSAGE_UX_BACKEND_HANDOFF.md)

The same recovery model applies:

- `/messages` is durable history
- `/agent/state` is current runtime state
- `/agent/stream` is live transport with bounded resume
- `client_id` is the reconciliation key
- `agent.resync_required` means refetch `/messages` plus `/agent/state`

## Compatibility Notes

Older clients that do not know `role: "reasoning"` can safely ignore or render it as generic text. New mobile clients should render it explicitly so users can see the model's reasoning summary/thinking output.

Reasoning event handling is additive. If mobile misses live reasoning events, refresh through `/messages` plus `/agent/state` restores the coherent state.

## Current Validation

Backend and web automated validation completed for:

- reasoning rows skipped from model-visible reconstruction
- `draft_reasoning` runtime serialization and cleanup
- model-runner reasoning stream event capture
- reasoning transcript persistence with `metadata.model_visible = false`
- web draft reasoning overlay and reconciliation
- service and web builds

The product team has also validated the web behavior as expected. Mobile should still run an end-to-end device test with at least one reasoning-enabled provider before shipping UI support.
