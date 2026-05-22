# ask-question-tool

Implementation planning documents for the `ask_user_questions` agent tool across the Bud service and reference web client.

## Purpose

This folder turns the design in [../../design/ask-user-questions-tool-contract.md](../../design/ask-user-questions-tool-contract.md) and the follow-up supersession design in [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md) into actionable backend/frontend rollout plans.

The plan assumes:

- the model-facing tool name is `ask_user_questions`
- the browser-facing request schema is form-oriented and client-renderable
- every question is skippable
- the accepted response is converted into one self-contained tool result that repeats each question before its answer
- v1 supports live in-process tool-result continuation
- restart recovery falls back to a normal follow-up user message containing the same question/answer summary
- normal follow-up messages can supersede pending prompts by closing questions as skipped and starting a fresh turn
- the tool belongs to the owning thread and authenticated viewer; there is no daemon protocol change

## Files

### `implementation-spec.md`

Parent implementation spec covering:

- fixed v1 decisions
- service and web objectives
- schema, route, runtime, and transcript contracts
- phase sequencing
- risks and definition of done

### `phase-1-service-contract-and-persistence.md`

Service foundation phase covering:

- shared TypeScript/Zod contracts
- `agent_question_request` schema and checked-in Drizzle migration
- owner-scoped response route
- request/result normalization helpers
- route and schema tests

### `phase-2-agent-runtime-tool-flow.md`

Agent runtime phase covering:

- model-facing tool schema
- directive parsing
- human-input waiter/resolver ownership
- `waiting_for_user` runtime phase
- live tool-result continuation
- fallback continuation after service restart
- transcript and provider-ledger behavior

### `phase-3-reference-web-client.md`

Reference web phase covering:

- API types for question requests and responses
- agent-state and stream parsing
- pending question form rendering
- answer/skip submission
- transcript rendering for completed question prompts
- focused web tests

### `phase-4-notifications-docs-and-validation.md`

Finalization phase covering:

- `human_input_requested` attention/push integration
- protocol and spec updates
- web/service spec updates
- migration docs
- manual validation and mobile handoff notes

### `phase-5-integration-tests.md`

Follow-on integration test hardening phase covering:

- service route/repository integration test scope
- agent continuation integration test scope
- web prompt integration test scope
- local end-to-end smoke and regression matrix

### `phase-5a-service-route-and-repository-integration-tests.md`

Subphase 5a covering owner-scoped response route, repository, validation, idempotency, and auth/ownership integration tests.

### `phase-5b-agent-continuation-integration-tests.md`

Subphase 5b covering live continuation, fallback continuation, cancel cleanup, runtime events, transcript rows, and provider ledger integration tests.

### `phase-5c-web-prompt-integration-tests.md`

Subphase 5c covering web pending prompt rendering, response payload construction, submit behavior, and transcript reconciliation tests.

### `phase-5d-e2e-smoke-and-regression-matrix.md`

Subphase 5d covering local end-to-end smoke scenarios and regression evidence to record after schema push.

### `phase-6-prompt-guidance-and-question-count.md`

Follow-on phase covering prompt-language changes that steer multiple needed questions into `ask_user_questions` instead of markdown lists, plus removal of the hard five-question cap from the model-facing schema and service request normalization.

### `phase-7-follow-up-supersession-service.md`

Follow-on service phase covering normal message sends while `ask_user_questions` is pending, server-side skipped-answer closeout, transition locking, stale durable prompt cleanup, final event semantics, and prevention of overlapping turns.

### `phase-8-waiting-for-user-client-ux.md`

Follow-on client phase covering phase-aware web UI state, enabled composer behavior while waiting for user input, spinner cleanup, follow-up send behavior, stream/state reconciliation, and mobile handoff updates.

### `phase-9-human-input-attention-resolution.md`

Deferred follow-on phase covering the eventual `human_input_requested` attention anchor, push enqueue/suppression rules, and resolution semantics for explicit answers, skip-all, follow-up supersession, cancel, and expiry.

### `mobile-client-handoff.md`

Mobile/native implementation handoff for consuming `ask_user_questions` prompts.

**Covers**:
- live `agent.tool_call` and `/agent/state` prompt detection
- exact `ask_user_questions_request_v1` and `ask_user_questions_response_v1` shapes
- per-kind rendering and response serialization rules
- thread-scoped submit route, continuation handling, and error handling
- completed `ask_user_questions_tool_result_v1` rendering
- mobile-focused test checklist and v1 out-of-scope items

### `mobile-follow-up-supersession-handoff.md`

Focused mobile/native handoff for sending normal follow-up messages while an `ask_user_questions` prompt is pending.

**Covers**:
- keeping the normal composer enabled during `waiting_for_user`
- using `POST /api/threads/:thread_id/messages` rather than the question-response route
- replacing optimistic rows with the create-message `message` payload for canonical timestamp ordering
- handling skipped prompt `agent.tool_result` and `final.reason: "superseded_by_user_message"`
- race, retry, error-handling, and mobile test checklist guidance

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the shipped contract.

## Dependencies

- [../../design/ask-user-questions-tool-contract.md](../../design/ask-user-questions-tool-contract.md) - source design
- [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md) - follow-up message supersession design
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current model/tool/transcript ownership
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - thread route and ownership contracts
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - `/agent/state` and stream runtime shape
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - schema and ownership conventions
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md) - thread runtime hooks
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) - chat/workbench presentation surfaces
- [../../web/src/components/message-renderers/message-renderers.spec.md](../../web/src/components/message-renderers/message-renderers.spec.md) - tool-renderer extension model
- [../../docs/proto.md](../../docs/proto.md) - browser-facing protocol contract
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- V1 intentionally does not implement full durable suspended-turn replay across service restarts. Restart recovery should persist the user response and start a normal follow-up agent turn with the self-contained question/answer summary.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
