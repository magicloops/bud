# Phase 4: Validation, Docs, And Mobile Handoff

## Objective

Close the reasoning messages rollout with provider validation, protocol/spec
updates, and a handoff for mobile/native clients.

## Scope

- Update protocol documentation for reasoning messages and SSE events.
- Update service and web specs touched by implementation.
- Run service/web focused tests.
- Manually validate OpenAI, Anthropic, ds4 Thinking, and ds4 Fast behavior.
- Confirm provider-ledger replay still preserves native reasoning.
- Confirm reasoning rows stay out of previews and push notifications.
- Create a mobile/native handoff doc after web behavior is verified.

## Expected Code/Doc Changes

- `docs/proto.md`
- `service/src/db/db.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `plan/reasoning-messages/validation-checklist.md`
- new mobile handoff doc after web validation

## Manual Validation Matrix

| Scenario | Expected Result |
| --- | --- |
| OpenAI reasoning enabled | Reasoning summary streams and persists |
| OpenAI reasoning none | No reasoning row |
| Anthropic thinking enabled | Thinking text streams and persists |
| Anthropic redacted thinking | No visible redacted text |
| ds4 Thinking | Reasoning streams and persists when server emits it |
| ds4 Fast | No reasoning row |
| Provider tool loop | Reasoning remains visible before tool rows |
| Page refresh mid-turn | Draft reasoning recovers from `/agent/state` |
| Page refresh after turn | Reasoning recovers from `/messages` |
| Provider replay | Same-provider continuation still uses `llm_call_item` |

## Acceptance Criteria

- [ ] `docs/proto.md` documents `role: "reasoning"`,
  `draft_reasoning`, and `agent.reasoning_*`.
- [ ] Specs reflect the final service/web behavior.
- [ ] Focused automated tests pass.
- [ ] Manual provider validation is recorded in the validation checklist.
- [ ] Mobile handoff doc exists and links to the protocol changes.

## Risks

- Provider-specific reasoning semantics differ. Docs should avoid saying all
  providers expose the same thing; product UI can use a generic label, while
  handoff docs spell out provider differences.
