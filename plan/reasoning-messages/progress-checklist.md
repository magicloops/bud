# Progress Checklist: Reasoning Messages

## Phase 1: Schema And Replay Boundary

- [ ] Add `reasoning` to service message role vocabulary
- [ ] Resolve Drizzle migration or SQL-no-op status
- [ ] Exclude reasoning rows from conversation loading
- [ ] Add loader regression tests
- [ ] Confirm previews and notifications ignore reasoning rows
- [ ] Update service DB/agent/route specs

## Phase 2: Agent Stream And Persistence

- [ ] Pre-create `llmCallId` before provider invocation
- [ ] Emit live `agent.reasoning_start`
- [ ] Emit live `agent.reasoning_delta`
- [ ] Track `draft_reasoning` in runtime state
- [ ] Add transcript writer method for reasoning rows
- [ ] Persist reasoning after successful provider response
- [ ] Emit `agent.reasoning_done` with persisted message
- [ ] Clear draft reasoning on failed/canceled turns
- [ ] Add runtime/model-runner/transcript tests

## Phase 3: Web Rendering And History

- [ ] Add API types for reasoning events and state
- [ ] Parse reasoning SSE events
- [ ] Add reasoning draft state helpers
- [ ] Overlay `/agent/state.draft_reasoning`
- [ ] Add reasoning role renderer
- [ ] Reconcile live draft rows with persisted rows
- [ ] Add web state/rendering tests

## Phase 4: Validation, Docs, And Mobile Handoff

- [ ] Update `docs/proto.md`
- [ ] Update service specs
- [ ] Update web specs
- [ ] Validate OpenAI reasoning
- [ ] Validate Anthropic thinking
- [ ] Validate ds4 Thinking and Fast
- [ ] Validate refresh and history behavior
- [ ] Validate provider-ledger replay still works
- [ ] Create mobile/native handoff

## Deferred Follow-Ups

- [ ] Collapse tool/reasoning/intermediate output between user turns
- [ ] Consider linking `llm_call_item.message_id` to reasoning messages
- [ ] Revisit reasoning retention and export policy
