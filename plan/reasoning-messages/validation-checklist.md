# Validation Checklist: Reasoning Messages

## Automated

- [x] `service` conversation-loader test: reasoning rows are skipped
- [ ] `service` provider-ledger test: provider-native reasoning replay remains
  unchanged
- [x] `service` runtime test: `draft_reasoning` serializes and clears
- [x] `service` model-runner test: canonical reasoning events produce returned
  reasoning segments and runtime events
- [x] `service` transcript-writer test: reasoning rows persist with expected
  metadata and owner stamping
- [x] `web` thread-message-state test: draft reasoning start/delta/done
  reconciliation
- [x] `web` thread-message-state test: failed/canceled final clears draft
  reasoning
- [ ] `web` rendering test or smoke: `role: "reasoning"` renders visibly

## Manual Provider Runs

### OpenAI

- [ ] Select a reasoning-enabled OpenAI model
- [ ] Send a prompt that produces reasoning
- [ ] Confirm reasoning appears live
- [ ] Confirm reasoning appears after refresh
- [ ] Confirm provider-ledger replay still works on a follow-up turn

### Anthropic

- [ ] Select an Anthropic thinking-enabled model
- [ ] Send a prompt that produces thinking
- [ ] Confirm thinking appears live
- [ ] Confirm thinking appears after refresh
- [ ] Confirm redacted thinking is not shown as visible text
- [ ] Confirm same-provider replay does not degrade unexpectedly

### ds4

- [ ] Select ds4 `Thinking`
- [ ] Confirm the request includes reasoning summary opt-in
- [ ] Confirm reasoning appears when ds4 emits summary/text deltas
- [ ] Refresh after completion and confirm reasoning is in history
- [ ] Select ds4 `Fast`
- [ ] Confirm no reasoning row appears
- [ ] Confirm cache behavior remains valid on follow-up turns

## Product Behavior

- [ ] Reasoning is visible by default
- [x] Reasoning rows do not update thread previews
- [x] Reasoning rows do not enqueue push notifications
- [x] Reasoning rows do not appear in model-visible prompt reconstruction
- [ ] Reasoning rows are owner-scoped through existing thread/message routes
- [ ] Older web clients tolerate the additive message role and SSE events

## Docs

- [x] `docs/proto.md` documents reasoning messages and events
- [x] Service specs updated
- [x] Web specs updated
- [ ] Mobile handoff created after web validation
