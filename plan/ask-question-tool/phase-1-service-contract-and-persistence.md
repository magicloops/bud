# Phase 1: Service Contract And Persistence

**Status**: Draft
**Parent**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Build the service foundation before wiring the model loop:

- shared request/response/result validators
- durable `agent_question_request` table
- checked-in migration
- owner-scoped response route
- idempotent response acceptance
- tests for validation and ownership

Phase 1 can land without exposing `ask_user_questions` to the model yet.

## Tasks

### 1. Shared Contracts

Add a service contract module, for example `service/src/agent/user-question-contracts.ts`.

It should define:

- `ASK_USER_QUESTIONS_REQUEST_SCHEMA = "ask_user_questions_request_v1"`
- `ASK_USER_QUESTIONS_RESPONSE_SCHEMA = "ask_user_questions_response_v1"`
- `ASK_USER_QUESTIONS_TOOL_RESULT_SCHEMA = "ask_user_questions_tool_result_v1"`
- question kind union: `boolean | single_choice | multi_choice | text | number`
- answer status union: `answered | skipped`
- skip reason union: `user_skipped | not_applicable | unknown`
- request normalizer from model input to client-safe request
- response validator from client input plus stored request
- tool-result builder that repeats every question before its answer
- `summary_markdown` builder used by fallback transcript and debugging

Normalization rules:

- require at least one question; do not impose a hard maximum question count
- generate missing `question_id` values from ordinal position
- require unique question ids
- require non-empty labels
- normalize `skippable` to `true`
- reject unknown question kinds
- reject choice questions with missing/duplicate choice ids
- reject default answers that do not match the question kind
- apply sane text/number bounds even when omitted

### 2. Schema

Add `agentQuestionRequestTable` to `service/src/db/schema.ts`.

Required columns:

- `questionRequestId`
- `threadId`
- `turnId`
- `callId`
- `clientId`
- `status`
- `request`
- `clientResponse`
- `toolResult`
- `clientResponseId`
- `answeredByUserId`
- `answeredAt`
- `expiresAt`
- `tenantId`
- `createdByUserId`
- `createdAt`
- `updatedAt`

Indexes:

- unique `(thread_id, call_id)`
- unique nullable `client_response_id`
- `(thread_id, status, created_at)`
- `(created_by_user_id, status, created_at)`

The table should reference `thread(thread_id)` with cascade delete. `answered_by_user_id` may reference `auth.user(id)` with `set null`.

### 3. Migration

Run the normal Drizzle workflow for schema changes:

1. edit `service/src/db/schema.ts`
2. run `pnpm --dir /Users/adam/bud/service db:push`
3. review/apply local SQL
4. run `pnpm --dir /Users/adam/bud/service db:generate`
5. review the generated SQL and migration metadata

Update:

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`

If `db:push` or generation fails, capture the exact command/output and stop for human guidance per repo rules.

### 4. Request Repository

Add a small service-side repository/helper, for example:

- `createQuestionRequest(...)`
- `getAuthorizedQuestionRequest(threadId, requestId, viewerUserId)`
- `acceptQuestionResponse(...)`
- `markQuestionRequestCanceled(...)`
- `markQuestionRequestExpired(...)`

`acceptQuestionResponse(...)` should:

- re-read the row inside a transaction
- reject or idempotently return if already answered
- validate against the stored request
- build the service-owned tool result
- set status to `answered`
- store both client response and generated tool result
- stamp `answered_by_user_id` and `answered_at`

### 5. Response Route

Register under `service/src/routes/threads/agent.ts`:

```text
POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
```

Route behavior:

- parse thread params and request id
- call `requireAuthorizedThreadAccess(...)`
- fetch the question request only after thread ownership is resolved
- return `404` for missing request or cross-thread request
- validate response payload
- accept idempotent retry by `client_response_id`
- return normalized status and continuation mode

Do not introduce a public placeholder continuation value in Phase 1. The final route response should use only the continuation enum from [implementation-spec.md](./implementation-spec.md). If the route lands before Phase 2, keep behavior covered through repository tests or guard successful first-time submissions behind the same feature boundary that prevents real question requests from being created.

### 6. Tests

Add focused tests for:

- request normalization
- duplicate question ids rejected
- invalid answer kind rejected
- unknown choice id rejected
- skipped answers accepted for every question kind
- omitted answers normalized to skipped if that tolerance is implemented
- owner can answer
- unauthenticated caller gets `401`
- signed-in non-owner gets `404`
- duplicate `client_response_id` retry is idempotent
- already answered request cannot be changed by a different response

## Acceptance Criteria

- [ ] contract helpers exist and are unit tested
- [ ] `agent_question_request` exists in schema
- [ ] checked-in migration exists and is documented
- [ ] response route is registered under the thread route family
- [ ] route enforces owner-scoped access before request lookup
- [ ] response acceptance stores a self-contained tool result payload
- [ ] route tests cover auth, idempotency, and validation
