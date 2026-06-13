# Validation Checklist: Agent Message Duration Metadata

Manual validation pending.

## Automated Verification

- [x] Record service test command:
  `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/contracts.test.ts src/agent/transcript-writer.test.ts src/agent/model-runner.test.ts src/runtime/agent-runtime-state.test.ts src/agent/agent-service.test.ts`
  Result: passed, 42 tests.
- [x] Record web type/lint command if web files change:
  `pnpm --dir /Users/adam/bud/web exec node --import tsx --test src/features/threads/thread-message-state.test.ts`
  Result: passed, 11 tests, after adding `tsx` to the web package dev dependencies.

Suggested starting point:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/transcript-writer.test.ts src/runtime/agent-runtime-state.test.ts
```

## Persisted Tool Metadata

- [ ] Completed tool rows include `metadata.turn_id`
- [ ] Completed tool rows include `metadata.started_at`
- [ ] Completed tool rows include `metadata.finished_at`
- [ ] Completed tool rows include `metadata.duration_ms`
- [ ] Completed tool rows include `metadata.duration_source: "service_wall_clock"`
- [ ] Tool `message.content` does not include timing-only fields

## Persisted Reasoning Metadata

- [ ] Completed reasoning rows include `metadata.turn_id`
- [ ] Completed reasoning rows include `metadata.started_at`
- [ ] Completed reasoning rows include `metadata.finished_at`
- [ ] Completed reasoning rows include `metadata.duration_ms`
- [ ] Completed reasoning rows include `metadata.duration_source: "service_wall_clock"`
- [ ] Reasoning rows remain model-invisible in replay

## Persisted Assistant Metadata

- [ ] Intermediate assistant rows include `metadata.turn_id`
- [ ] Intermediate assistant rows include `metadata.started_at`
- [ ] Intermediate assistant rows include `metadata.finished_at`
- [ ] Intermediate assistant rows include `metadata.duration_ms`
- [ ] Intermediate assistant rows include `metadata.duration_source: "service_wall_clock"`
- [ ] Final assistant rows include the same timing fields
- [ ] Non-streamed assistant fallback rows use honest zero-duration timing rather than neighboring-row estimates

## Live Stream Contract

- [ ] `agent.message_start` includes `started_at`
- [ ] `agent.message_done` includes `started_at`
- [ ] `agent.message_done` includes `finished_at`
- [ ] `agent.message_done` includes `duration_ms`
- [ ] `agent.message_done` includes `duration_source: "service_wall_clock"`
- [ ] Existing `agent.tool_call` timing still works
- [ ] Existing `agent.tool_result` timing still works
- [ ] Nested emitted `message.metadata` matches the canonical persisted row

## Runtime State Contract

- [ ] `/agent/state.pending_tool.started_at` still works
- [ ] `/agent/state.draft_reasoning.started_at` still works
- [ ] `/agent/state.draft_assistant.started_at` is present while assistant text streams
- [ ] Runtime snapshot remains valid when `draft_assistant` is `null`

## Message History Contract

- [ ] `/api/threads/:thread_id/messages` returns timing metadata after reload
- [ ] Pagination preserves timing metadata
- [ ] Message ordering remains based on `created_at`
- [ ] `message.created_at` is not needed for duration math
- [ ] Signed-in non-owners cannot read another user's timed message metadata

## Client Calculation

- [ ] A client can sum `duration_ms` across collapsed rows
- [ ] A client can compute interval-union wall time from `started_at` and `finished_at`
- [ ] A client can ignore rows without timing metadata
- [ ] Legacy tool-only groups still work from existing `duration_ms`
- [ ] Legacy assistant-only groups omit duration instead of using invented estimates

## Docs / Specs

- [ ] `docs/proto.md` documents message timing metadata
- [ ] `docs/proto.md` documents assistant stream timing fields
- [ ] Service specs document persistence and SSE behavior
- [ ] Web specs are updated if web files change
- [ ] `bud.spec.md` includes this plan folder
