# Phase 3: Web Rendering And History

## Objective

Render reasoning messages in the web chat timeline, both live and after history
reloads, visible by default.

## Scope

- Extend API types for `draft_reasoning` and reasoning stream events.
- Parse `agent.reasoning_start`, `agent.reasoning_delta`, and
  `agent.reasoning_done` in `use-agent-stream.ts`.
- Add message-state helpers for draft reasoning rows.
- Overlay `/agent/state.draft_reasoning` during bootstrap/recovery.
- Reconcile persisted reasoning messages from done events.
- Clear unpersisted reasoning drafts on failed/canceled final events.
- Add a reasoning role renderer or timeline branch.
- Keep reasoning visible by default.
- Ensure reasoning rows do not trigger assistant-final indicator behavior.

## UI Behavior

Initial web behavior:

- show a message row labeled `Reasoning`
- stream text into the row while reasoning deltas arrive
- replace the draft row with the persisted message on `agent.reasoning_done`
- preserve the row after refresh because it comes from `/messages`
- use the same chronological ordering rules as other messages

The future collapse control is out of scope.

## Expected Code Changes

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/features/threads/thread-message-state.test.ts`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/message-renderers/roles/reasoning.tsx`
- `web/src/components/message-renderers/roles/index.ts`

## Spec Files To Update

- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`

## Acceptance Criteria

- [ ] Live reasoning appears as the provider streams it.
- [ ] Persisted reasoning replaces the draft row without duplication.
- [ ] Page refresh during an active turn restores draft reasoning from
  `/agent/state`.
- [ ] Page refresh after completion shows reasoning from `/messages`.
- [ ] Reasoning is visible by default.
- [ ] Failed/canceled turns remove unpersisted draft reasoning.
- [ ] Tool and assistant rendering still behaves as before.

## Tests

- `thread-message-state` tests for reasoning draft start/delta/done.
- `thread-message-state` tests for final failed/canceled cleanup.
- Stream hook parsing tests if existing test style supports it.
- Component-level smoke or focused render coverage for the reasoning row if
  existing web tests support it.

## Risks

- Treating reasoning as an assistant message can incorrectly suppress or reveal
  the generic thinking indicator. The renderer/state helpers should key on
  `role: "reasoning"` explicitly.
- Existing clients with generic role fallback may render reasoning as plain
  text. This is acceptable during web-first rollout but should be covered in
  the mobile handoff.
