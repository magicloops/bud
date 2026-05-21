# Ask User Questions Tool Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the service and web implementation lands.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Service Contract And Persistence

### Contracts

- [ ] request schema constants exist
- [ ] response schema constants exist
- [ ] tool-result schema constants exist
- [ ] question request normalizer exists
- [ ] client response validator exists
- [ ] tool-result builder repeats each question before each answer
- [ ] summary markdown builder exists
- [ ] contract tests cover valid and invalid payloads

### Schema And Migration

- [ ] `agent_question_request` added to `service/src/db/schema.ts`
- [ ] owner/status/thread indexes added
- [ ] `pnpm --dir /Users/adam/bud/service db:push` run successfully
- [ ] `pnpm --dir /Users/adam/bud/service db:generate` run successfully
- [ ] generated migration reviewed
- [ ] `service/src/db/db.spec.md` updated
- [ ] `service/drizzle/migrations/migrations.spec.md` updated

### Route

- [ ] response route registered
- [ ] response route authorizes thread owner first
- [ ] non-owner gets `404`
- [ ] unauthenticated caller gets `401`
- [ ] idempotent retry by `client_response_id`
- [ ] already answered mutation is rejected or idempotently returned

## Phase 2: Agent Runtime Tool Flow

### Model And Directives

- [ ] `ask_user_questions` added to canonical tool definitions
- [ ] provider tool calls parse into `AgentToolCallDirective`
- [ ] tool args serialize for client/runtime exposure
- [ ] invalid model-supplied question payloads fail closed

### Runtime

- [ ] `waiting_for_user` added to service runtime phase union
- [ ] runtime method sets pending question tool state
- [ ] runtime tests cover `waiting_for_user`
- [ ] cancel clears pending question state

### Tool Execution

- [ ] question executor creates durable request rows
- [ ] executor emits `agent.tool_call`
- [ ] executor waits for response through registry
- [ ] live response resolves the waiter
- [ ] fallback response creates a normal user message
- [ ] transcript writer records completed live tool result
- [ ] provider ledger records the tool result
- [ ] cancellation marks requests canceled

## Phase 3: Reference Web Client

### API And State

- [ ] web API types added
- [ ] `waiting_for_user` added to `ApiAgentState.phase`
- [ ] `pending_tool.started_at` typed
- [ ] synthetic pending question row builds from `/agent/state`
- [ ] live `agent.tool_call` renders the prompt

### UI

- [ ] question form component added
- [ ] boolean questions render and submit
- [ ] single-choice questions render and submit
- [ ] multi-choice questions render and submit
- [ ] text questions render and submit
- [ ] number questions render and submit
- [ ] per-question skip works
- [ ] skip all works
- [ ] normal composer behavior during `waiting_for_user` is implemented
- [ ] completed Q/A renderer registered

### Web Tests

- [ ] response payload helper tests added
- [ ] synthetic prompt overlay tests added
- [ ] completed renderer malformed-payload fallback tested where feasible

## Phase 4: Notifications, Docs, And Validation

### Notifications

- [ ] `human_input_requested` attention behavior implemented or deferred
- [ ] push outbox behavior implemented or deferred
- [ ] notification preference behavior verified if implemented

### Docs And Specs

- [ ] `docs/proto.md` updated
- [ ] `service/src/agent/agent.spec.md` updated
- [ ] `service/src/routes/routes.spec.md` updated
- [ ] `service/src/runtime/runtime.spec.md` updated
- [ ] `service/src/db/db.spec.md` updated
- [ ] `service/drizzle/migrations/migrations.spec.md` updated
- [ ] `service/src/notifications/notifications.spec.md` updated
- [ ] `web/src/lib/lib.spec.md` updated
- [ ] `web/src/features/threads/threads.spec.md` updated
- [ ] `web/src/components/workbench/workbench.spec.md` updated
- [ ] `web/src/components/message-renderers/tools/tools.spec.md` updated
- [ ] `web/src/routes/$budId/budId.spec.md` updated
- [ ] `bud.spec.md` updated
- [x] mobile client handoff doc created

## Phase 5: Integration Test Hardening

### Phase 5a: Service Route And Repository

- [ ] owner response route integration test added
- [ ] unauthenticated and non-owner response tests added
- [ ] request/thread mismatch and unknown request tests added
- [ ] idempotent retry and answered-conflict tests added
- [ ] canceled/expired request rejection tests added where applicable
- [ ] stored-request validation tests added for wrong kind, unknown question, and unknown choice
- [ ] persisted row assertions cover response, tool result, idempotency key, and acting user stamps

### Phase 5b: Agent Continuation

- [ ] live continuation integration test added
- [ ] runtime `waiting_for_user` event/state assertions added
- [ ] transcript completed-tool-row assertions added
- [ ] provider ledger tool-result assertions added
- [ ] fallback continuation integration test added
- [ ] cancel while waiting integration test added
- [ ] malformed model ask payload fail-closed integration test added

### Phase 5c: Web Prompt Integration

- [ ] pending prompt from live `agent.tool_call` test added
- [ ] pending prompt from `/agent/state` bootstrap test added
- [ ] response payload tests cover boolean, single-choice, multi-choice, text, and number questions
- [ ] per-question skip and skip-all tests added
- [ ] submit reconciliation tests cover live, fallback, already-answered, and failed submit
- [ ] completed Q/A renderer tests cover answered, skipped, and malformed payloads
- [ ] any new web DOM/component test harness is documented

### Phase 5d: End-To-End Smoke

- [ ] real-provider ask/answer/continue smoke run or explicitly deferred
- [ ] refresh while waiting smoke run
- [ ] duplicate submit smoke run
- [ ] cancel while waiting smoke run
- [ ] fallback continuation smoke run
- [ ] ownership regression smoke run
- [ ] terminal-tool regression smoke run
- [ ] smoke evidence recorded in [validation-checklist.md](./validation-checklist.md)

## Phase 6: Prompt Guidance And Question Count

- [x] system prompt tells the model not to ask multiple questions as a markdown list
- [x] system prompt tells the model to convert long question checklists into `ask_user_questions`
- [x] prompt language keeps the single-freeform markdown exception narrow
- [x] prompt language does not advertise a numeric question limit
- [x] model-facing `ask_user_questions.questions` schema no longer includes `maxItems`
- [x] service request normalization accepts more than five questions
- [x] prompt/schema/normalization tests updated

### Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Contracts, schema, migration, and response route not implemented |
| 2 | Not Started | Agent does not expose or execute `ask_user_questions` |
| 3 | Not Started | Web does not render or submit question prompts |
| 4 | Not Started | Notification/docs/validation updates not complete |
| 5 | Not Started | Integration test hardening scoped but not implemented |
| 6 | Implemented | Prompt guidance and question-count cap removal completed and covered by focused service tests |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If the implementation diverges from [../../design/ask-user-questions-tool-contract.md](../../design/ask-user-questions-tool-contract.md), update the design or capture a supersession note during Phase 4.
