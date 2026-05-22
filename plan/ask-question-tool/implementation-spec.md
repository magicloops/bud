# Implementation Spec: Ask User Questions Tool

**Status**: Draft
**Created**: 2026-05-19
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-service-contract-and-persistence.md](./phase-1-service-contract-and-persistence.md)
**Phase 2**: [phase-2-agent-runtime-tool-flow.md](./phase-2-agent-runtime-tool-flow.md)
**Phase 3**: [phase-3-reference-web-client.md](./phase-3-reference-web-client.md)
**Phase 4**: [phase-4-notifications-docs-and-validation.md](./phase-4-notifications-docs-and-validation.md)
**Phase 5**: [phase-5-integration-tests.md](./phase-5-integration-tests.md)
**Phase 6**: [phase-6-prompt-guidance-and-question-count.md](./phase-6-prompt-guidance-and-question-count.md)
**Phase 7**: [phase-7-follow-up-supersession-service.md](./phase-7-follow-up-supersession-service.md)
**Phase 8**: [phase-8-waiting-for-user-client-ux.md](./phase-8-waiting-for-user-client-ux.md)
**Phase 9**: [phase-9-human-input-attention-resolution.md](./phase-9-human-input-attention-resolution.md)
**Related Docs**:
- [../../design/ask-user-questions-tool-contract.md](../../design/ask-user-questions-tool-contract.md)
- [../../design/follow-up-message-supersedes-ask-user-questions.md](../../design/follow-up-message-supersedes-ask-user-questions.md)
- [../../docs/proto.md](../../docs/proto.md)
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md)
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md)

---

## Context

The agent can currently answer, stream text, and call product tools such as `terminal.send`, `terminal.observe`, and `web_view.*`. When the agent needs human input before continuing, it has no structured pause/resume mechanism. It can only ask an ordinary assistant question and rely on the user to send a new message.

That creates three product gaps:

- clients cannot render a real form for multiple questions
- the service cannot distinguish "agent is waiting on the user" from a long-running tool
- push/read-attention already has a `human_input_requested` kind, but no producer emits it

The design direction is to add one model-facing tool, `ask_user_questions`, that pauses the active agent turn and exposes a normalized, skippable question set to the owning thread client.

## Objective

Implement the `ask_user_questions` tool for the service and reference web client:

- the model can ask structured, skippable questions
- the service normalizes and persists the question request
- `/agent/state` and `agent.tool_call` expose the prompt to clients
- the web client renders the prompt as a form in the thread timeline
- the user can answer or skip each question
- the service validates the response against the original request
- live in-process responses resume the original provider tool-call loop with one structured tool result
- restart recovery persists the same Q/A summary as a normal follow-up user message and starts a new agent turn
- completed prompts render as one canonical transcript item
- normal follow-up messages can close pending prompts as skipped and start fresh turns
- clients treat `waiting_for_user` as a paused human-input state rather than active loading
- human-input attention and optional push notifications work from the same boundary or remain explicitly deferred

## Fixed Decisions

- Tool name: `ask_user_questions`.
- Provider tool name: `ask_user_questions`, not a snake/camel alias.
- Question request schema: `ask_user_questions_request_v1`.
- Client response schema: `ask_user_questions_response_v1`.
- Agent tool result schema: `ask_user_questions_tool_result_v1`.
- V1 question kinds: `boolean`, `single_choice`, `multi_choice`, `text`, and `number`.
- Every question is skippable; `importance` is advisory only.
- No secrets, files, date/time controls, ranking, conditional branching, or arbitrary rich form rendering in v1.
- Persist one request row per tool call, not one row per question or answer.
- Use a new table named `agent_question_request`.
- Add `waiting_for_user` to `AgentRuntimePhase`.
- Use the existing `agent.tool_call` event and `/agent/state.pending_tool` shape, with `name: "ask_user_questions"`.
- Add an owner-scoped response route under the thread route family:
  `POST /api/threads/:thread_id/agent/question-requests/:request_id/responses`.
- Live in-process response resolves the pending tool promise and continues the current turn.
- If no pending in-memory waiter exists, response submission persists a user-visible Q/A follow-up message and starts a normal new agent turn.
- The fallback message uses the same service-generated result payload and repeats each question before its answer.
- Normal follow-up messages sent through `POST /api/threads/:thread_id/messages` close all pending `ask_user_questions` rows for that thread as skipped before starting the follow-up turn.
- The message-create response shape remains `{ message_id, client_id }`; it does not expose supersession metadata.
- Follow-up supersession emits `final.status: "succeeded"` with `reason: "superseded_by_user_message"` and no assistant `message_id` or `text`.
- Explicit skip-all from the question card continues the original turn; follow-up supersession stops the old waiting turn and starts from the new user message.
- The service uses a short-lived per-thread transition lock for state handoffs, not a mutex held across provider/tool/human waits.
- Human-input attention/push resolution for superseded prompts is deferred to a later notification slice unless Phase 9 is explicitly pulled forward.

## Success Criteria

- [ ] the service exposes `ask_user_questions` in the model tool schema
- [ ] invalid model-supplied question payloads fail closed before clients see them
- [ ] question requests are persisted with owner stamps and a checked-in migration
- [ ] `/agent/state.phase` can be `waiting_for_user`
- [ ] `agent.tool_call` and `/agent/state.pending_tool` expose the normalized question request
- [ ] the owner can submit a response exactly once, with idempotent retry by `client_response_id`
- [ ] signed-in non-owners receive `404`; unauthenticated callers receive `401`
- [ ] answer validation uses the stored request, not client-supplied labels
- [ ] live responses resume the original tool-call loop and record a tool row
- [ ] restart fallback records a self-contained user message and launches a follow-up turn
- [ ] web renders pending question prompts and completed Q/A summaries
- [ ] web supports answering and skipping every question kind in v1
- [ ] human-input attention is stamped and push outbox integration is implemented or explicitly deferred
- [ ] normal follow-up message sends close pending prompts as skipped server-side
- [ ] follow-up supersession does not continue the old model turn
- [ ] web composer remains available while `waiting_for_user`
- [ ] web does not show loading indicators while only waiting for human input
- [ ] protocol, service, db, web, and migration specs are updated

## Non-Goals

- secure secret collection
- file uploads or file picker answers
- mobile app implementation in this repo
- durable provider-native suspended-turn replay after service restart
- multi-user collaboration or shared prompt answering
- arbitrary client-side conditional form logic
- long-lived survey analytics tables

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-service-contract-and-persistence.md](./phase-1-service-contract-and-persistence.md) | Urgent | Service has durable request/response contracts, DB schema, validation, and owner-scoped response route |
| 2 | [phase-2-agent-runtime-tool-flow.md](./phase-2-agent-runtime-tool-flow.md) | Urgent | Agent can call `ask_user_questions`, enter `waiting_for_user`, and continue from live or fallback responses |
| 3 | [phase-3-reference-web-client.md](./phase-3-reference-web-client.md) | Urgent | Reference web renders and submits question forms from `/agent/state` / SSE |
| 4 | [phase-4-notifications-docs-and-validation.md](./phase-4-notifications-docs-and-validation.md) | High | Notifications, docs, specs, migration docs, and manual validation align with the shipped contract |
| 5 | [phase-5-integration-tests.md](./phase-5-integration-tests.md) | High | Integration tests and local smoke coverage harden route, runtime, web, and end-to-end behavior |
| 6 | [phase-6-prompt-guidance-and-question-count.md](./phase-6-prompt-guidance-and-question-count.md) | High | Prompt guidance avoids markdown question blocks and the hard question-count cap is removed |
| 7 | [phase-7-follow-up-supersession-service.md](./phase-7-follow-up-supersession-service.md) | High | Normal follow-up message sends close pending prompts as skipped, finish the old waiting turn, and start a fresh turn without response-shape churn |
| 8 | [phase-8-waiting-for-user-client-ux.md](./phase-8-waiting-for-user-client-ux.md) | High | Web and mobile client guidance treat `waiting_for_user` as a paused input state with composer access and stream/state reconciliation |
| 9 | [phase-9-human-input-attention-resolution.md](./phase-9-human-input-attention-resolution.md) | Deferred | Human-input attention and push semantics are anchored, resolved, and suppressed correctly for answers, skip-all, supersession, cancel, and expiry |

## Current Code Map

### Service

- `service/src/agent/model-runner.ts` owns the canonical model tool definitions and tool-call parsing.
- `service/src/agent/contracts.ts` owns normalized tool directive/result types and client-facing args.
- `service/src/agent/agent-service.ts` executes provider-ordered tool calls serially and appends tool results to the provider conversation.
- `service/src/agent/transcript-writer.ts` emits `agent.tool_call`, stores tool rows, emits `agent.tool_result`, and manages runtime pending-tool state.
- `service/src/agent/user-question-repository.ts` owns durable question request creation, answer acceptance, skipped-result generation, and status transitions.
- `service/src/agent/user-question-registry.ts` owns live in-memory question waiters.
- `service/src/runtime/agent-runtime-state.ts` owns `/agent/state` snapshots and bounded SSE cursor state.
- `service/src/routes/threads/agent.ts` owns `/agent/state`, `/agent/stream`, and `/cancel`.
- `service/src/routes/threads/messages.ts` owns normal user-message creation and the follow-up supersession entrypoint for pending question prompts.
- `service/src/routes/threads/shared.ts` owns thread params and ownership helpers.
- `service/src/db/schema.ts` is the schema source of truth and must be paired with a checked-in migration.

### Web

- `web/src/lib/api-types.ts` owns browser-visible API contracts.
- `web/src/features/threads/use-agent-stream.ts` parses agent SSE events.
- `web/src/features/threads/thread-message-state.ts` builds synthetic pending tool rows from `/agent/state`.
- `web/src/features/threads/use-thread-messages.ts` owns transcript reconciliation.
- `web/src/components/workbench/command-composer.tsx` owns composer disabled/loading behavior, including keeping normal sends available during `waiting_for_user`.
- `web/src/components/workbench/thinking-indicator.tsx` owns the global agent loading indicator.
- `web/src/components/workbench/chat-timeline.tsx` renders timeline rows.
- `web/src/components/message-renderers/tools/` renders completed tool payloads.
- `web/src/routes/$budId/$threadId.tsx` composes thread hooks and passes callbacks to presentation components.

## Data Model

Add `agent_question_request`:

| Column | Type | Notes |
|--------|------|-------|
| `question_request_id` | text primary key | ULID with `qr_` display prefix optional at serializer boundary |
| `thread_id` | uuid not null | FK to `thread` |
| `turn_id` | text not null | active agent turn |
| `call_id` | text not null | provider tool call id |
| `client_id` | uuid not null | stable client-visible synthetic/persisted tool identity |
| `status` | text not null | `pending`, `answered`, `expired`, `canceled` |
| `request` | jsonb not null | normalized `ask_user_questions_request_v1` |
| `client_response` | jsonb nullable | accepted `ask_user_questions_response_v1` |
| `tool_result` | jsonb nullable | generated `ask_user_questions_tool_result_v1` |
| `client_response_id` | uuid nullable | idempotency key from client |
| `answered_by_user_id` | text nullable | authenticated submitter |
| `answered_at` | timestamptz nullable | response time |
| `expires_at` | timestamptz nullable | optional timeout for stale prompts |
| `tenant_id` | text nullable | current tenant placeholder |
| `created_by_user_id` | text nullable | copied from thread owner |
| `created_at` / `updated_at` | timestamptz | normal bookkeeping |

Indexes:

- unique `(thread_id, call_id)`
- unique nullable `client_response_id`
- `(thread_id, status, created_at)`
- `(created_by_user_id, status, created_at)`

## Runtime Contract

`AgentRuntimePhase` gains:

```typescript
| "waiting_for_user"
```

Pending tool snapshot example:

```json
{
  "active": true,
  "turn_id": "01TURN...",
  "phase": "waiting_for_user",
  "can_cancel": true,
  "pending_tool": {
    "client_id": "018f...",
    "call_id": "call_abc",
    "name": "ask_user_questions",
    "args": {
      "schema": "ask_user_questions_request_v1",
      "request_id": "qr_01J...",
      "title": "Deployment details",
      "questions": []
    },
    "started_at": "2026-05-19T12:00:00.000Z"
  }
}
```

## API Contract

Response route:

```text
POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
```

Request:

```json
{
  "schema": "ask_user_questions_response_v1",
  "client_response_id": "018f4f2a-0000-7000-9000-000000000000",
  "answers": [
    {
      "question_id": "target_environment",
      "status": "answered",
      "answer": { "kind": "single_choice", "choice_id": "staging" }
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "question_request_id": "qr_01J...",
  "status": "answered",
  "continuation": "live_tool_result"
}
```

`continuation` is one of:

- `live_tool_result`
- `fallback_user_message`
- `already_answered`

Follow-up message route behavior:

```text
POST /api/threads/:thread_id/messages
```

If the thread has pending `ask_user_questions` rows, the service closes them as skipped before persisting and starting the follow-up message turn. The response shape remains unchanged:

```json
{
  "message_id": "uuid",
  "client_id": "019..."
}
```

The old waiting turn emits:

```json
{
  "turn_id": "01TURN...",
  "status": "succeeded",
  "reason": "superseded_by_user_message"
}
```

with no assistant `message_id` or `text`.

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/drizzle/migrations/*`
- `service/src/agent/contracts.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/user-question-contracts.ts` or equivalent
- `service/src/agent/user-question-repository.ts`
- `service/src/agent/user-question-registry.ts`
- `service/src/agent/user-question-tool-executor.ts` or equivalent
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/shared.ts`
- focused tests under `service/src/agent/`, `service/src/runtime/`, and `service/src/routes/threads/`

### Web

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/components/workbench/thinking-indicator.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/workbench/question-request-card.tsx` or equivalent
- `web/src/components/message-renderers/tools/ask-user-questions.tsx`
- `web/src/components/message-renderers/tools/index.ts`
- `web/src/routes/$budId/$threadId.tsx`
- focused tests under `web/src/features/threads/` and component smoke coverage if available

### Docs / Specs

- `docs/proto.md`
- `bud.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/notifications/notifications.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent turn hangs forever waiting for user input | Medium | High | Add durable status, cancel handling, optional expiry, and clear runtime state on cancel |
| Restart loses provider-native tool-call continuation | High | Medium | Make fallback explicit: persist Q/A as user message and start a new turn |
| Client renders an invalid form from malformed model payload | Medium | High | Service normalizes and rejects invalid question requests before SSE/runtime exposure |
| Duplicate response submit creates multiple continuations | Medium | High | Use `client_response_id` idempotency plus row status compare/update |
| Cross-user prompt leak | Low | High | Route reads request only after `requireAuthorizedThreadAccess(...)` |
| Web treats `waiting_for_user` as normal streaming and disables useful input forever | Medium | Medium | Add phase-aware UI and explicit answer/cancel affordances |
| Follow-up send overlaps the old waiting turn | Medium | High | Add a short-lived per-thread transition lock and finish superseded turns before starting follow-up turns |
| Follow-up supersession accidentally continues the old provider loop | Medium | High | Distinguish explicit answers from superseded waiter outcomes and return from `runAgentFlow(...)` after recording skipped closeout |
| Message route response grows implementation-specific cleanup fields | Medium | Medium | Keep response shape unchanged and rely on SSE plus `/agent/state` convergence |
| Push notifications fire repeatedly for the same unanswered prompt | Medium | Medium | Use outbox dedupe keys scoped to request id |

## Definition Of Done

- [ ] all phases in [progress-checklist.md](./progress-checklist.md) are complete or explicitly deferred
- [ ] validation in [validation-checklist.md](./validation-checklist.md) is run and recorded
- [ ] schema change has local `db:push` coverage and checked-in Drizzle migration
- [ ] service tests cover contract validation, ownership, live continuation, and restart fallback
- [ ] web tests cover pending prompt overlay and response payload construction
- [ ] integration-test follow-on coverage is implemented or explicitly tracked through Phase 5
- [ ] follow-up supersession service behavior is implemented or explicitly tracked through Phase 7
- [ ] `waiting_for_user` client UX cleanup is implemented or explicitly tracked through Phase 8
- [ ] human-input attention/push resolution is implemented or explicitly deferred through Phase 9
- [ ] docs/specs describe the shipped route, stream state, and transcript behavior
