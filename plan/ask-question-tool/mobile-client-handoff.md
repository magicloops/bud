# Mobile Client Handoff: Ask User Questions

## Status

- Feature: `ask_user_questions`
- Client surface: mobile/native thread timeline and agent stream
- Service contract status: v1 implemented for browser-facing REST/SSE
- Source contracts:
  - [../../docs/proto.md](../../docs/proto.md)
  - [../../web/src/lib/api-types.ts](../../web/src/lib/api-types.ts)
  - [../../service/src/agent/user-question-contracts.ts](../../service/src/agent/user-question-contracts.ts)

## What Mobile Needs To Build

Mobile needs to render a pending structured prompt when the agent calls `ask_user_questions`, let the user answer or skip every question, and submit one `ask_user_questions_response_v1` payload back to the thread-scoped service route.

The client should support two prompt sources:

1. Live SSE `agent.tool_call` event with `name: "ask_user_questions"`.
2. Recovery/bootstrap from `GET /api/threads/:thread_id/agent/state` when `phase: "waiting_for_user"` and `pending_tool.name: "ask_user_questions"`.

Both sources expose the same normalized request payload under `args`.

## Detection

### Live Stream

Listen on:

```text
GET /api/threads/:thread_id/agent/stream
```

When an SSE event arrives:

```json
{
  "event": "agent.tool_call",
  "data": {
    "turn_id": "01TURN...",
    "client_id": "uuidv7",
    "call_id": "call_123",
    "name": "ask_user_questions",
    "args": {
      "schema": "ask_user_questions_request_v1",
      "request_id": "qr_01J...",
      "title": "Deployment details",
      "body": "A few details are needed before I continue.",
      "submit_label": "Send answers",
      "skip_all_label": "Skip all",
      "questions": []
    },
    "started_at": "2026-05-20T18:30:00.000Z"
  }
}
```

Render a pending tool row keyed by the top-level `data.client_id`. Preserve
`turn_id`, `call_id`, `started_at`, and the request `args`. `client_id` is not
inside `args`; `args.request_id` is the durable question request id used for
submission.

### Refresh / Resume

Fetch:

```text
GET /api/threads/:thread_id/agent/state
```

If the response contains:

```json
{
  "active": true,
  "phase": "waiting_for_user",
  "pending_tool": {
    "client_id": "uuidv7",
    "call_id": "call_123",
    "name": "ask_user_questions",
    "started_at": "2026-05-20T18:30:00.000Z",
    "args": {
      "schema": "ask_user_questions_request_v1",
      "request_id": "qr_01J...",
      "questions": []
    }
  }
}
```

Render or upsert the same pending prompt row. Key it by `pending_tool.client_id` so refresh and live stream do not duplicate the prompt.

## Request Shape

Use `question_id` and `choice_id`. Ignore unknown fields.

```json
{
  "schema": "ask_user_questions_request_v1",
  "request_id": "qr_01J...",
  "title": "Deployment details",
  "body": "A few details are needed before I continue.",
  "submit_label": "Send answers",
  "skip_all_label": "Skip all",
  "questions": [
    {
      "question_id": "target_environment",
      "kind": "single_choice",
      "label": "Which environment should I target?",
      "help_text": "Production can affect live users.",
      "importance": "important",
      "skippable": true,
      "choices": [
        {
          "choice_id": "staging",
          "label": "Staging",
          "description": "Use the staging deployment target."
        },
        {
          "choice_id": "production",
          "label": "Production",
          "description": "Deploy to the live environment."
        }
      ],
      "default_answer": {
        "kind": "single_choice",
        "choice_id": "staging"
      }
    }
  ]
}
```

### Supported Question Kinds

| `kind` | Render As | Answer Payload |
|--------|-----------|----------------|
| `boolean` | toggle, segmented yes/no, or switch | `{ "kind": "boolean", "value": true }` |
| `single_choice` | radio list or single-select menu | `{ "kind": "single_choice", "choice_id": "staging" }` |
| `multi_choice` | checkbox list | `{ "kind": "multi_choice", "choice_ids": ["a", "b"] }` |
| `text` | text field or multiline text area | `{ "kind": "text", "value": "..." }` |
| `number` | numeric text field or stepper | `{ "kind": "number", "value": 3 }` |

All v1 questions are skippable. Treat `importance` as display/advisory only; do not block skip.

## UI Rules

- Render `title` and `body` when present.
- Use `submit_label` if present; otherwise use a local default such as `Send answers`.
- Use `skip_all_label` if present; otherwise use a local default such as `Skip all`.
- Initialize each question from `default_answer` only when `default_answer.kind` matches the question `kind`.
- If a question kind is unknown, render it as unsupported and submit it as skipped.
- Let the user skip any individual question.
- Let the user skip all questions in one action.
- Treat `waiting_for_user` as paused human input, not background agent work.
- Keep normal composer input available while a visible prompt is pending for the thread.
- If the user sends a follow-up message instead of answering the prompt, send it through the normal message route. Do not synthesize a skip-all response first.
- Do not use this UI to collect secrets. The service prompt tells the agent not to ask for passwords, API keys, tokens, private keys, or other secrets through this tool, and responses are durable.

## Response Payload

Submit exactly one response payload per user action. Include every question in `answers`, either answered or skipped.

Generate `client_response_id` as a UUID. Reusing the same `client_response_id` makes retry idempotent.

```json
{
  "schema": "ask_user_questions_response_v1",
  "client_response_id": "018f2d3a-8b6a-7c10-9234-2b5cc27f62c0",
  "answers": [
    {
      "question_id": "target_environment",
      "status": "answered",
      "answer": {
        "kind": "single_choice",
        "choice_id": "staging"
      }
    },
    {
      "question_id": "release_notes",
      "status": "skipped",
      "skip_reason": "user_skipped"
    }
  ]
}
```

For skipped questions:

```json
{
  "question_id": "release_notes",
  "status": "skipped",
  "skip_reason": "user_skipped"
}
```

Allowed `skip_reason` values are:

- `user_skipped`
- `not_applicable`
- `unknown`

Use `user_skipped` for normal UI skip actions.

## Submit Route

```text
POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
Content-Type: application/json
```

Path values:

- `thread_id`: current owned thread id
- `request_id`: `args.request_id` from the pending prompt

Success response:

```json
{
  "ok": true,
  "question_request_id": "qr_01J...",
  "status": "answered",
  "continuation": "live_tool_result"
}
```

Possible `continuation` values:

| Value | Meaning | Client Action |
|-------|---------|---------------|
| `live_tool_result` | Service still had the live in-memory waiter and the same agent turn will continue. | Keep or reconnect the agent stream and wait for `agent.tool_result` / final events. |
| `fallback_user_message` | Service accepted the answer but no live waiter existed, usually after restart. It created a self-contained user message and started a new turn. | Refetch latest `/messages` and `/agent/state`. |
| `already_answered` | Same `client_response_id` was already accepted. | Treat as success and refetch latest `/messages` and `/agent/state`. |

Fallback success may also include:

```json
{
  "message_id": "msg_...",
  "client_id": "uuidv7"
}
```

## Follow-Up Messages While Waiting

If a user types a normal follow-up message while an `ask_user_questions` prompt is pending, submit the message through:

```text
POST /api/threads/:thread_id/messages
```

The service closes every pending question request for that thread as skipped before it persists the new user message and starts the fresh turn. The message-create response is:

```json
{
  "message_id": "uuid",
  "client_id": "uuidv7",
  "message": {
    "message_id": "uuid",
    "client_id": "uuidv7",
    "role": "user",
    "display_role": "User",
    "content": "Use my latest instruction instead.",
    "metadata": {},
    "created_at": "2026-05-21T18:30:05.000Z"
  }
}
```

Use the returned `message` to replace any optimistic row so live ordering matches refresh ordering. The superseded tool-result row is persisted before the follow-up user message, so preserving a local optimistic `created_at` can display the rows in the wrong order.

There is no mobile-specific skip-and-send endpoint. See [mobile-follow-up-supersession-handoff.md](./mobile-follow-up-supersession-handoff.md) for the focused mobile implementation flow. The old waiting turn may emit a successful final event with no assistant text:

```json
{
  "turn_id": "01TURN...",
  "status": "succeeded",
  "reason": "superseded_by_user_message"
}
```

Treat this as terminal for the old prompt and converge through `agent.tool_result`, `final`, and the next `/agent/state` refresh.

## Error Handling

Expected HTTP behavior:

| Status | Body | Meaning |
|--------|------|---------|
| `401` | auth error shape | User is not authenticated; follow normal mobile auth recovery. |
| `404` | `{ "error": "question_request_not_found" }` or normal not-found shape | Thread/request is not owned by this user, wrong thread, or missing request. Treat as stale prompt and refresh. |
| `400` | `{ "error": "invalid_question_response", "message": "..." }` | Payload shape or answer validation failed. Keep prompt visible and show a validation error. |
| `409` | `{ "error": "question_request_already_answered" }` or `{ "error": "question_request_not_pending" }` | Prompt is no longer answerable. Refresh latest `/messages` and `/agent/state`. |

Response validation is server-side against the stored request. Labels from the client are ignored; only ids and typed answers matter.

## Completed Tool Result Rendering

After a live continuation, mobile may receive a top-level compact runtime
payload plus the persisted message row:

```json
{
  "event": "agent.tool_result",
  "data": {
    "turn_id": "01TURN...",
    "client_id": "uuidv7",
    "call_id": "call_123",
    "name": "ask_user_questions",
    "summary": "Question response: Deployment details",
    "user_questions": {
      "kind": "user_questions",
      "requestId": "qr_01J...",
      "responses": [
        {
          "question_id": "target_environment",
          "question": {
            "question_id": "target_environment",
            "kind": "single_choice",
            "label": "Which environment should I target?",
            "choices": [
              { "choice_id": "staging", "label": "Staging" },
              { "choice_id": "production", "label": "Production" }
            ]
          },
          "status": "answered",
          "answer": {
            "kind": "single_choice",
            "choice_id": "staging"
          },
          "display_answer": "Staging"
        }
      ]
    },
    "message": {
      "message_id": "msg_...",
      "client_id": "uuidv7",
      "role": "tool",
      "display_role": "Tool",
      "content": "{\"tool\":\"ask_user_questions\",\"call_id\":\"call_123\",\"schema\":\"ask_user_questions_request_v1\",\"request_id\":\"qr_01J...\",\"questions\":[],\"summary\":\"Answered questions: Deployment details\",\"kind\":\"user_questions\",\"result\":{\"schema\":\"ask_user_questions_tool_result_v1\",\"request_id\":\"qr_01J...\",\"title\":\"Deployment details\",\"responses\":[],\"summary_markdown\":\"Question response: Deployment details\"}}",
      "metadata": {
        "tool": "ask_user_questions",
        "call_id": "call_123",
        "kind": "user_questions",
        "started_at": "2026-05-20T18:30:00.000Z",
        "finished_at": "2026-05-20T18:30:05.000Z",
        "duration_ms": 5000
      },
      "created_at": "2026-05-20T18:30:05.000Z"
    }
  }
}
```

For historical rendering from `GET /api/threads/:thread_id/messages`, the
canonical completed Q/A payload lives in the tool row's `message.content` as a
JSON string. Parse it and look for:

```json
{
  "tool": "ask_user_questions",
  "call_id": "call_123",
  "schema": "ask_user_questions_request_v1",
  "request_id": "qr_01J...",
  "questions": [],
  "summary": "Answered questions: Deployment details",
  "kind": "user_questions",
  "result": {
    "schema": "ask_user_questions_tool_result_v1",
    "request_id": "qr_01J...",
    "title": "Deployment details",
    "responses": [
      {
        "question_id": "target_environment",
        "question": {
          "question_id": "target_environment",
          "kind": "single_choice",
          "label": "Which environment should I target?",
          "choices": [
            { "choice_id": "staging", "label": "Staging" },
            { "choice_id": "production", "label": "Production" }
          ]
        },
        "status": "answered",
        "answer": {
          "kind": "single_choice",
          "choice_id": "staging"
        },
        "display_answer": "Staging"
      }
    ],
    "summary_markdown": "Question response: Deployment details\n\n1. Which environment should I target?\nAnswer: Staging"
  }
}
```

Render completed Q/A rows from `content.result.responses` for historical
messages. For live events, `event.data.user_questions.responses` is also usable
for immediate display, but the persisted row remains `event.data.message.content`
and later `/messages[*].content`.

`message.metadata` currently includes the replay payload fields as well as
timing/model fields, but mobile should not depend on metadata for Q/A rendering.
Use metadata for timing, model/debug details, and reconciliation hints only. If
the client cannot parse `message.content`, fall back to `message.metadata.result`
or `summary` for best-effort display.

## State Reconciliation

Recommended mobile flow:

1. On thread open, fetch `/messages` and `/agent/state` in parallel.
2. Apply a synthetic pending prompt row if `/agent/state.phase === "waiting_for_user"` and `pending_tool.name === "ask_user_questions"`.
3. Attach `/agent/stream` using the current `stream_cursor` when available.
4. On live `agent.tool_call` with `ask_user_questions`, upsert the pending prompt by `client_id`.
5. On successful submit:
   - `live_tool_result`: keep the stream connected.
   - `fallback_user_message` or `already_answered`: refetch `/messages` and `/agent/state`.
6. On a normal follow-up message send while waiting, refetch `/agent/state` after the message-create response if no agent stream is attached.
7. On `agent.tool_result`, replace the pending prompt row with the persisted tool message when the event includes `message`, or clear the pending prompt for that `turn_id`.
8. On `final` with `status: "failed"` or `"canceled"`, clear pending prompt rows for that `turn_id`.
9. On `final` with `status: "succeeded"` and `reason: "superseded_by_user_message"`, clear pending prompt rows for that `turn_id` and do not require `message_id` or `text`.
10. On `agent.resync_required`, refetch `/messages` and `/agent/state`, then reattach the stream without assuming buffered replay was complete.

## Minimal Test Checklist For Mobile

- Live `agent.tool_call` renders one pending prompt.
- `/agent/state` with `waiting_for_user` renders the same pending prompt after refresh.
- Refresh plus live event does not duplicate the prompt.
- Boolean, single-choice, multi-choice, text, and number answers serialize correctly.
- Per-question skip serializes with `status: "skipped"` and `skip_reason: "user_skipped"`.
- Skip-all includes every question as skipped.
- Unknown question kinds are displayed safely and submitted as skipped.
- Submit handles `live_tool_result` by keeping the stream connected.
- Submit handles `fallback_user_message` and `already_answered` by refetching bootstrap state.
- Normal follow-up while waiting uses only `/messages` and clears the pending prompt through stream/state convergence.
- `400`, `404`, and `409` responses show stable UI and refresh when appropriate.

## Out Of Scope For V1

- Secret input controls
- File upload answers
- Date/time picker answers
- Branching question flows
- Durable provider-native suspended-turn replay after restart
- Push notification behavior for `human_input_requested`
