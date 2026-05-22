# Phase 5b: Agent Continuation Integration Tests

**Status**: Draft
**Parent**: [phase-5-integration-tests.md](./phase-5-integration-tests.md)

---

## Objective

Verify the agent runtime behavior around `ask_user_questions` from model tool call through continuation.

This phase focuses on the service-side agent loop: the model asks, the service persists and exposes a prompt, the user response resolves or falls back, and the transcript/provider ledger records the correct result.

## Scope

Primary service areas:

- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/user-question-tool-executor.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/db/provider-ledger-repository.ts` or equivalent provider ledger path

Expected test files:

- `service/src/agent/ask-user-questions-continuation.integration.test.ts`
- focused runtime event assertions in an existing runtime test file if that matches current patterns

## Test Cases

### Live Continuation

- fake model emits one `ask_user_questions` tool call with valid arguments
- service creates a pending `agent_question_request` row
- runtime enters `phase: "waiting_for_user"`
- emitted `agent.tool_call` contains `name: "ask_user_questions"` and normalized request args
- user response resolves the registered waiter
- agent receives one `ask_user_questions_tool_result_v1` payload
- fake model continues to a final assistant message after the tool result
- transcript contains one completed tool row for the question request
- provider ledger stores the tool-result item with the original `call_id`

### Fallback Continuation

- pending request exists without an in-memory waiter
- response submission stores the same generated tool-result payload
- service creates a normal user message containing the question/answer summary
- service starts a new agent turn from that follow-up message
- fallback message repeats each question before its answer
- runtime does not remain stuck in `waiting_for_user`

### Cancel And Cleanup

- cancel while waiting rejects the waiter
- pending request row changes to `canceled`
- runtime clears `pending_tool`
- answering the canceled request returns a stable conflict
- no duplicate assistant/tool rows are written after cancel

### Invalid Model Payload

- fake model emits malformed question args
- service rejects the tool call before persisting or emitting a client-visible prompt
- runtime returns to a terminal error/final state according to existing agent error behavior
- no `agent_question_request` row is created

## Harness Notes

- Use deterministic fake provider/model events; do not depend on live OpenAI.
- Stub terminal and web-view tools only enough to satisfy agent service dependencies.
- Capture runtime events from the event bus and assert ordering where order is part of the contract.
- Use the real repository layer for question requests, transcript rows, and provider ledger rows.
- Keep one integration test per high-value path. Leave detailed schema validation permutations in unit tests.

## Acceptance Criteria

- [ ] live continuation test proves waiting, answering, model continuation, transcript, and provider ledger behavior
- [ ] fallback continuation test proves no-waiter recovery creates a user follow-up and starts a new turn
- [ ] cancel test proves request/runtime cleanup and stable response rejection
- [ ] malformed model payload test proves fail-closed behavior before client exposure
- [ ] tests run with the package-local service test command
