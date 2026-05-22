# Phase 2: Agent Runtime Tool Flow

**Status**: Draft
**Parent**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Wire `ask_user_questions` into the agent loop so the model can pause for human input and continue when the user responds.

Phase 2 owns:

- model-facing tool schema
- directive parsing
- runtime `waiting_for_user` state
- pending waiter lifecycle
- live tool-result continuation
- cancellation and restart fallback
- transcript/provider-ledger consistency

## Tasks

### 1. Tool Definition

Add `ask_user_questions` to `CANONICAL_TOOLS` in `service/src/agent/model-runner.ts`.

The JSON Schema should expose only the model input fields:

- `title`
- `body`
- `submit_label`
- `skip_all_label`
- `questions`

Questions should expose:

- `question_id`
- `kind`
- `label`
- `help_text`
- `importance`
- `choices`
- `default_answer`
- type-specific constraints

The schema should keep `additionalProperties: false` where practical, but the service normalizer remains the authority because provider schema behavior can differ.

### 2. Directive Types

Extend `AgentToolCallDirective` in `service/src/agent/contracts.ts`:

```typescript
| {
    type: "tool_call";
    tool: "ask_user_questions";
    request: AskUserQuestionsRequest;
    callId: string;
  }
```

Update:

- `toolNameForConversation(...)`
- `buildToolArgs(...)`
- `buildEffectiveToolArgs(...)`
- any type guards or unions that assume terminal/web-view only

Add tests in `contracts.test.ts`.

### 3. Parse Provider Tool Calls

Update `AgentModelRunner.extractToolCallDirective(...)`:

- handle `ask_user_questions`
- run model input through the normalizer
- return `null` or a structured invalid-tool result path if normalization fails

Preferred behavior: fail the current model response as a structured agent error when the provider emits an invalid `ask_user_questions` payload. Do not expose partially valid forms to clients.

### 4. Runtime Phase

Extend `AgentRuntimePhase` in `service/src/runtime/agent-runtime-state.ts` with:

```typescript
| "waiting_for_user"
```

Add a method such as:

```typescript
setPendingUserQuestions(threadId, pendingTool, cursor)
```

It should:

- set `phase = "waiting_for_user"`
- set `pendingTool`
- clear `draftAssistant`
- preserve `active = true`
- leave `can_cancel = true`

Update runtime tests and web-facing API types in Phase 3.

### 5. Waiter Registry

Add a small in-memory registry, for example `AgentUserQuestionRegistry`.

Responsibilities:

- register a pending `question_request_id` with a promise resolver/rejecter
- resolve it when the response route accepts an answer
- reject it on cancel
- reject or expire it on service shutdown/cleanup if needed
- expose whether a pending live waiter exists for route response continuation

The registry should be thread/request scoped, not global call-id only.

### 6. Tool Executor

Add a user-question executor, for example `user-question-tool-executor.ts`.

Execution flow:

1. create `agent_question_request` row with normalized request
2. emit `agent.tool_call` with the normalized request plus `request_id`
3. set runtime phase to `waiting_for_user`
4. update thread attention metadata with `human_input_requested`
5. register the live waiter
6. await response or cancellation
7. return an `ExecutedAgentTool`-compatible result carrying the generated tool result

The executor should not touch the terminal session.

### 7. Agent Loop Integration

Update `AgentService.runAgentFlow(...)`:

- branch `ask_user_questions` separately from terminal and web-view tools
- allocate `toolClientId` before emitting, as today
- record assistant intermediate text before the tool if present
- execute the question tool by awaiting the user response
- on response, record the tool result row and provider tool-result item
- append one provider `tool_result` block to the conversation and continue the loop

The service should continue serial provider-ordered tool execution. If a response contains multiple tool calls and one is `ask_user_questions`, subsequent tool calls should not execute until the user response returns.

### 8. Response Route Continuation

When the Phase 1 response route accepts a response:

- if a live waiter exists, resolve it and return `continuation: "live_tool_result"`
- if no live waiter exists and the request was pending/answered after restart, create a normal user message containing `summary_markdown`, then call `agentService.startUserMessage(...)`; return `continuation: "fallback_user_message"`
- if the same `client_response_id` was already accepted, return `continuation: "already_answered"`

Fallback user message metadata:

```json
{
  "source": "ask_user_questions",
  "question_request_id": "qr_01J...",
  "schema": "ask_user_questions_tool_result_v1"
}
```

### 9. Transcript Behavior

Completed live path:

- persist one tool row with `name: "ask_user_questions"`
- `message.content` is the JSON tool result payload
- `message.metadata` includes `turn_id`, `call_id`, timing, model selection, and `question_request_id`

Fallback path:

- persist one user row containing the Q/A summary
- metadata marks the row as `source: "ask_user_questions"`
- start a new normal agent turn from that user row

Avoid persisting the same answer as both a tool row and a user row in the live path.

### 10. Cancellation

On `POST /api/threads/:thread_id/cancel`:

- reject pending question waiters for that thread
- mark pending question requests for the active turn as `canceled`
- clear `waiting_for_user` runtime state through normal `finishTurn`

Answering a canceled request should return `409` or `400` with a stable code such as `question_request_not_pending`.

## Acceptance Criteria

- [ ] model tool schema includes `ask_user_questions`
- [ ] directive parsing produces a normalized question request
- [ ] runtime phase supports `waiting_for_user`
- [ ] pending question requests appear in `/agent/state` and `agent.tool_call`
- [ ] live responses continue the original tool-call loop
- [ ] fallback responses after missing waiter start a new user-message turn
- [ ] cancel rejects waiters and marks requests canceled
- [ ] provider ledger and transcript rows remain replayable
- [ ] tests cover live response, cancel, and fallback continuation
