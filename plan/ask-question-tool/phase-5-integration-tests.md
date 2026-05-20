# Phase 5: Integration Test Hardening

**Status**: Draft
**Parent**: [implementation-spec.md](./implementation-spec.md)
**Subphases**:
- [Phase 5a: Service Route And Repository Integration Tests](./phase-5a-service-route-and-repository-integration-tests.md)
- [Phase 5b: Agent Continuation Integration Tests](./phase-5b-agent-continuation-integration-tests.md)
- [Phase 5c: Web Prompt Integration Tests](./phase-5c-web-prompt-integration-tests.md)
- [Phase 5d: End-To-End Smoke And Regression Matrix](./phase-5d-e2e-smoke-and-regression-matrix.md)

---

## Objective

Add integration coverage around the `ask_user_questions` feature now that the service contract, web client, and local database schema are in place.

The goal is to move beyond unit/build confidence and verify the real cross-boundary behavior:

- owner-scoped response submission against persisted question requests
- live waiter continuation from a user response
- fallback continuation when no in-memory waiter exists
- thread timeline recovery from `/agent/state` and SSE events
- browser-facing auth, idempotency, cancel, and replay behavior

## Test Principles

- Exercise real service boundaries where practical: Fastify route injection, repository calls against the test database, runtime state, and transcript rows.
- Keep model behavior deterministic with fake provider/model-runner seams; do not require live OpenAI calls in CI.
- Assert ownership before behavior: unauthenticated requests return `401`; signed-in non-owners return `404`.
- Verify durable effects, not just returned JSON: request rows, transcript messages, provider ledger items, runtime state, and emitted events.
- Keep web tests focused on client-owned behavior: payload construction, rendering, reconciliation, and submit handling.
- Reserve real-provider and full-stack browser checks for a manual smoke pass unless CI infrastructure already supports them reliably.

## Subphase Order

| Subphase | Document | Primary Outcome |
|----------|----------|-----------------|
| 5a | [phase-5a-service-route-and-repository-integration-tests.md](./phase-5a-service-route-and-repository-integration-tests.md) | Route/repository coverage for response validation, ownership, idempotency, and status transitions |
| 5b | [phase-5b-agent-continuation-integration-tests.md](./phase-5b-agent-continuation-integration-tests.md) | Agent waits, resumes, records tool results, cancels, and falls back correctly |
| 5c | [phase-5c-web-prompt-integration-tests.md](./phase-5c-web-prompt-integration-tests.md) | Web renders pending prompts, builds responses, submits, and reconciles transcript state |
| 5d | [phase-5d-e2e-smoke-and-regression-matrix.md](./phase-5d-e2e-smoke-and-regression-matrix.md) | Manual/local smoke coverage across service, web, database, and real provider paths |

## Non-Goals

- Replacing all existing unit tests with slower integration tests.
- Running live OpenAI provider calls in default CI.
- Durable provider-native suspended-turn replay after service restart.
- Native mobile implementation tests.
- Broad visual regression coverage for every prompt layout.

## Shared Fixtures

Prefer adding or extending fixtures that can be reused across service tests:

- authenticated owner and non-owner users
- owned bud/thread records
- pending `agent_question_request` rows with normalized request JSON
- fake model/provider events for `ask_user_questions`
- fake terminal manager or no-op terminal tool dependencies
- transcript/runtime event capture helpers

Avoid weakening production auth or route code to make tests easier. If the current test harness cannot create authenticated route requests cleanly, add a small auth-aware test helper.

## Acceptance Criteria

- [ ] 5a tests prove response route and repository behavior against persisted rows
- [ ] 5b tests prove live continuation, fallback continuation, and cancel behavior
- [ ] 5c tests prove web prompt rendering, payload construction, submit handling, and reconciliation
- [ ] 5d smoke matrix is run locally and recorded in [validation-checklist.md](./validation-checklist.md)
- [ ] test commands are documented with exact package-local invocations
- [ ] failures get a debug note before changing approach
