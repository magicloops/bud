# Phase 4: Notifications, Docs, And Validation

**Status**: Draft
**Parent**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Finish the feature as a product contract, not just a working local path:

- integrate `human_input_requested` attention/push behavior
- update protocol and spec docs
- update migration docs
- create mobile handoff notes if needed
- run service/web validation

## Tasks

### 1. Human-Input Attention

When `ask_user_questions` becomes durable:

- stamp thread attention metadata with `kind: "human_input_requested"`
- choose whether to associate attention with a placeholder message id or with the eventual visible tool/user row
- if no message exists yet, prefer adding a message id only when the prompt becomes visible in transcript; otherwise document request-id-only attention as a follow-up

When the prompt is answered, canceled, or expired:

- ensure the thread no longer appears as requiring human input once read-state catches up
- avoid clearing newer assistant-completed attention

This may require a small helper rather than overloading `recordThreadAttentionMetadata(...)` if there is no message row at prompt time.

### 2. Push Outbox

If enabling push in this pass:

- enqueue `push_notification_outbox.kind = "human_input_requested"` when a question request is created
- use dedupe key `user:<user_id>:thread:<thread_id>:question_request:<request_id>:kind:human_input_requested`
- use collapse key `thread:<thread_id>`
- respect `push_endpoint.alerts_human_input_requested`
- generate body from the prompt title or first question label, without leaking sensitive freeform values

If not enabling push in this pass:

- keep attention metadata working locally
- leave the notifications spec TODO in place with a narrower note
- record the explicit deferral in this phase doc/checklist

### 3. Protocol Docs

Update `docs/proto.md`:

- add `waiting_for_user` to `/agent/state.phase`
- add `ask_user_questions` `agent.tool_call` example
- document the response route and payload
- document response route success/error shapes
- document live vs fallback continuation
- document completed transcript shape
- document ownership/auth rules
- update changelog

### 4. Service Specs

Update:

- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/notifications/notifications.spec.md`

Remove or narrow the existing `human_input_requested` TODO only if the shipped implementation actually emits it.

### 5. Web Specs

Update:

- `web/src/lib/lib.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `web/src/routes/$budId/budId.spec.md`

### 6. Mobile Handoff

If mobile is expected to consume the contract soon, create or update [mobile-client-handoff.md](./mobile-client-handoff.md) describing:

- `agent.tool_call` pending prompt payload
- `/agent/state` recovery behavior
- response route
- exact Q/A response/result examples
- expected client UI rules for skip and unsupported question kinds
- fallback continuation behavior

### 7. Verification

Run the smallest meaningful checks first:

- service contract/unit tests
- route tests for response ownership/idempotency
- runtime tests for `waiting_for_user`
- web pure tests for response construction and transcript overlay
- package builds/lints after implementation stabilizes

Per repo instructions, if a build/run command fails, capture the exact command and output in a debug note and stop for human guidance.

## Acceptance Criteria

- [ ] human-input attention behavior is implemented or explicitly deferred
- [ ] push behavior is implemented or explicitly deferred
- [ ] `docs/proto.md` describes the shipped contract
- [ ] service specs match implementation
- [ ] web specs match implementation
- [ ] migration spec lists the new migration
- [ ] validation checklist has concrete results
- [ ] mobile handoff exists if needed for native adoption
