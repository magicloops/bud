# Phase 3: Reference Web Client

**Status**: Draft
**Parent**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Adopt the question prompt contract in the reference web client so web can render, answer, skip, and reconcile `ask_user_questions` prompts.

The prompt should appear in the thread timeline as part of the agent turn, recover from `/agent/state` on reconnect, and submit through the new owner-scoped response route.

## Tasks

### 1. API Types

Update `web/src/lib/api-types.ts`:

- add `ApiAskUserQuestionsRequest`
- add question-kind and answer-kind unions
- add `ApiAskUserQuestionsResponseInput`
- add `ApiAskUserQuestionsToolResult`
- add `waiting_for_user` to `ApiAgentState.phase`
- add `started_at` to `ApiAgentState.pending_tool`

Type the request permissively enough to tolerate unknown future fields, but the first-party renderer should only render supported v1 kinds.

### 2. Agent Stream Parsing

Update `web/src/features/threads/use-agent-stream.ts`:

- continue treating `agent.tool_call` generically
- recognize `name: "ask_user_questions"` for logging/status if needed
- keep cursor handling unchanged
- keep stream attached while waiting for user input

The hook should not own the form state. It should pass the pending tool event to transcript state through the existing `onToolCall` callback.

### 3. Synthetic Pending Prompt

Update `web/src/features/threads/thread-message-state.ts`:

- build a synthetic pending tool message for `ask_user_questions` from `/agent/state.pending_tool`
- include `request_id`, `questions`, `started_at`, and `turn_id` in metadata/content
- avoid clearing the prompt until `agent.tool_result`, `final`, cancel, or resync says it is no longer pending

Add tests for:

- `waiting_for_user` state produces one pending prompt row
- pending prompt row uses stable `client_id`
- final/cancel clears pending prompt row
- latest bootstrap preserves canonical messages and overlays the prompt

### 4. Question Form Component

Add a presentation component, likely under `web/src/components/workbench/`:

- `QuestionRequestCard`

Responsibilities:

- render request title/body when present
- render each supported question kind
- show advisory importance without blocking skip
- support per-question skip states
- support skip all
- build `ask_user_questions_response_v1`
- show pending submit/error state
- keep unsupported question kinds visible with a disabled unsupported-state row and skipped submit behavior if service ever emits one

Controls:

- boolean: segmented yes/no control plus skip
- single choice: radio list or segmented choice for short lists
- multi choice: checkboxes plus skip
- text: input or textarea based on `multiline`
- number: numeric input with min/max/step/unit hints

### 5. Submission Flow

Add a web helper or route-local callback:

```typescript
submitQuestionResponse(threadId, requestId, response)
```

It should:

- POST to `/api/threads/:thread_id/agent/question-requests/:request_id/responses`
- generate `client_response_id` for retry/idempotency
- use `apiFetchJson(...)`
- surface errors in the thread route's existing error/status surface
- disable duplicate submits while a submit is in flight

After success:

- if `continuation` is `live_tool_result`, leave stream reconciliation to SSE
- if `continuation` is `fallback_user_message`, refresh latest transcript + `/agent/state` because the response route created a new user row
- if `continuation` is `already_answered`, refresh latest transcript + `/agent/state`

### 6. Timeline Integration

Update `ChatTimeline` or the message row renderer path so pending `ask_user_questions` messages can render an interactive form.

Recommended approach:

- keep completed tool-result rendering in `message-renderers/tools/ask-user-questions.tsx`
- render pending interactive forms in `ChatTimeline` or a workbench-level row branch because submit callbacks are route-owned
- keep message-renderer tool components presentation-only for persisted payloads

### 7. Completed Result Renderer

Add `web/src/components/message-renderers/tools/ask-user-questions.tsx`.

It should render:

- title if present
- each Q/A pair from `responses`
- skipped state
- compact JSON fallback if payload is malformed

Register it in `tools/index.ts`.

### 8. UX State

While `phase === "waiting_for_user"`:

- the normal composer may remain available, but submitting a new normal message should be considered carefully
- v1 recommendation: disable normal composer submit with a concise state label until the prompt is answered or the agent is canceled
- cancel button should remain available through existing agent cancel controls
- the timeline should scroll to the prompt when it first appears

### 9. Tests

Add focused web tests for:

- building response payloads for each question kind
- skip all response payload
- synthetic pending prompt from `/agent/state`
- completed renderer handles answered/skipped rows
- successful submit triggers bootstrap refresh only for fallback/already-answered modes

## Acceptance Criteria

- [ ] web API types include question request/response/result shapes
- [ ] `waiting_for_user` is a valid web runtime phase
- [ ] `/agent/state` pending prompt renders after refresh/reopen
- [ ] live `agent.tool_call` pending prompt renders without refresh
- [ ] each v1 question kind can be answered or skipped
- [ ] submit route uses idempotent `client_response_id`
- [ ] completed Q/A tool result renders in the timeline
- [ ] fallback continuation refreshes transcript/runtime state
- [ ] tests cover response construction and pending prompt reconciliation
