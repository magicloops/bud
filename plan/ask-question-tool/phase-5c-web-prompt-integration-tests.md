# Phase 5c: Web Prompt Integration Tests

**Status**: Draft
**Parent**: [phase-5-integration-tests.md](./phase-5-integration-tests.md)

---

## Objective

Verify that the reference web client handles `ask_user_questions` prompts as a real thread workflow.

This phase covers pending prompt rendering, response payload construction, submission behavior, and transcript/runtime reconciliation.

## Scope

Primary web areas:

- `web/src/features/threads/thread-message-state.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/components/workbench/question-request-card.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/message-renderers/tools/ask-user-questions.tsx`
- `web/src/routes/$budId/$threadId.tsx`

Expected test files:

- `web/src/features/threads/thread-message-state.test.ts`
- `web/src/components/workbench/question-request-card.test.tsx` once a DOM/component test harness exists
- `web/src/routes/thread-question-response.integration.test.tsx` only if route-level component testing is available

## Test Cases

### Prompt Sources

- live `agent.tool_call` event renders one pending `ask_user_questions` form
- `/agent/state` bootstrap with `phase: "waiting_for_user"` renders one pending form after refresh
- reconnect/resync does not duplicate the pending prompt
- `agent.tool_result`, `final`, and `canceled` clear the synthetic pending prompt

### Response Payloads

- boolean question submits `{ kind: "boolean", value: true | false }`
- single-choice question submits `{ kind: "single_choice", choice_id }`
- multi-choice question submits `{ kind: "multi_choice", choice_ids }`
- text question submits `{ kind: "text", value }`
- number question submits `{ kind: "number", value }`
- per-question skip submits `{ status: "skipped" }`
- skip-all submits skipped answers for each question
- `client_response_id` is generated once per submit attempt and reused for retry

### Submission And Reconciliation

- successful `live_tool_result` response leaves stream reconciliation to SSE
- successful `fallback_user_message` response refreshes latest transcript and `/agent/state`
- successful `already_answered` response refreshes latest transcript and `/agent/state`
- failed submit displays an error and keeps the form editable
- duplicate click while submitting does not send two requests

### Completed Transcript Rendering

- completed tool result renders each question with its answer
- skipped responses render a stable skipped state
- malformed completed payload falls back without crashing the timeline

## Harness Notes

- Start with pure state/helper tests if the web package does not already have a DOM test harness.
- Add a DOM/component harness deliberately before testing `QuestionRequestCard` behavior. Prefer the same test runner and package-local command style used by the web package.
- Mock `apiFetchJson` at the boundary for submit behavior; route tests should assert URL, method, body, and refresh side effects.
- Keep visual polish checks manual unless a browser test setup already exists.

## Acceptance Criteria

- [ ] pure tests cover prompt overlay/reconciliation from SSE and `/agent/state`
- [ ] payload tests cover every v1 question kind plus per-question skip and skip-all
- [ ] submit tests cover live, fallback, already-answered, and failure behavior
- [ ] completed renderer tests cover answered, skipped, and malformed payloads
- [ ] any new web test harness is documented in the web specs
