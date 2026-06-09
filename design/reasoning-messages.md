# Reasoning Messages

## Context

Bud already receives provider-native reasoning through the canonical LLM stream
layer. OpenAI Responses, Anthropic Messages, and ds4 Responses can all produce
canonical reasoning events, and the provider ledger already stores completed
reasoning blocks as `llm_call_item.visibility = "provider_only"`.

The missing product behavior is user-visible reasoning. Today reasoning is not
streamed over the browser agent SSE contract and is not persisted in the
browser-visible `message` table.

This design follows the findings in
[../review/provider-reasoning-visibility-review.md](../review/provider-reasoning-visibility-review.md).

## Goal

Show provider reasoning in the chat transcript as a first-class, persistent
message type.

Requirements:

- stream reasoning live while a provider is producing it
- persist completed reasoning for later viewing
- fetch historical reasoning through the existing message history endpoint
- keep provider-native replay driven by `llm_call_item`, not by reasoning
  transcript rows
- avoid using reasoning rows for thread previews, push notifications, model
  replay, or context compaction input
- lead with web support, then produce a mobile handoff once the behavior is
  validated

## Decisions

| Question | Decision |
| --- | --- |
| Durable shape | Add a new browser-visible message role: `reasoning` |
| Provider replay source | Continue using `llm_call_item` provider-only payloads |
| OpenAI visibility | Show provider reasoning summaries |
| ds4 visibility | Show ds4 Responses reasoning summaries/text when emitted |
| Anthropic visibility | Show full Anthropic thinking when Anthropic emits it |
| Redacted thinking | Do not show as visible reasoning text |
| Default UI state | Visible by default |
| Future collapse behavior | Later collapse tool/reasoning/intermediate output between user turns |
| Push notifications | Exclude reasoning |
| Thread previews | Exclude reasoning |
| Context compaction | Do not include reasoning rows in model-visible compaction input |
| Historical fetch | Existing `GET /api/threads/:threadId/messages` endpoint |
| Mobile/native | Web first, then a separate handoff doc |

## Non-Goals

- Exposing `llm_call_item.provider_payload` to browsers.
- Replacing provider-ledger replay with generic message-row replay.
- Summarizing reasoning in Bud before display.
- Adding per-user collapse or visibility settings in this pass.
- Showing redacted Anthropic thinking content.
- Changing provider reasoning controls.
- Changing automatic context compaction policy beyond ignoring reasoning rows.

## Data Model

### Message Role

Add `reasoning` to the service `message` role vocabulary.

Reasoning rows are browser-visible transcript artifacts:

```text
message.role = "reasoning"
message.display_role = "Reasoning"
message.content = sanitized visible reasoning text
```

The row should be stamped with the thread owner:

```text
message.created_by_user_id = thread.created_by_user_id
```

### Metadata

Reasoning rows should keep metadata intentionally small and generic:

```json
{
  "artifact_kind": "reasoning",
  "model_visible": false,
  "turn_id": "01...",
  "llm_call_id": "01...",
  "step_index": 0,
  "provider": "openai|anthropic|ds4",
  "provider_model": "gpt-5.5",
  "reasoning_index": 0,
  "status": "succeeded",
  "started_at": "2026-06-05T00:00:00.000Z",
  "finished_at": "2026-06-05T00:00:01.000Z"
}
```

Do not store provider-native replay payloads, encrypted content, signatures, or
redacted-thinking payloads in the `message` row.

`llm_call_item` remains the durable provider replay table. If correlation is
useful, the reasoning `message_id` can be referenced from
`llm_call_item.message_id` in a later cleanup, but that link is not required for
the first implementation because replay already uses `llm_call_item` sequence
and payload data.

### Thread Metadata

Reasoning rows must not update:

- `thread.last_message_preview`
- assistant-completed attention metadata
- push notification outbox rows

The transcript can include reasoning while thread-list preview and push
notifications continue to reflect user, assistant, and relevant tool-visible
events only.

## Provider Policy

### OpenAI Responses

Show the canonical reasoning text emitted from OpenAI reasoning summaries.
Labeling should avoid implying full hidden chain-of-thought; the generic UI
label can be "Reasoning" while metadata records `provider: "openai"`.

### ds4 Responses

Show canonical reasoning text emitted by ds4 Responses. ds4 only emits
`reasoning_summary_*` fields when the request opts in with
`reasoning.summary`; Bud already sends `summary: "auto"` when ds4 thinking is
enabled.

### Anthropic Messages

Show full Anthropic thinking text when emitted. Anthropic redacted thinking
remains hidden and provider-only.

## Agent Flow

### LLM Call Identity

Create the `llmCallId` before invoking the provider instead of after the
provider response returns. This lets live reasoning events and persisted
reasoning rows reference the same provider call that will later be stored in
`llm_call`.

### Live Stream

Add reasoning-specific agent SSE events:

- `agent.reasoning_start`
- `agent.reasoning_delta`
- `agent.reasoning_done`

The live events carry sanitized display text only. They never include
`providerData` or provider replay payloads.

Expected event shape:

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "llm_call_id": "01CALL...",
  "index": 0,
  "provider": "ds4",
  "provider_model": "deepseek-v4-flash",
  "started_at": "2026-06-05T00:00:00.000Z"
}
```

`agent.reasoning_delta` appends text to the draft reasoning row:

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "delta": "I need to inspect the terminal state first."
}
```

`agent.reasoning_done` reconciles the live draft with a persisted message:

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "message_id": "uuid",
  "text": "I need to inspect the terminal state first.",
  "message": {
    "message_id": "uuid",
    "client_id": "uuidv7",
    "role": "reasoning",
    "display_role": "Reasoning",
    "content": "I need to inspect the terminal state first.",
    "metadata": { "artifact_kind": "reasoning", "model_visible": false },
    "created_at": "2026-06-05T00:00:00.000Z"
  }
}
```

### Runtime Snapshot

For refresh recovery during active turns, extend `/agent/state` with an
optional draft reasoning list:

```json
{
  "draft_reasoning": [
    {
      "client_id": "uuidv7",
      "text": "current streamed text",
      "provider": "ds4",
      "provider_model": "deepseek-v4-flash",
      "llm_call_id": "01CALL...",
      "index": 0,
      "updated_at": "2026-06-05T00:00:01.000Z"
    }
  ]
}
```

The field is additive. Existing clients can ignore it.

### Persistence Timing

Provider reasoning deltas should show live as drafts. Completed reasoning
should be persisted only after the provider invocation returns a successful
canonical response. This mirrors assistant draft behavior and avoids durable
reasoning rows from failed or canceled provider turns.

If a turn later fails after reasoning rows were persisted, the rows can remain
visible with `metadata.status = "succeeded"` for the provider step that emitted
them. If the provider call itself fails before returning, draft reasoning is
cleared on the failed `final` event and no reasoning row is inserted.

## Model Replay And Compaction

Reasoning messages are never model-visible transcript rows.

Required loader behavior:

- `AgentConversationLoader` must ignore `message.role = "reasoning"`.
- Provider-native reasoning replay continues through `loadProviderLedgerMessages`.
- Provider switches continue to omit provider-only reasoning and use canonical
  fallback from normal visible assistant/tool/user rows.
- Context compaction input remains based on the canonical model-visible
  conversation, not reasoning display rows.

Checkpoint boundaries may still use the latest visible database message as a
storage boundary. That is acceptable as long as replacement history and
conversation loading ignore reasoning rows; reasoning display artifacts do not
need to be reconstructed for model prompts.

## Web UI

The web timeline should treat reasoning as a message role.

Initial behavior:

- visible by default
- chronologically ordered with other messages
- rendered with a dedicated "Reasoning" header
- content shown as normal text or markdown-safe content
- draft reasoning rows stream live and reconcile to persisted rows
- failed/canceled turns clear unpersisted draft reasoning rows

Future behavior:

- collapse tool, reasoning, and intermediate assistant output between user
  turns, leaving the final assistant answer expanded
- remember per-user or per-thread collapse preferences

## Protocol And API Impact

Browser-facing changes:

- `GET /api/threads/:threadId/messages` may return rows with
  `role: "reasoning"`.
- `GET /api/threads/:threadId/agent/state` may return `draft_reasoning`.
- `GET /api/threads/:threadId/agent/stream` may emit
  `agent.reasoning_start`, `agent.reasoning_delta`, and
  `agent.reasoning_done`.

No Bud daemon protocol changes are required.

No LLM provider request changes are required for OpenAI or Anthropic. ds4
already opts into `reasoning.summary` when thinking is enabled.

## Security And Privacy

- Browser clients receive sanitized display text only.
- Provider-native payloads stay in `llm_call_item`.
- Redacted thinking stays hidden.
- Reasoning rows are scoped through the same thread ownership checks as other
  message rows.
- Signed-in non-owners still receive `404` through existing thread route
  authorization.

## Validation

Minimum validation:

- OpenAI reasoning-enabled run streams and persists a reasoning message.
- Anthropic thinking-enabled run streams and persists thinking text.
- ds4 `Thinking` streams and persists reasoning when the server emits summary
  deltas.
- ds4 `Fast` does not emit or persist reasoning.
- Reasoning appears after page refresh via `/messages`.
- Reasoning is not included in model replay prompts.
- Reasoning does not update thread preview or push notifications.
- Provider-ledger replay still includes provider-native reasoning payloads.

## Follow-Ups

- Create a mobile/native handoff after the web implementation is validated.
- Add collapse controls for reasoning/tool/intermediate output.
- Consider whether reasoning display retention needs a separate user setting.
- Consider whether `llm_call_item.message_id` should link to reasoning message
  rows for diagnostics.
