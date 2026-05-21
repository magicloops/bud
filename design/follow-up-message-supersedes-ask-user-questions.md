# Design: Follow-Up Messages Supersede Ask User Questions

Status: Draft

Created: 2026-05-21

Audience: Backend, web, iOS/mobile

Related:
- [../service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [../service/src/routes/threads/threads.spec.md](../service/src/routes/threads/threads.spec.md)
- [../web/src/features/threads/threads.spec.md](../web/src/features/threads/threads.spec.md)
- [../web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)
- [../web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)
- [../docs/proto.md](../docs/proto.md)
- [./ask-user-questions-tool-contract.md](./ask-user-questions-tool-contract.md)
- [./streaming-tool-call-assembly.md](./streaming-tool-call-assembly.md)

---

## 1. Summary

When the agent calls `ask_user_questions`, the service is not actively doing work. The provider call has completed, the request has been normalized and persisted, and the agent loop is paused waiting for a tool response from the human.

The current web UI does not express that distinction. It treats the runtime as `streaming` because `/agent/state.active` remains true, shows loading indicators, and disables the composer with "Answer or skip the pending questions to continue." That makes a human-input prompt feel like a background operation, and it gives users no simple way to continue if they do not want to interact with the structured question UI.

The recommended direction is to make ordinary message sending resilient:

- clients should keep the composer enabled while the thread is `waiting_for_user`
- `POST /api/threads/:thread_id/messages` should become the service-owned recovery path
- if the thread has a pending `ask_user_questions` request, the service should close that request with skipped answers before accepting the follow-up message
- the old waiting turn should finish without another model continuation
- the follow-up message should start a fresh agent turn with the skipped tool result already present in transcript context

This keeps web simple and gives mobile the same recovery behavior without requiring it to know the pending request id.

---

## 2. Current Behavior

### 2.1 Service

`AgentService.startUserMessage(...)` starts a new turn for each accepted user message. It creates runtime turn state, ensures terminal context, and runs `runAgentFlow(...)`.

When the model calls `ask_user_questions`, the agent flow:

1. creates a durable question request row
2. registers an in-memory waiter in `AgentUserQuestionRegistry`
3. emits `agent.tool_call` through `AgentTranscriptWriter`
4. sets runtime phase to `waiting_for_user` with `pending_tool`
5. awaits the response route

`submitQuestionResponse(...)` is the only first-class completion path today. If the live waiter still exists, it resolves the waiter and the original agent turn continues with a tool result. If the process restarted and no waiter exists, the service persists a fallback user message containing the answers and starts a new turn.

The normal message route, `POST /api/threads/:threadId/messages`, does not know about pending question requests. It persists the new user message and calls `startUserMessage(...)`. If the web client allowed this while a question waiter was live, the service could overlap a new turn with the old waiting turn because `startUserMessage(...)` replaces the cancellation controller for that thread.

`cancelThread(...)` is also not the right primitive for this product behavior. It marks pending requests as canceled and rejects waiters, but the desired outcome is a completed tool response where every answer is skipped.

### 2.2 Web

The thread route has a coarse UI status of `idle`, `dispatching`, or `streaming`.

Initial bootstrap and refresh map any active agent state to `streaming`, including `phase: "waiting_for_user"`. `useAgentStream` also marks the route as `streaming` when it receives `agent.tool_call`.

The workbench then uses that status in two places:

- `ThinkingIndicator` is visible whenever status is not `idle`
- `CommandComposer` shows a loading send button whenever status is not `idle`

The route also detects a pending `ask_user_questions` synthetic tool row and passes a `disabledReason` to the composer, so the text input is disabled until the user answers or skips through the question card.

The question card itself already has the right structured answer and skip-all behavior. The missing piece is letting a normal follow-up message supersede the prompt.

---

## 3. Goals

- Treat `waiting_for_user` as a paused human-input phase, not agent work.
- Let the user send a normal follow-up message instead of interacting with the structured question card.
- Make the normal message endpoint close pending `ask_user_questions` requests as skipped so web, mobile, and future clients share the same recovery behavior.
- Handle stale durable question requests after service restart or missed tool-response delivery.
- Avoid overlapping agent turns on the same thread.
- Keep the existing explicit answer/skip-all question-card flow working.
- Preserve ownership rules: only the authorized thread owner can close the request or send the follow-up.

## 4. Non-Goals

- Do not auto-skip terminal tools or other future tools that may have real side effects.
- Do not remove the `ask_user_questions` response route.
- Do not require clients to call a special "skip and send" route.
- Do not ask the model to handle this as assistant prose.
- Do not introduce a new transcript role for superseded prompts.

---

## 5. Recommended Contract

The service should define this rule:

> When an authorized user sends a message to a thread that has a pending `ask_user_questions` request, the service closes the pending request with skipped answers before starting the follow-up turn.

This should be the default behavior of:

```text
POST /api/threads/:thread_id/messages
```

The client request body does not need to include the question request id. The service already knows which thread is authorized and can resolve current runtime state plus durable pending question rows.

The response can remain compatible with the existing message-create response, with optional additive metadata for clients that want immediate reconciliation:

```json
{
  "message": {},
  "agent": {},
  "superseded_question_requests": [
    {
      "request_id": "qr_01J...",
      "turn_id": "01TURN...",
      "tool_client_id": "019...",
      "reason": "followup_message"
    }
  ]
}
```

Clients should not need this field for correctness because SSE and `/agent/state` should also converge, but it is useful for immediate local cleanup if the client sends while the stream is disconnected.

---

## 6. Service Design

### 6.1 Add an agent-owned supersession operation

Add an `AgentService` operation along these lines:

```ts
supersedePendingUserQuestionsForFollowUp({
  threadId,
  actingUserId,
  followUpMessageClientId,
}): Promise<SupersededQuestionRequest[]>
```

The operation should be owned by the agent service rather than the route module because it has to coordinate runtime waiters, durable request state, transcript writing, and final SSE emission.

Recommended behavior:

1. Run after the message route has authorized the thread and checked duplicate `client_id` writes.
2. Acquire a per-thread transition lock so question response submission, follow-up sends, cancellation, and new turns cannot race each other into overlapping runtime state.
3. Find the active runtime pending tool if it is `ask_user_questions`.
4. Also query durable pending question requests for the thread so stale prompts can be closed after service restart.
5. Generate an `ask_user_questions_response_v1` where every question is `skipped` with `skip_reason: "user_skipped"`.
6. Mark the request `answered`, set `answered_by_user_id`, and store the generated response plus tool result.
7. Persist and emit the canonical `ask_user_questions` tool result row using the original tool `client_id`, `turn_id`, and `call_id`.
8. Finish the old waiting turn without another model call.
9. Clear runtime pending state and any live waiter.
10. Return supersession metadata to the message route.

Use the existing skip reason for v1. A new `superseded_by_user_message` answer status or skip reason would create more client contract surface than we need. The reason can live in row metadata, tool-result metadata, and final event metadata.

### 6.2 Do not continue the old model turn

Calling the existing question-response path and immediately starting a new message turn is tempting, but it is the wrong behavior. The existing live response path resumes the original agent loop, which can cause the old turn to make another model call and produce a response about skipped answers while the follow-up turn is also starting.

The follow-up path needs a distinct control outcome:

- record the skipped tool result
- close the waiting turn
- do not continue the old provider loop
- then start the new turn from the follow-up message

There are two reasonable implementation shapes.

Option A: waiter resolves with a superseded outcome.

`AgentUserQuestionRegistry` can resolve the waiter with a value that contains the skipped tool result plus `continueAgentTurn: false`. `runAgentFlow(...)` then uses its existing transcript writer context to record the tool result and emit a final event without invoking the provider again.

Pros:

- keeps transcript writing in the existing agent flow
- avoids duplicating tool-result emission logic in a route-time cleanup helper
- lets the live turn finish itself coherently

Cons:

- requires a new branch in the tool-loop control flow
- the message route must wait until the old turn has finalized before starting the follow-up turn

Option B: service helper writes the closeout directly.

The new `AgentService` helper can mark the request answered, persist the tool result, emit `agent.tool_result`, reject or clear the waiter, emit final, and clear runtime state.

Pros:

- gives the message route a direct synchronous closeout operation
- handles stale durable requests and live requests through one helper

Cons:

- duplicates logic that `runAgentFlow(...)` and `AgentTranscriptWriter` currently own
- needs careful idempotency so a live flow cannot also write the same tool result

Recommendation: prefer Option A for live waiters and use a service helper fallback for stale durable requests with no live waiter. The shared helper should still centralize response generation and request-row updates.

### 6.3 Final event semantics

The old waiting turn should emit a final event so clients clear pending synthetic rows and leave the loading state.

For compatibility, v1 should use:

```json
{
  "status": "canceled",
  "reason": "superseded_by_user_message"
}
```

Existing clients already clear pending tools and draft assistant rows for `canceled`. The `reason` field is additive and lets updated clients distinguish user supersession from an explicit cancel button. A future protocol cleanup can add `status: "superseded"` if there is enough value, but v1 should not require every client to learn a new final status before this behavior is safe.

### 6.4 Ordering

For a live waiting turn, the observable order should be:

```text
agent.tool_result     # ask_user_questions, all answers skipped
agent.final           # status canceled, reason superseded_by_user_message
message created       # follow-up user message is persisted
new agent turn starts # normal stream events for the follow-up
```

The route should not call `startUserMessage(...)` for the follow-up until the previous waiting turn has reached a terminal runtime state.

For a stale durable request with no live waiter, there may be no live clients attached to the old turn. The service should still persist the skipped tool result so future transcript replay sees a closed tool call before the follow-up user message.

### 6.5 Idempotency and races

The message route already handles duplicate `client_id` user messages. Supersession should run only after duplicate detection so a retry of an already-created message does not re-close prompts.

The request-row update should be guarded by `status = "pending"`. If two clients race:

- explicit question response wins if it updates the row first
- follow-up supersession wins if it updates the row first
- the loser observes `already_answered` or no pending request and refreshes state

If multiple pending durable requests exist for one thread, the runtime pending request should be closed first. For stale rows with no runtime state, close the oldest pending request first and consider marking additional stale pending requests skipped in the same operation. The implementation should log this case because the steady-state model expects at most one live human-input prompt per thread.

---

## 7. Web Design

### 7.1 Split waiting from loading

The web route should stop mapping every active agent state to `streaming`.

Recommended route-level state:

- `idle`
- `dispatching`
- `streaming`
- `waiting_for_user`

`/agent/state.phase === "waiting_for_user"` and final `ask_user_questions` tool calls should move the UI into `waiting_for_user`, not `streaming`.

`ThinkingIndicator` should render only for actual agent work:

- `dispatching`
- `streaming`
- runtime phases such as starting, thinking, or tool running

It should not render for `waiting_for_user`.

### 7.2 Keep the composer enabled

The composer should remain enabled while a pending question card is visible.

Change the current route behavior from:

```text
disabledReason = "Answer or skip the pending questions to continue."
```

to either no disabled reason or an informational hint near the pending question card. The send button spinner should be tied to `dispatching`, not to any non-idle status.

When the user sends a follow-up while a question is pending, the web client should call the normal message endpoint. It should not synthesize and submit a skip-all question response itself as the primary path because that leaves mobile and other clients to rediscover the same workaround.

### 7.3 Reconcile the pending card

After the normal message POST succeeds, the web client can clear or soften the pending question card if the response includes `superseded_question_requests`.

Even without that field, convergence should come from:

- `agent.tool_result` replacing the pending synthetic tool row with the completed skipped tool row
- `agent.final` clearing old pending state
- `/agent/state` refresh showing no pending tool for the old turn
- `/messages` bootstrap returning the persisted skipped tool result

The existing explicit answer and skip-all buttons should continue to use the question-response route. Their behavior does not need to change except that they should race safely with a follow-up send.

---

## 8. Mobile And Other Clients

Mobile should not need a special recovery route.

Recommended client rule:

- render `waiting_for_user` prompts when convenient
- keep the normal composer enabled
- send follow-up text through `POST /api/threads/:thread_id/messages`
- refresh `/agent/state` after send if the stream is not attached

This gives mobile a durable escape hatch for stale prompt rows. If a tool call is sitting in history but no live tool response can be delivered, the next ordinary user message closes it as skipped and starts a fresh turn.

---

## 9. Protocol And Spec Impact During Implementation

Implementation should update:

- `docs/proto.md` for follow-up-message supersession semantics, optional message response metadata, and `agent.final.reason`
- `service/src/agent/agent.spec.md` for the superseded waiting-turn path
- `service/src/routes/threads/threads.spec.md` for message-route behavior while pending questions exist
- `web/src/features/threads/threads.spec.md` for the `waiting_for_user` UI phase and stream reconciliation
- `web/src/components/workbench/workbench.spec.md` for composer and thinking-indicator behavior
- `web/src/routes/$budId/budId.spec.md` to remove the current statement that normal composer input is disabled while a structured prompt is visible
- mobile handoff docs or references that describe the `ask_user_questions` prompt lifecycle

No Bud daemon protocol changes are required.

---

## 10. Risks

- Overlapping turns are the main correctness risk. The service must serialize the old waiting-turn closeout before starting the follow-up turn.
- Route-owned transcript writes can drift from `runAgentFlow(...)` transcript behavior. Keep closeout logic in agent-owned helpers where possible.
- A `canceled` final status with a supersession reason is pragmatic, but clients may need UI language that does not imply the user hit cancel.
- Durable stale prompt cleanup needs careful replay behavior so future model context sees the skipped tool result before the follow-up user message.
- Multiple stale pending requests in one thread likely indicate an earlier bug. The first implementation should handle them defensively and log the condition.

---

## 11. Open Questions

1. Should the message-create response include `superseded_question_requests`, or is stream plus state refresh enough?
2. Should v1 use `final.status: "canceled"` with `reason: "superseded_by_user_message"`, or should we first update clients to safely handle `succeeded` with no assistant text?
3. Should the service close all stale pending question requests for a thread, or only the current runtime request plus one durable fallback row?
4. Do we need a generic per-thread agent-turn mutex before this feature, or can the supersession helper provide enough serialization locally?
5. Should explicit skip-all from the question card continue the original turn, while follow-up skip-all stops it? The recommendation is yes, because those are different user intents.
6. Should follow-up supersession resolve thread attention or push-notification state differently from explicit answers?

---

## 12. Acceptance Criteria

- When a pending `ask_user_questions` card is visible, the web composer remains enabled and does not show a loading spinner.
- Sending a follow-up message through the normal message route skips every pending question server-side.
- The old waiting turn reaches a terminal runtime state before the follow-up turn starts.
- No second model continuation is made for the old waiting turn after follow-up supersession.
- A service restart with a durable pending question request still lets the next normal message close the prompt as skipped.
- Explicit question answers and explicit skip-all continue to work through the existing response route.
- Web and mobile can recover from stale pending prompts without knowing the request id.
