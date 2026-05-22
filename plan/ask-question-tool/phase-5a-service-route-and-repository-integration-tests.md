# Phase 5a: Service Route And Repository Integration Tests

**Status**: Draft
**Parent**: [phase-5-integration-tests.md](./phase-5-integration-tests.md)

---

## Objective

Cover the owner-scoped response route and persistence helpers using real service boundaries.

This phase verifies that a browser response to an `ask_user_questions` prompt is accepted exactly once, validated against the stored request, stamped with the acting user, and blocked across auth and ownership boundaries.

## Scope

Primary service areas:

- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/agent/user-question-repository.ts`
- `service/src/agent/user-question-contracts.ts`
- `service/src/db/schema.ts`

Expected test files:

- `service/src/routes/threads/agent-question-response.test.ts`
- `service/src/agent/user-question-repository.integration.test.ts` if repository coverage is cleaner outside the route harness

## Test Cases

### Response Acceptance

- owner submits a valid response for a pending request
- row status changes from `pending` to `answered`
- `client_response`, `tool_result`, `client_response_id`, `answered_by_user_id`, and `answered_at` are persisted
- response body returns `continuation: "live_tool_result"` when a live waiter is registered
- response body returns `continuation: "fallback_user_message"` when no live waiter is registered

### Idempotency And Conflict

- retry with the same `client_response_id` returns stable success and does not duplicate side effects
- second response with a different `client_response_id` is rejected after the request is answered
- response to a `canceled` request is rejected
- response to an `expired` request is rejected when expiration is enforced

### Validation

- unknown `question_id` returns `400`
- missing required answer payload for `status: "answered"` returns `400`
- wrong answer kind for the stored question returns `400`
- choice response with an unknown `choice_id` returns `400`
- skipped answer is accepted for every v1 question kind
- client-supplied labels are ignored; tool result uses the stored request labels

### Ownership And Routing

- unauthenticated response returns `401`
- signed-in non-owner response returns `404`
- request id from another thread returns `404` under the current thread route
- unknown request id returns `404`
- malformed `thread_id` or `request_id` returns the existing route validation error

## Harness Notes

- Use package-local test commands from `service/` or `pnpm --dir /Users/adam/bud/service`.
- Prefer Fastify `inject` for route tests so auth, params, body parsing, and error serialization are exercised together.
- Use real database rows for buds, threads, and question requests.
- If current auth helpers are awkward, add a focused authenticated-request test helper rather than bypassing route auth.
- Keep test data owner-stamped with `created_by_user_id` and, where present, `tenant_id`.

## Acceptance Criteria

- [ ] route tests cover success, idempotency, conflict, validation, auth, and ownership cases
- [ ] repository tests cover status transitions that are hard to assert through the route alone
- [ ] tests assert persisted rows, not only HTTP responses
- [ ] tests run with the package-local service test command
- [ ] relevant service specs are updated if new helpers or test files are added
