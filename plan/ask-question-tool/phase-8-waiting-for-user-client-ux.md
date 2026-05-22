# Phase 8: Waiting-For-User Client UX

**Status**: Implemented
**Parent**: [implementation-spec.md](./implementation-spec.md)
**Depends On**: [phase-7-follow-up-supersession-service.md](./phase-7-follow-up-supersession-service.md)
**Design**: [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md)

---

## Objective

Make first-party clients treat `waiting_for_user` as a paused human-input state rather than background agent work.

For the reference web client:

- no thinking/loading spinner while the agent is waiting on `ask_user_questions`
- composer remains enabled while the question card is visible
- sending a follow-up message uses the normal message route
- the pending question card clears through stream/state convergence
- explicit answer and explicit skip-all keep using the question-response route

Mobile should be able to follow the same backend contract without a special skip-and-send route.

## Current Problem

The web route currently collapses every active runtime state into `streaming`, including `phase: "waiting_for_user"`.

That causes two incorrect UI behaviors:

- `ThinkingIndicator` remains visible even though the service is waiting for the user
- `CommandComposer` is disabled with a pending-question reason, so the user cannot send a normal follow-up message

This is product friction and also hides the service-level recovery path needed for stale prompts.

## Web State Model

Extend the thread route status model to distinguish waiting from streaming:

```ts
type ThreadAgentUiStatus =
  | "idle"
  | "dispatching"
  | "streaming"
  | "waiting_for_user";
```

Mapping rules:

- `/agent/state.phase === "waiting_for_user"` maps to `waiting_for_user`
- live `agent.tool_call` with `name: "ask_user_questions"` maps to `waiting_for_user`
- live non-question tool calls map to `streaming`
- assistant message streaming maps to `streaming`
- `final` maps to `idle`
- message send request in flight maps to `dispatching`

Do not infer active work from `/agent/state.active` alone.

## Composer Behavior

The composer should remain enabled during `waiting_for_user`.

Specific changes:

- remove the current pending-question `disabledReason`
- keep model/reasoning controls enabled unless another existing rule disables them
- show the send-button spinner only during `dispatching`
- do not show the send-button spinner merely because status is `waiting_for_user`
- do not have the web client synthesize and submit a skip-all response before sending a follow-up message

The normal follow-up path is:

```text
POST /api/threads/:thread_id/messages
```

The service owns prompt closure.

## Thinking Indicator

`ThinkingIndicator` should render for actual agent work states:

- `streaming`

It should not render for `waiting_for_user`.

If the UI needs a visual hint that a prompt exists, that belongs on the pending question card, not the global thinking/loading indicator.

## Question Card Behavior

Keep existing structured prompt controls:

- answer selected questions
- per-question skip
- skip all

These still submit through:

```text
POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
```

Explicit skip-all means "continue the original turn with skipped answers." It is intentionally different from typing a follow-up message, which means "close this prompt and continue from my new message."

## Reconciliation

The web client should clear pending question UI through existing authoritative channels:

- `agent.tool_result` upserts the completed skipped tool row
- `final` for the old turn removes pending synthetic rows
- `/agent/state` refresh no longer includes the pending tool
- `/messages` returns the persisted completed tool row after refresh

The message-create response should not carry supersession-specific cleanup metadata.

The final event may be:

```json
{
  "status": "succeeded",
  "reason": "superseded_by_user_message"
}
```

with no `message_id` or `text`. Web reducers should tolerate successful finals without assistant text.

## Mobile Handoff

Update [mobile-client-handoff.md](./mobile-client-handoff.md) to add:

- `waiting_for_user` is not a background loading state
- the composer can stay enabled while a prompt is visible
- follow-up messages go through the normal message route
- the service will skip pending prompts server-side before starting the follow-up turn
- clients should refresh `/agent/state` after message send if no stream is attached
- explicit prompt answers and explicit skip-all still use the question-response route

## Tests

Add focused web tests for:

- bootstrap `/agent/state.phase = "waiting_for_user"` sets UI status to waiting, not streaming
- live `agent.tool_call` for `ask_user_questions` sets UI status to waiting
- non-question tool calls still show streaming/loading behavior
- `ThinkingIndicator` is hidden in waiting state
- composer input remains enabled in waiting state
- send button spinner is shown only during dispatching
- follow-up send calls only `/messages`, not the question-response route
- `final.status = "succeeded"` with no assistant text clears pending rows
- completed skipped tool result replaces the pending question row

## Docs And Specs

Update when implementing:

- `web/src/routes/$budId/budId.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/lib/lib.spec.md`
- `plan/ask-question-tool/mobile-client-handoff.md`
- `docs/proto.md`
- `plan/ask-question-tool/progress-checklist.md`
- `plan/ask-question-tool/validation-checklist.md`

## Acceptance Criteria

- [x] web treats `waiting_for_user` as its own UI status
- [x] thinking/loading indicators are hidden while waiting for user input
- [x] composer remains enabled while a pending question card is visible
- [x] follow-up send uses only the normal message route
- [x] explicit answer/skip-all still use the question-response route
- [x] web tolerates `final.status: "succeeded"` without assistant text
- [x] mobile handoff documents the follow-up recovery contract

## Implementation Notes

- Implemented in `web/src/routes/$budId/$threadId.tsx`, `web/src/features/threads/use-agent-stream.ts`, and the shared workbench status props.
- The top bar now displays `Waiting`, while the global thinking indicator remains hidden for `waiting_for_user`.
- The composer remains enabled during `waiting_for_user`; its send-button spinner is tied only to `dispatching`.
