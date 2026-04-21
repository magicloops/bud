# Phase 3: Client Adoption And Turn Aggregation Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Document and align first-party consumer expectations so the new timing fields are immediately usable for mobile compaction and do not surprise existing clients.

By the end of this phase:

- first-party type definitions in this repo tolerate the new additive fields
- the aggregation rules for compacted tool rows are written down clearly
- the limit between exact tool timing and approximate non-tool timing is explicit

## Context

The mobile app is in a separate repo, but this repo still owns:

- the backend contract
- first-party web types and stream parsing
- the canonical handoff docs and fixtures used by mobile

That means a backend-only rollout is not enough. We also need one clear contract for how clients should interpret the new timing fields.

## Scope

### In Scope

- first-party TypeScript type updates where useful
- stream-parser compatibility notes
- grouped-row aggregation rules for mobile
- documentation of exact vs approximate timing semantics

### Out Of Scope

- building grouped-summary UI in this repo
- exact assistant timing
- changing `/agent/state`

## Implementation Tasks

### Task 1: Update first-party type definitions

Update first-party types to reflect the additive fields, especially around:

- tool message metadata
- `agent.tool_call`
- `agent.tool_result`

The likely targets are:

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`

No web UX change is required, but typed consumers in this repo should no longer silently lag the backend contract.

### Task 2: Publish aggregation rules for compacted tool rows

Document the client-side rules for grouped mobile tool summaries:

- group only adjacent tool rows according to the mobile UI’s presentation rules
- per-tool display duration uses `duration_ms` when present
- grouped total tool duration is `sum(duration_ms)`
- grouped wall interval can be computed as:
  - `min(started_at)`
  - `max(finished_at)`

This keeps grouping a client concern while giving mobile a consistent math model.

### Task 3: Define turn-level timing guidance

Document the recommended terminology:

- `tool_time_ms`: exact sum of tool durations
- `turn_wall_time_ms`: approximate wall time for the whole turn
- `non_tool_time_ms`: approximate `turn_wall_time_ms - tool_time_ms`

Also document the caveat:

- `non_tool_time_ms` is not authoritative assistant generation time in this tranche

### Task 4: Confirm stream resume compatibility

Because the agent stream is resume-aware and additive, document that:

- replayed `agent.tool_call` and `agent.tool_result` events carry the same timing data as live delivery
- resume behavior does not change
- clients should prefer server timestamps over local receipt time when present

### Task 5: Prepare mobile-facing fixtures or handoff notes

Add or update fixtures/handoff docs so mobile has concrete payload examples for:

- one live tool call
- one completed tool result
- one canonical persisted tool row with timing metadata

## Files Likely Affected

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- mobile handoff or fixture docs as selected in Phase 4

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Clients assume `non_tool_time_ms` is exact model-thinking time | Medium | Medium | Document the approximation explicitly in the handoff docs |
| First-party web types remain stale even though runtime behavior still works | Medium | Low | Update the types in the same rollout to keep contract drift visible |
| Mobile groups rows using inconsistent math across screens | Medium | Medium | Publish one shared aggregation rule in the fixtures/handoff docs |

## Exit Criteria

- First-party types in this repo acknowledge the additive timing fields.
- Mobile-facing aggregation math is documented clearly.
- The distinction between exact tool timing and approximate non-tool timing is explicit.

