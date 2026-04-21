# Phase 1: Service Timing Model And Capture Boundaries

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Define and implement one authoritative timing boundary for a tool call inside the service agent loop.

By the end of this phase:

- one tool call has a clear start boundary and end boundary
- the service captures those timestamps in exactly one place
- downstream service helpers receive timing data instead of recomputing it
- the rest of the rollout can safely expose the captured values in metadata and SSE payloads

## Context

The current tool lifecycle spans three layers:

1. `AgentService.runAgentFlow(...)`
2. `AgentTranscriptWriter.emitToolCall(...)`
3. `TerminalToolExecutor.execute(...)`
4. `AgentTranscriptWriter.recordToolResult(...)`

If each layer infers timing independently, the contract becomes ambiguous. This phase makes `AgentService` the authoritative owner of timing boundaries because it already sits at the exact point where a tool call:

- becomes visible to the live stream
- begins execution
- finishes execution
- becomes eligible for durable persistence

## Scope

### In Scope

- defining the exact timing semantics for `started_at`, `finished_at`, and `duration_ms`
- capturing tool-call timing in `AgentService.runAgentFlow(...)`
- threading timing values through service method signatures and internal types
- deciding how to serialize those values consistently

### Out Of Scope

- changing transcript payloads or SSE payloads yet
- client or mobile aggregation rules
- assistant-response timing

## Implementation Tasks

### Task 1: Define the canonical timing semantics

Lock the semantics before code changes spread:

- `started_at`: immediately before `agent.tool_call` is emitted and before terminal execution begins
- `finished_at`: immediately after `toolExecutor.execute(...)` resolves and before the tool result is persisted/emitted
- `duration_ms`: integer milliseconds computed from `finished_at - started_at`

These semantics should be recorded in code comments or types close to the capture point so later phases do not reinterpret the fields.

### Task 2: Introduce a small internal timing shape

Add a narrow internal type, for example:

```ts
type ToolExecutionTiming = {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
};
```

Keep it local to the agent layer unless another service area genuinely needs it.

### Task 3: Capture timing in `AgentService.runAgentFlow(...)`

Refactor the tool-call branch so it follows this order:

1. `const startedAt = new Date()`
2. `emitToolCall(...)`
3. `await toolExecutor.execute(...)`
4. `const finishedAt = new Date()`
5. `const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())`
6. pass timing through to `recordToolResult(...)`

The key requirement is that timing is captured in `AgentService`, not inside the writer or executor.

### Task 4: Thread timing through the writer boundary

Update `AgentTranscriptWriter.emitToolCall(...)` and `recordToolResult(...)` signatures so they can receive timing data from `AgentService`.

The writer should not call `new Date()` independently for the same timing fields.

### Task 5: Centralize timestamp serialization

Ensure the eventual stream/persistence code uses one serialization path for:

- `started_at`
- `finished_at`

Prefer `Date#toISOString()` at the service boundary, but keep `Date` objects internally until the serialization edge.

### Task 6: Decide failure-path semantics

Document and preserve the current behavior for tool-call branches that fail before a canonical tool row is written.

Expected rule for this phase:

- if execution throws before `recordToolResult(...)`, no canonical tool message is persisted
- if execution completes with a tool-level error payload, the timing still belongs to that canonical tool row

This keeps timing semantics aligned with the existing persisted-tool model.

## Files Likely Affected

- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Timing boundaries move during refactor and become inconsistent with the design | Medium | High | Keep boundary capture in one place and test exact ordering assumptions |
| Writer methods start serializing timestamps too early and spread string-vs-Date confusion | Medium | Medium | Keep `Date` objects internal until the persistence/SSE edge |
| A zero- or negative-duration edge case appears under clock precision quirks | Low | Low | Clamp `duration_ms` to `>= 0` |

## Exit Criteria

- `AgentService` owns tool timing capture for the tool-call branch.
- Timing values are passed downstream instead of recomputed.
- Timing semantics are documented and stable enough for payload rollout in Phase 2.

