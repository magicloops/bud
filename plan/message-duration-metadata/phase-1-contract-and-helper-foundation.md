# Phase 1: Contract And Helper Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Lock the per-message timing contract and add the shared service helpers/types
needed by all later phases.

By the end of this phase:

- the metadata field names and source semantics are stable
- service code has one helper for wall-clock duration metadata
- tests can assert the same serialization shape across tool, reasoning, and
  assistant rows

## Scope

### In Scope

- shared internal timing shape
- shared metadata serializer
- metadata source constant
- type-level documentation for the v1 contract
- additive test coverage for helper behavior

### Out Of Scope

- changing persisted tool/reasoning/assistant rows
- changing live SSE payloads
- updating client types
- adding relational columns or migrations

## Implementation Tasks

### Task 1: Define the internal timing type

Add or reuse a small service-agent type:

```ts
type AgentMessageTiming = {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
};
```

If the existing `ToolExecutionTiming` shape is already general enough, either
rename it to a role-neutral name or add a role-neutral alias. Avoid parallel
tool-only and message-wide helpers that can drift.

### Task 2: Add a single builder

Add a helper that clamps duration to a non-negative value:

```ts
function buildAgentMessageTiming(
  startedAt: Date,
  finishedAt: Date,
): AgentMessageTiming;
```

The helper should use:

```ts
Math.max(0, finishedAt.getTime() - startedAt.getTime())
```

### Task 3: Add a single serializer

Add a serializer that returns the exact API metadata fields:

```ts
function serializeAgentMessageTiming(timing: AgentMessageTiming): {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  duration_source: "service_wall_clock";
};
```

Keep `Date` objects internally and only stringify at persistence/SSE boundaries.

### Task 4: Preserve existing tool helper compatibility

If existing code imports `buildToolExecutionTiming(...)` or
`serializeToolExecutionTiming(...)`, preserve those exports as wrappers or
aliases during the rollout. This avoids mixing mechanical rename churn into the
metadata work.

### Task 5: Document metadata semantics close to code

Add concise comments or type names that clarify:

- `started_at` is when that message artifact begins producing/executing work
- `finished_at` is when that artifact completes
- `duration_ms` is per artifact, not per turn
- `duration_source` is currently `service_wall_clock`

## Files Likely Affected

- `service/src/agent/contracts.ts`
- `service/src/agent/transcript-writer.test.ts`

## Tests

Add or extend unit tests that verify:

- positive duration serializes correctly
- zero duration serializes correctly
- inverted timestamps clamp to `0`
- `duration_source` is always `service_wall_clock`

## Exit Criteria

- A shared helper exists for all later phases.
- Existing tool timing imports still work.
- The serialized shape exactly matches the design contract.
