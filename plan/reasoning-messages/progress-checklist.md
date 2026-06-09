# Progress Checklist: Reasoning Messages

## Phase 1: Schema And Replay Boundary

- [x] Add `reasoning` to service message role vocabulary
- [x] Resolve Drizzle migration or SQL-no-op status
- [x] Exclude reasoning rows from conversation loading
- [x] Add loader regression tests
- [x] Confirm previews and notifications ignore reasoning rows
- [x] Update service DB/agent/route specs

## Phase 2: Agent Stream And Persistence

- [x] Pre-create `llmCallId` before provider invocation
- [x] Emit live `agent.reasoning_start`
- [x] Emit live `agent.reasoning_delta`
- [x] Track `draft_reasoning` in runtime state
- [x] Add transcript writer method for reasoning rows
- [x] Persist reasoning after successful provider response
- [x] Emit `agent.reasoning_done` with persisted message
- [x] Clear draft reasoning on failed/canceled turns
- [x] Add runtime/model-runner/transcript tests

## Phase 3: Web Rendering And History

- [x] Add API types for reasoning events and state
- [x] Parse reasoning SSE events
- [x] Add reasoning draft state helpers
- [x] Overlay `/agent/state.draft_reasoning`
- [x] Add reasoning role renderer
- [x] Reconcile live draft rows with persisted rows
- [x] Add web state/rendering tests

## Phase 4: Validation, Docs, And Mobile Handoff

- [x] Update `docs/proto.md`
- [x] Update service specs
- [x] Update web specs
- [ ] Validate OpenAI reasoning
- [ ] Validate Anthropic thinking
- [ ] Validate ds4 Thinking and Fast
- [ ] Validate refresh and history behavior
- [ ] Validate provider-ledger replay still works
- [x] Create mobile/native handoff

## Phase 5: Message Role Migration Audit

- [x] Verify latest Drizzle snapshot records `message.role` as plain `text`.
- [x] Inspect local/staging-like DB for any physical `message_role` enum or
  role check constraint.
- [x] Run `pnpm db:generate` from `service/` and record whether SQL/metadata is
  generated.
- [x] If generated, check in the migration SQL and metadata. Not applicable:
  Drizzle generated no SQL or metadata.
- [x] If not generated, document the reviewed SQL-no-op rationale.
- [x] Update DB/migration specs and this checklist with the final decision.

## Deferred Follow-Ups

- [ ] Collapse tool/reasoning/intermediate output between user turns
- [ ] Consider linking `llm_call_item.message_id` to reasoning messages
- [ ] Revisit reasoning retention and export policy

## Notes

- Phase 5 confirmed `message.role = "reasoning"` is a TypeScript/Drizzle
  vocabulary change only. The checked-in snapshot and live database both record
  `message.role` as plain `text`, no `message_role` enum or role check
  constraint exists, and `pnpm db:generate` reported no schema changes.
- Provider-native replay remains in `llm_call_item`; visible reasoning messages intentionally do not backfill `llm_call_item.message_id` in this phase.
