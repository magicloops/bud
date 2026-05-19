# Design: Ask User Questions Tool Contract

**Status:** Draft
**Created:** 2026-05-19
**Related:**
- [`service/src/agent/agent.spec.md`](../service/src/agent/agent.spec.md)
- [`service/src/notifications/notifications.spec.md`](../service/src/notifications/notifications.spec.md)
- [`docs/proto.md`](../docs/proto.md)

---

## Summary

Bud needs a first-class agent tool for moments where the model cannot safely or productively continue without human input. The tool should let the agent ask one or more structured questions, let any first-party client render those questions as an ordinary form, and turn the user's response into one structured result message for the agent.

The recommended model-facing tool name is `ask_user_questions`. The tool result should repeat each question before its answer, so future agent context does not need to correlate a list of answers with a separate earlier request. The service may store the original request and response as two JSON documents, but it should not need one durable row per question or answer.

This is a service-to-browser/client contract. It does not require Bud daemon protocol changes.

---

## Goals

- Give the agent a deliberate way to pause for user input instead of embedding informal questions in assistant prose.
- Support one-question prompts and longer multi-question forms with the same payload.
- Keep every question skippable, including questions the agent thinks are important.
- Make the request shape straightforward for web, iOS, and future clients to render as a full page, sheet, modal, wizard, or one-question-at-a-time flow.
- Make the response shape easy to validate and convert into one self-contained structured message for the agent.
- Preserve existing thread ownership rules: only the authorized thread owner can see and answer the prompt.
- Leave room for push notification reuse through the existing `human_input_requested` attention kind.

## Non-Goals

- No arbitrary HTML, markdown form rendering, or client-executed condition logic in v1.
- No passwords, API keys, OAuth tokens, or other secrets. Secret collection needs a separate tool because normal answers are shown to the model and persisted in transcript-adjacent state.
- No file uploads or rich attachments in v1.
- No branching survey engine. If the answer changes what needs to be asked next, the agent can ask a follow-up question set.
- No cross-thread or shared-Bud prompts. The request belongs to exactly one thread and its owner.

---

## When The Agent Should Use It

Good uses:

- Choosing between user-visible options before making a change.
- Asking for missing preferences where guessing would be expensive or risky.
- Confirming an irreversible or externally visible action.
- Collecting a small batch of setup values before continuing a workflow.

Bad uses:

- Asking questions whose answer is already present in the thread.
- Asking for approval for harmless read-only work.
- Asking for secrets that should not be exposed to the model.
- Replacing normal conversational follow-up when a plain assistant message is enough.

Agent prompt guidance should bias toward a small number of high-signal questions. A practical v1 limit is five questions per tool call unless a user explicitly asks for a questionnaire-style interaction.

---

## Question Types

V1 should keep the type set small:

| Kind | Use | Answer payload |
|------|-----|----------------|
| `boolean` | Yes/no decisions and confirmations | `{ "kind": "boolean", "value": true }` |
| `single_choice` | Exactly one choice from known options | `{ "kind": "single_choice", "choice_id": "staging" }` |
| `multi_choice` | Zero or more choices from known options | `{ "kind": "multi_choice", "choice_ids": ["lint", "test"] }` |
| `text` | Short or multiline freeform answer | `{ "kind": "text", "value": "..." }` |
| `number` | Numeric setting with optional bounds/unit | `{ "kind": "number", "value": 3 }` |

Possible later types:

- `date`, `time`, and `datetime` once scheduling or reminder prompts need native controls.
- `file` once user-selected local or remote files become a deliberate product concept.
- `secret` only as a separate secure-input flow that does not echo the value to the model.
- `ranking` only if concrete product use cases appear.

---

## Skippability

Every question is skippable. The agent may mark a question as `importance: "blocking"` to explain that a skipped answer may prevent progress, but the client must still offer a skip path.

Recommended states:

- `answered`: the user supplied a valid answer.
- `skipped`: the user skipped the question.

Recommended skip reasons:

- `user_skipped`: explicit skip.
- `not_applicable`: the user says the question does not apply.
- `unknown`: the user does not know.

If the user skips all questions, the service should still resume the agent with a tool result that says every question was skipped. If the user wants to stop the agent entirely, that remains the normal cancel flow, not a questionnaire response.

---

## Tool Request Shape

The model asks questions through `ask_user_questions`. The service validates and normalizes the request before exposing it to clients. If the model omits question ids, the service can generate stable ids from the labels plus ordinal position.

```json
{
  "schema": "ask_user_questions_request_v1",
  "title": "Deployment details",
  "body": "I need a couple of choices before I make changes.",
  "submit_label": "Send answers",
  "skip_all_label": "Skip questions",
  "questions": [
    {
      "question_id": "target_environment",
      "kind": "single_choice",
      "label": "Which environment should I target?",
      "help_text": "Staging is safer if you are unsure.",
      "importance": "blocking",
      "skippable": true,
      "choices": [
        {
          "choice_id": "staging",
          "label": "Staging",
          "description": "Use the staging deployment."
        },
        {
          "choice_id": "production",
          "label": "Production",
          "description": "Use the production deployment."
        }
      ],
      "default_answer": {
        "kind": "single_choice",
        "choice_id": "staging"
      }
    },
    {
      "question_id": "run_migrations",
      "kind": "boolean",
      "label": "Should I run database migrations if they are needed?",
      "true_label": "Yes",
      "false_label": "No",
      "importance": "blocking",
      "skippable": true,
      "default_answer": {
        "kind": "boolean",
        "value": false
      }
    },
    {
      "question_id": "extra_notes",
      "kind": "text",
      "label": "Anything else I should know?",
      "multiline": true,
      "max_length": 2000,
      "importance": "optional",
      "skippable": true
    }
  ]
}
```

Field notes:

- `schema` is required so clients and stored rows can distinguish future versions.
- `title`, `body`, `submit_label`, and `skip_all_label` are display text. Clients may choose where to place them.
- `question_id` is the stable key used in responses. It should be unique within the request.
- `label` is the question text. It is required because the service-generated result will repeat it.
- `help_text` is optional explanatory text.
- `importance` is one of `blocking`, `useful`, or `optional`. It is advisory only.
- `skippable` should always normalize to `true` in v1.
- `choices` is required for choice questions. Choice ids and labels should be unique within a question.
- `default_answer` is optional and must match the question kind.
- `allow_custom` can be added to choice questions when "Other" freeform text should be accepted.
- `min_value`, `max_value`, `step`, and `unit` apply to `number`.
- `min_length`, `max_length`, and `multiline` apply to `text`.

Clients should ignore unknown fields and treat unknown question kinds as unsupported. The service should avoid emitting unsupported kinds to first-party clients.

---

## Runtime Surface

The existing agent runtime shape can carry the prompt as a pending tool:

```json
{
  "active": true,
  "turn_id": "01TURN...",
  "phase": "waiting_for_user",
  "can_cancel": true,
  "pending_tool": {
    "client_id": "018f...",
    "call_id": "call_abc",
    "name": "ask_user_questions",
    "args": {
      "schema": "ask_user_questions_request_v1",
      "request_id": "qr_01J...",
      "title": "Deployment details",
      "questions": []
    },
    "started_at": "2026-05-19T12:00:00.000Z"
  },
  "stream_cursor": "01CUR...",
  "updated_at": "2026-05-19T12:00:00.000Z"
}
```

SSE can use the existing `agent.tool_call` event with `name: "ask_user_questions"` and the same normalized `args`. Clients that miss the event can recover from `GET /api/threads/:thread_id/agent/state`.

The service should add `phase: "waiting_for_user"` rather than representing the prompt as a generic long-running tool. That gives clients a stable signal for notification, badge, and disabled-input behavior.

---

## Client Response Shape

Recommended route:

```text
POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
```

Request body:

```json
{
  "schema": "ask_user_questions_response_v1",
  "client_response_id": "018f4f2a-0000-7000-9000-000000000000",
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
      "question_id": "run_migrations",
      "status": "answered",
      "answer": {
        "kind": "boolean",
        "value": true
      }
    },
    {
      "question_id": "extra_notes",
      "status": "skipped",
      "skip_reason": "user_skipped"
    }
  ]
}
```

Validation rules:

- `thread_id` is resolved through the authenticated viewer before the request row is read.
- `request_id` must belong to that authorized thread.
- `client_response_id` is optional but should be accepted for idempotent retries.
- Unknown `question_id` values are rejected.
- Duplicate answers for the same `question_id` are rejected.
- Answer kind must match the original question kind.
- Choice ids must match the original question choices unless `allow_custom` is true and `custom_text` is supplied.
- Text and number answers are validated against the original constraints.
- Omitted questions may be filled as `skipped` for tolerance, but first-party clients should submit one entry per question.
- Choice labels in the final agent result come from the stored request, not from the client response.

For `allow_custom` choice questions:

```json
{
  "question_id": "target_environment",
  "status": "answered",
  "answer": {
    "kind": "single_choice",
    "choice_id": "other",
    "custom_text": "Use the QA cluster"
  }
}
```

---

## Agent Tool Result Shape

The service should convert the client response into a single self-contained tool result for the agent:

```json
{
  "schema": "ask_user_questions_tool_result_v1",
  "request_id": "qr_01J...",
  "title": "Deployment details",
  "submitted_at": "2026-05-19T12:03:00.000Z",
  "responses": [
    {
      "question_id": "target_environment",
      "kind": "single_choice",
      "question": "Which environment should I target?",
      "status": "answered",
      "answer": {
        "kind": "single_choice",
        "choice_id": "staging",
        "choice_label": "Staging"
      },
      "answer_text": "Staging"
    },
    {
      "question_id": "run_migrations",
      "kind": "boolean",
      "question": "Should I run database migrations if they are needed?",
      "status": "answered",
      "answer": {
        "kind": "boolean",
        "value": true
      },
      "answer_text": "Yes"
    },
    {
      "question_id": "extra_notes",
      "kind": "text",
      "question": "Anything else I should know?",
      "status": "skipped",
      "skip_reason": "user_skipped",
      "answer_text": "Skipped by user."
    }
  ],
  "summary_markdown": "Q: Which environment should I target?\nA: Staging\n\nQ: Should I run database migrations if they are needed?\nA: Yes\n\nQ: Anything else I should know?\nA: Skipped by user."
}
```

The important property is redundancy: each response item contains the original question text and a normalized answer. The model can read only the result payload and still understand the human input.

`summary_markdown` is optional for machines but useful for model context, transcript display, and debugging. The structured `responses` array remains the source of truth.

---

## Persistence Model

Recommended durable shape:

- One `agent_user_question_request` row per tool call.
- One JSON `request` column containing the normalized request.
- One nullable JSON `response` column containing the accepted client response and service-generated tool result.
- `thread_id`, `turn_id`, `call_id`, `client_id`, `status`, `created_by_user_id`, `answered_by_user_id`, `created_at`, `answered_at`, and optional `expires_at`.

Do not create one row per question or answer in v1. The question set is an interaction payload, not a reporting table.

Status values:

- `pending`
- `answered`
- `expired`
- `canceled`

The active in-memory agent loop can wait on the pending request. If the service restarts before the user answers, the durable request still lets clients show the prompt and submit the response. The implementation then needs one of two explicit continuation policies:

1. Durable suspended-turn resume: reconstruct the pending tool result and continue the original turn.
2. Fallback continuation: persist the response as a single user-visible structured message and start a new agent turn with the same question-answer summary.

The first policy is cleaner for provider tool-call continuity. The second is easier to ship if full suspended-turn replay is not ready. The request and result shapes above support both.

---

## Transcript And UI Representation

The prompt itself should be visible as a pending tool state, not as final assistant prose. When the user responds:

- The model should receive a tool result for `ask_user_questions`.
- The transcript should include a compact visible summary of the user's answers.
- The persisted replay payload should preserve the structured result, not only markdown.

There are two reasonable transcript options:

- Persist a normal tool row with `name: "ask_user_questions"` and render it as a human-input card.
- Persist a user row with `metadata.source = "ask_user_questions"` for display, while also sending the provider a tool result.

The tool-row option fits the existing agent tool machinery. The user-row option reads more naturally in history. The implementation should pick one canonical source and avoid duplicating answer content into two independent transcript rows.

---

## Ownership And Authorization

This is browser-facing state, so it must follow the existing ownership contracts.

- The request owner is the owning thread.
- The acting viewer is resolved from the authenticated browser/native session.
- Reads and responses must call ownership-aware thread lookup before reading the request.
- A signed-in non-owner receives `404`, not `403`.
- An unauthenticated request receives `401`.
- `created_by_user_id` is copied from the thread owner when the request row is created.
- `answered_by_user_id` is the authenticated viewer who submitted the response and should match the owner in the current one-user-per-thread model.
- SSE and `/agent/state` must authorize before exposing pending prompts.
- Clients cannot choose `thread_id`, `call_id`, or `request_id` authority by raw id alone; the service re-resolves all of them through the authorized thread.

---

## Notifications

The existing notification design already has `human_input_requested` as an attention kind and user preference. This tool is the natural producer for that kind.

Recommended behavior:

- When a question request becomes durable, update the thread attention summary with `last_attention_kind = "human_input_requested"`.
- Enqueue push outbox rows for owners whose push preferences allow human-input alerts.
- Suppress push if the user is already actively viewing the thread, following the same read-watermark principles as assistant-completed notifications.
- Mark the attention as resolved or superseded once the user answers, skips all, cancels the turn, or the request expires.

---

## Docs And Spec Impact During Implementation

Implementation should update:

- `docs/proto.md` for the browser route, `agent.tool_call` payload example, `/agent/state.phase`, and response contract.
- `service/src/agent/agent.spec.md` for the new tool definition, runtime phase, transcript behavior, and removal of the current human-input TODO if completed.
- `service/src/routes/routes.spec.md` for the new authorized response route.
- `service/src/notifications/notifications.spec.md` if the tool enqueues `human_input_requested`.
- `web` and mobile handoff specs for client rendering behavior.
- DB specs and Drizzle migrations if a durable request table is added.

---

## Recommendation

Ship v1 with `boolean`, `single_choice`, `multi_choice`, `text`, and `number`; make every question skippable; carry the prompt through existing `agent.tool_call` / `/agent/state.pending_tool`; accept responses through an owner-scoped thread route; and convert the response into one structured tool result that repeats each question before its answer.

This gives clients a simple form contract without forcing the backend to model every question and answer as separate durable resources.
