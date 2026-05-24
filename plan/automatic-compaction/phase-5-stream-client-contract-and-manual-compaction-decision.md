# Phase 5: Stream Client Contract And Manual Compaction Decision

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Deferred after first automatic-compaction tranche

---

## Objective

Make compaction observable to clients without exposing checkpoint internals, and decide whether a manual compaction API belongs in the first product surface.

By the end of this phase:

- optional compaction SSE events are specified and implemented if product wants live visibility
- first-party clients tolerate or consume those events
- protocol docs describe the additive event family
- manual compaction is either explicitly deferred or scoped behind an owner-authorized route

## Scope

### In Scope

- additive `agent.compaction_start`, `agent.compaction_done`, and `agent.compaction_failed` events
- service runtime emission points
- first-party TypeScript event shape updates
- protocol/spec docs for shipped event fields
- manual compaction product decision and route sketch

### Out Of Scope

- exposing raw checkpoint summaries to normal transcript APIs
- mobile-only UI work outside this repo
- checkpoint browsing/admin console
- user-editable compaction prompts

## Implementation Tasks

### Task 1: Decide event rollout

Choose one:

- ship additive compaction SSE events in this phase
- keep compaction server-only for the first release and document the deferred event shape

If events ship, they must be optional and safe for existing clients to ignore.

### Task 2: Define event payloads

Recommended event names:

- `agent.compaction_start`
- `agent.compaction_done`
- `agent.compaction_failed`

Recommended fields:

- `turn_id`
- `checkpoint_id`
- `trigger`
- `reason`
- `phase`
- `tokens_before`
- `tokens_after`
- `threshold_tokens`
- `context_window_tokens`

Failure events may include:

- `error_code`
- `retryable`

Do not include raw summary, replacement history, provider request payloads, or full provider error messages.

### Task 3: Emit events at runtime boundaries

If events ship:

- emit `agent.compaction_start` immediately before the compactor provider call
- emit `agent.compaction_done` after the completed checkpoint is persisted
- emit `agent.compaction_failed` after a failed checkpoint attempt is persisted

Emission should use the existing agent runtime event bus so `/agent/state` and `/agent/stream` remain consistent with current attach semantics.

### Task 4: Update first-party client types

If events ship, update:

- web stream event type definitions
- stream reducer tolerance for the new event family
- any fixtures used by web/mobile handoff docs

The reference web UI can ignore the event beyond type acceptance unless product wants a visible activity marker.

### Task 5: Make the manual compaction decision

Recommended first release decision: defer public manual compaction.

If manual compaction is pulled into scope, use:

```text
POST /api/threads/:thread_id/agent/compact
```

Route requirements:

- resolve `thread_id` through `getAuthorizedThread(...)`
- return `401` only for unauthenticated requests
- return `404` for authenticated non-owner access
- call the same `AgentContextCompactor`
- return `checkpoint_id`, `status`, `tokens_before`, and `tokens_after`
- do not return raw `replacement_history`
- decide whether the route can run during an active agent turn or must reject with a typed conflict

A slash-command implementation should be deferred unless product explicitly wants chat-input command semantics.

## Files Likely Affected

- `service/src/agent/agent-service.ts`
- `service/src/agent/context-compactor.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/routes/threads/`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/lib/api-types.ts`
- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/features/threads/threads.spec.md`

## Tests

If stream events ship, add tests for:

- start event emitted before compaction call
- done event emitted after completed checkpoint persistence
- failed event emitted after failed checkpoint persistence
- existing stream consumers ignore unknown event fields
- no raw summary or replacement history appears in event payloads

If manual route ships, add tests for:

- owner can trigger manual compaction
- authenticated non-owner receives `404`
- unauthenticated request receives `401`
- active-run conflict behavior
- route response excludes raw replacement history

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Event payload leaks sensitive summary text | Low | High | Whitelist metadata fields only |
| Clients treat compaction event as transcript content | Medium | Medium | Keep event names separate from `message.*` and document no transcript row is created |
| Manual compaction conflicts with active turns | Medium | High | Defer route or reject during active run with explicit typed error |
| Product overcommits to manual compaction before automatic behavior is stable | Medium | Medium | Keep public route deferred by default |

## Exit Criteria

- Stream observability is either implemented additively or explicitly deferred.
- Protocol/spec docs match the chosen client contract.
- Manual compaction is either out of scope or fully owner-authorized and tested.
