# Implementation Spec: Reasoning Messages

**Status**: Proposed
**Created**: 2026-06-05
**Folder Spec**: [reasoning-messages.spec.md](./reasoning-messages.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-schema-and-replay-boundary.md](./phase-1-schema-and-replay-boundary.md)
**Phase 2**: [phase-2-agent-stream-and-persistence.md](./phase-2-agent-stream-and-persistence.md)
**Phase 3**: [phase-3-web-rendering-and-history.md](./phase-3-web-rendering-and-history.md)
**Phase 4**: [phase-4-validation-docs-and-mobile-handoff.md](./phase-4-validation-docs-and-mobile-handoff.md)
**Phase 5**: [phase-5-message-role-migration-audit.md](./phase-5-message-role-migration-audit.md)
**Related Design**: [../../design/reasoning-messages.md](../../design/reasoning-messages.md)
**Related Review**: [../../review/provider-reasoning-visibility-review.md](../../review/provider-reasoning-visibility-review.md)

---

## Context

Provider reasoning already reaches Bud's canonical LLM layer and is stored in
the provider ledger. It is not currently streamed to the browser or persisted
as a browser-visible transcript artifact.

This plan implements reasoning as a durable `message` role for product display
while preserving `llm_call_item` as the only source of provider-native replay
payloads.

## Objective

Users should see provider reasoning in the web chat timeline while a run is in
progress and after refreshing the page.

Acceptance criteria:

- reasoning-enabled OpenAI, Anthropic, and ds4 calls can create visible
  reasoning rows
- reasoning rows are fetched through `GET /api/threads/:threadId/messages`
- live reasoning streams over `GET /api/threads/:threadId/agent/stream`
- active-turn `/agent/state` can recover draft reasoning after refresh
- reasoning rows are never included in model-visible replay
- provider-native reasoning replay remains unchanged through `llm_call_item`
- reasoning does not update thread previews or push notifications
- web renders reasoning visible by default

## Fixed Decisions

- Add `message.role = "reasoning"`.
- Use `message.content` for sanitized visible reasoning text.
- Keep reasoning message metadata generic and small.
- Show Anthropic full thinking when emitted.
- Keep Anthropic redacted thinking hidden.
- Show OpenAI and ds4 reasoning summaries/text when emitted.
- Keep current context compaction policy and exclude reasoning rows from
  model-visible conversation loading.
- Fetch historical reasoning through the existing message endpoint.
- Lead with web support; create mobile handoff after validation.

## Non-Goals

- No daemon protocol changes.
- No provider request changes beyond what already exists.
- No collapse/visibility preference UI.
- No push notification changes except ensuring reasoning is excluded.
- No browser access to `llm_call_item.provider_payload`.
- No provider-ledger replay redesign.

## Phase Overview

| Phase | Document | Primary Outcome |
| --- | --- | --- |
| 1 | [phase-1-schema-and-replay-boundary.md](./phase-1-schema-and-replay-boundary.md) | Schema and loader boundaries support non-model-visible reasoning rows |
| 2 | [phase-2-agent-stream-and-persistence.md](./phase-2-agent-stream-and-persistence.md) | Agent streams and persists reasoning messages from canonical provider events |
| 3 | [phase-3-web-rendering-and-history.md](./phase-3-web-rendering-and-history.md) | Web renders live and historical reasoning messages |
| 4 | [phase-4-validation-docs-and-mobile-handoff.md](./phase-4-validation-docs-and-mobile-handoff.md) | Specs, protocol docs, regression coverage, and mobile handoff are complete |
| 5 | [phase-5-message-role-migration-audit.md](./phase-5-message-role-migration-audit.md) | Drizzle migration status for the `reasoning` role is audited and documented as SQL-no-op |

## Impacted Contracts

- DB schema: `message.role` TypeScript enum adds `reasoning`; Phase 5
  confirmed this is a SQL no-op because the physical column is plain
  PostgreSQL `text`, no enum/check constraint exists, and Drizzle generated no
  migration.
- Browser REST: `/messages` may return `role: "reasoning"`.
- Browser SSE: `/agent/stream` adds `agent.reasoning_start`,
  `agent.reasoning_delta`, and `agent.reasoning_done`.
- Browser state: `/agent/state` may include `draft_reasoning`.
- Agent runtime: active snapshots track reasoning drafts.
- Conversation loader: skips reasoning rows for model-visible history.
- Web UI: chat timeline adds a reasoning renderer and draft reconciliation.

No Bud daemon WebSocket/protobuf contract changes are expected.

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- `service/src/agent/model-runner.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/llm/provider-ledger.ts` if optional message correlation is added

### Web

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/message-renderers/roles/`

### Docs And Specs

- `docs/proto.md`
- `service/src/db/db.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `bud.spec.md`

## Test Plan

Automated tests should cover:

- conversation loader excludes `reasoning` rows
- `recordReasoning` persistence creates owned `message.role = "reasoning"` rows
- provider reasoning events produce runtime events and returned reasoning drafts
- `/agent/state` serializes `draft_reasoning`
- web message-state helpers build, update, reconcile, and clear reasoning drafts
- stream hook parses reasoning events
- chat timeline renders reasoning rows without treating them as assistant final
  messages

Manual validation should cover OpenAI, Anthropic, ds4 Thinking, ds4 Fast, page
refresh during active reasoning, historical transcript reload, and provider
ledger replay.

## Rollout

This is additive for browser API clients. Older clients that ignore
`role: "reasoning"`, `draft_reasoning`, and `agent.reasoning_*` events should
continue to function, but they may display raw reasoning rows with generic
fallback UI if they render every message role blindly.

After web validation, create a mobile handoff that documents:

- new message role
- new SSE events
- `draft_reasoning` state
- recommended native rendering and collapse behavior

## Definition Of Done

- [ ] Phase 1 through Phase 4 checklist items complete
- [ ] Provider-ledger replay still passes existing tests
- [ ] Reasoning rows are visible after refresh
- [ ] Reasoning rows are excluded from model replay and previews
- [ ] Docs and specs updated
- [ ] Mobile handoff created after web validation
- [x] Phase 5 migration audit resolves the checked-in migration question
