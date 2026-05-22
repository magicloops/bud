# Phase 7: Follow-Up Supersession Service Contract

**Status**: Implemented
**Parent**: [implementation-spec.md](./implementation-spec.md)
**Design**: [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md)

---

## Objective

Make normal follow-up message sends a service-owned recovery path for pending `ask_user_questions` prompts.

If an authorized user sends `POST /api/threads/:thread_id/messages` while the thread has pending `ask_user_questions` rows, the service should:

1. close every pending question request for that thread as skipped
2. record the active prompt closeout as a canonical skipped tool result
3. finish the old waiting turn without another model call
4. persist the new user message
5. start a fresh agent turn from that message

The message-create response remains unchanged. Clients should not need a request id or a special skip-and-send endpoint.

## Current Problem

The current implementation has only one completion path for `ask_user_questions`: the question-response route. A live response resolves the waiter and continues the original turn. A fallback response with no live waiter persists a user-visible Q/A message and starts a new turn.

That is correct for explicit form answers, but it is not enough for follow-up messages:

- the normal message route does not detect `waiting_for_user`
- the web composer currently prevents follow-up sends, but mobile or stale clients could still hit the route
- `startUserMessage(...)` can replace the thread cancellation controller while the old waiting flow is still alive
- using the explicit question-response path for follow-up sends would continue the old model turn and risk overlapping responses

## Service Contract

`POST /api/threads/:thread_id/messages` keeps returning:

```json
{
  "message_id": "uuid",
  "client_id": "019..."
}
```

Do not add `superseded_question_requests` or any other cleanup-specific field to this route response.

The route should return only after the old prompt is durably closed enough that:

- `/agent/state` no longer exposes the stale prompt
- the service has emitted `agent.tool_result` and `final` for the active waiting turn when a live waiter existed
- persisted transcript rows are sufficient for future replay of stale prompt closeouts

## Sequencing

Recommended message-route order:

1. Authorize the thread through the existing ownership helper.
2. Resolve model selection.
3. Check duplicate `client_id` user message and return the existing row before side effects.
4. Ask `AgentService` to supersede pending user questions for this follow-up.
5. Run terminal context sync after supersession if the thread is no longer actively doing agent work.
6. Persist the new user message.
7. Update thread message metadata.
8. Start the new agent turn.

Running supersession before context sync lets the service avoid treating a paused human-input wait as active background work.

## AgentService Changes

Add an agent-owned operation such as:

```ts
supersedePendingUserQuestionsForFollowUp(args: {
  threadId: string;
  answeredByUserId: string;
}): Promise<{ superseded: number }>
```

The return value is internal. It should not be serialized in the message-create response.

This operation should:

- acquire the per-thread transition lock described below
- inspect runtime state for an active `ask_user_questions` pending tool
- load every durable pending `agent_question_request` row for the thread
- build a generated `ask_user_questions_response_v1` where every question is skipped with `skip_reason: "user_skipped"`
- mark every pending row `answered`
- stamp `answered_by_user_id` with the acting user
- persist the generated client response and tool result on each row
- resolve the live waiter with a superseded outcome when a live waiter exists
- close stale durable rows without live waiter continuation
- log when more than one pending row existed

## Transition Lock

Add a short-lived per-thread transition lock inside `AgentService`.

Use it around state transitions:

- explicit question response submission
- follow-up supersession
- explicit cancel
- new user-message turn startup

Do not hold it across:

- provider calls
- terminal sends/observes
- web-view tool execution
- the human-input wait itself

The lock should only serialize state handoffs. A long-running mutex across the whole agent turn would prevent the exact follow-up recovery this phase is adding.

## Live Waiter Outcome

Extend the user-question waiter result so the live agent loop can distinguish explicit answers from follow-up supersession.

Suggested shape:

```ts
type ResolvedUserQuestionResponse =
  | {
      continuation: "continue";
      response: AskUserQuestionsResponse;
      toolResult: AskUserQuestionsToolResult;
    }
  | {
      continuation: "supersede";
      response: AskUserQuestionsResponse;
      toolResult: AskUserQuestionsToolResult;
      reason: "superseded_by_user_message";
    };
```

Explicit answer and explicit skip-all use `continuation: "continue"`.

Follow-up supersession uses `continuation: "supersede"`.

In `runAgentFlow(...)`, the superseded outcome should:

1. build the normal executed `ask_user_questions` tool payload
2. record the tool result row
3. record the provider-ledger tool-result item if the current live flow has an `llm_call_id`
4. emit `final` for the old turn with `status: "succeeded"` and `reason: "superseded_by_user_message"`
5. finish runtime state and clear cancellation state
6. return without appending a provider conversation tool result or making another model call

## Final Event

The old waiting turn should emit:

```json
{
  "turn_id": "01TURN...",
  "status": "succeeded",
  "reason": "superseded_by_user_message"
}
```

Do not include `message_id` or `text`; no assistant message was created.

Explicit cancel continues to use `status: "canceled"`.

## Stale Durable Rows

Close all pending question rows for the thread, even though steady-state should only have one current row.

For stale rows with no live waiter:

- mark the request `answered`
- store the generated skipped response and tool result
- persist a canonical skipped tool row if enough metadata is present and no row already exists for the tool `client_id`
- do not emit live SSE for old stale turns unless there is active runtime state

The goal is that future transcript replay sees the prompt closed before the follow-up user message.

## Idempotency And Races

- Duplicate message `client_id` retry should return the existing user message before supersession side effects.
- Question-row updates should be guarded by `status = "pending"`.
- Explicit answer and follow-up supersession race through the same transition lock and row status compare/update.
- If explicit answer wins, the follow-up message should not overwrite the accepted response.
- If follow-up supersession wins, an explicit answer submit should observe `already_answered` or a stable conflict and refresh.

## Tests

Add focused service tests for:

- normal message send while `waiting_for_user` closes the pending request as skipped
- message-create response shape remains unchanged
- old waiting turn emits `final.status = "succeeded"` with `reason = "superseded_by_user_message"`
- old waiting turn does not make another model call after supersession
- follow-up turn starts only after the old waiting turn is terminal
- duplicate message `client_id` does not re-run supersession
- all pending durable rows for the thread are closed
- explicit answer racing with follow-up supersession has one winner
- explicit skip-all still continues the original turn
- explicit cancel still marks pending requests canceled, not answered/skipped

## Docs And Specs

Update when implementing:

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md` if repository helpers or metadata meaning changes
- `plan/ask-question-tool/progress-checklist.md`
- `plan/ask-question-tool/validation-checklist.md`

## Acceptance Criteria

- [x] normal follow-up message sends close pending `ask_user_questions` rows server-side
- [x] message-create response shape is unchanged
- [x] all pending rows for the thread are marked answered/skipped
- [x] live supersession records a skipped tool result and emits `final.status: "succeeded"`
- [x] old waiting turn does not continue to another model call
- [x] follow-up turn starts after the old waiting turn reaches terminal runtime state
- [x] duplicate message retry is idempotent and does not re-close prompts
- [x] explicit answer and explicit skip-all still continue the original turn

## Implementation Notes

- Implemented in `service/src/agent/agent-service.ts`, `service/src/agent/user-question-repository.ts`, `service/src/agent/user-question-registry.ts`, and `service/src/routes/threads/messages.ts`.
- The route calls supersession after duplicate `client_id` lookup and before context sync or user-message persistence.
- `AgentService` uses a per-thread transition guard around startup, cancel, explicit question response, and follow-up supersession state handoffs.
- Live supersession waits for the old turn closeout callback before the message route continues; stale durable rows are closed and get a canonical skipped tool row when no row already exists for the tool `client_id`.
