# Phase 1: Schema And Replay Boundary

## Objective

Create the service-side durable shape for reasoning messages while making the
model-visible boundary explicit.

By the end of this phase, `message.role = "reasoning"` is a valid
browser-visible row type, but conversation reconstruction, previews, and push
notifications still ignore reasoning rows.

## Scope

- Add `reasoning` to `messageRoleValues`.
- Confirm whether Drizzle generates SQL for the text enum change.
- Add a checked-in migration if Drizzle emits one; document SQL-no-op if not.
- Update message serialization types/comments where role assumptions are
  narrow.
- Update `AgentConversationLoader` to ignore reasoning rows.
- Ensure model-visible row counters and reconstruction diagnostics do not treat
  reasoning as assistant/tool context.
- Ensure reasoning rows do not call `recordThreadMessageMetadata`.
- Ensure reasoning rows do not enqueue push notifications or attention rows.

## Design Details

Reasoning rows use:

```text
role = "reasoning"
display_role = "Reasoning"
content = visible reasoning text
metadata.model_visible = false
metadata.artifact_kind = "reasoning"
```

The message row is a display artifact. It is not a provider replay artifact.
Provider replay remains in `llm_call_item`.

## Expected Code Changes

- `service/src/db/schema.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/conversation-loader.test.ts`
- `service/src/agent/transcript-writer.ts` type preparation if needed
- `service/src/routes/threads/shared.ts` if serialized role docs/types need
  tightening
- `service/drizzle/migrations/` if generated

## Spec Files To Update

- `service/src/db/db.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `bud.spec.md`

## Acceptance Criteria

- [ ] `message.role = "reasoning"` is valid in service code.
- [ ] Existing message history route can serialize reasoning rows without
  special handling.
- [ ] Conversation loader skips reasoning rows.
- [ ] Reasoning rows are not counted as model transcript rows.
- [ ] No provider replay path reads reasoning message rows.
- [ ] Drizzle migration status is resolved and documented.

## Tests

- Add or update `conversation-loader` coverage showing:
  - reasoning rows are omitted from canonical model messages
  - user/assistant/tool rows around reasoning rows preserve order
  - provider-ledger reconstruction still supplies provider-native reasoning
    blocks when compatible

## Risks

- If any thread-preview or notification helper assumes all inserted messages
  should update user-facing attention, reasoning could leak into previews. The
  implementation should keep reasoning persistence on a separate transcript
  writer method that does not call preview/notification helpers.
