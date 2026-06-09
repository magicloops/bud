# reasoning-messages

Phased implementation planning documents for making provider reasoning visible
as durable browser transcript messages while preserving provider-native replay
through the LLM call ledger.

## Purpose

This folder turns
[../../design/reasoning-messages.md](../../design/reasoning-messages.md) into
an actionable implementation plan.

The plan assumes:

- reasoning display uses a new `message.role = "reasoning"`
- reasoning messages are browser-visible and fetched through the existing
  messages endpoint
- provider replay continues to use `llm_call_item` provider-only payloads
- reasoning rows are never model-visible
- OpenAI and ds4 show reasoning summaries/text when emitted
- Anthropic full thinking is allowed to be user-visible
- redacted thinking remains hidden
- web support leads mobile/native support

## Files

### `implementation-spec.md`

Parent implementation spec for the reasoning messages rollout.

Documents:

- fixed product and architecture decisions
- phase sequencing
- impacted service, web, protocol, and DB contracts
- validation and rollout expectations

### `phase-1-schema-and-replay-boundary.md`

Service foundation phase covering:

- `reasoning` message role
- migration/Drizzle implications
- transcript serialization
- model-visible loader exclusion
- thread-preview and notification exclusion

### `phase-2-agent-stream-and-persistence.md`

Agent runtime phase covering:

- pre-created `llmCallId`
- canonical reasoning event collection
- live `agent.reasoning_*` stream events
- runtime `draft_reasoning`
- reasoning message persistence
- failed/canceled turn cleanup

### `phase-3-web-rendering-and-history.md`

Reference web phase covering:

- API type updates
- stream parsing and draft reconciliation
- `/agent/state.draft_reasoning` overlays
- reasoning role renderer
- history rendering through existing message pages

### `phase-4-validation-docs-and-mobile-handoff.md`

Finalization phase covering:

- provider-specific manual validation
- protocol/spec updates
- regression tests
- mobile/native handoff after web behavior is validated

### `phase-5-message-role-migration-audit.md`

Follow-up migration audit phase covering:

- verification that `message.role` is physically plain text in Drizzle
  snapshots and live databases
- `pnpm db:generate` output review for the `reasoning` role vocabulary change
- checked-in migration creation if Drizzle or live schema constraints require it
- explicit no-op documentation if no SQL migration is required

### `progress-checklist.md`

Running implementation checklist for reasoning messages.

### `validation-checklist.md`

Manual and automated validation checklist for reasoning messages.

## Dependencies

- [../../design/reasoning-messages.md](../../design/reasoning-messages.md) - source design
- [../../review/provider-reasoning-visibility-review.md](../../review/provider-reasoning-visibility-review.md) - current-state provider reasoning review
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - canonical reasoning and provider-ledger behavior
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - provider reasoning stream behavior
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent model runner and transcript writer ownership
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - message and LLM call schema ownership
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - browser message and agent-stream contracts
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - agent runtime snapshot and SSE replay behavior
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md) - thread stream/message state ownership
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) - chat timeline rendering
- [../../docs/proto.md](../../docs/proto.md) - browser SSE protocol contract
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Fixed Decisions

- Persist user-visible reasoning as `message.role = "reasoning"`.
- Keep replay, cache, and provider continuity on `llm_call_item`.
- Do not include provider replay payloads in reasoning messages.
- Do not include reasoning rows in model-visible conversation loading.
- Do not use reasoning for push notifications or thread previews.
- Show reasoning by default in web.
- Defer collapse settings and native/mobile adoption until after web validation.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
