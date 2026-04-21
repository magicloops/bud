# Phase 4: Tests, Docs, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Finish the rollout with focused test coverage, spec/doc updates, and validation that the timing contract is correct, additive, and replay-safe.

By the end of this phase:

- the service has direct automated coverage for the new timing fields
- the root and service specs describe the shipped contract
- protocol and fixture docs are updated
- manual validation confirms live and canonical timing match expectations

## Scope

### In Scope

- direct service tests
- spec/doc updates
- fixture/handoff updates
- manual validation of live stream and canonical transcript behavior

### Out Of Scope

- broad mobile UI validation in the separate repo
- exact assistant-timing follow-up work

## Implementation Tasks

### Task 1: Add focused automated coverage

Add or extend direct tests around:

- `agent.tool_call` payload includes `started_at`
- `agent.tool_result` payload includes `started_at`, `finished_at`, and `duration_ms`
- nested canonical `message.metadata` includes the same values
- canonical `message.content` does not gain the timing fields
- duration is non-negative and derived from the captured boundaries

Likely targets:

- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/agent/model-runner.test.ts` only if stream typing changes require it
- `service/src/agent/agent-service.test.ts`
- new or updated transcript-writer-focused tests if needed

### Task 2: Update protocol and spec docs

Update the authoritative docs/specs that describe the shipped contract:

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `plan/tool-timing/tool-timing.spec.md`
- `bud.spec.md`

If the design doc wording drifts from the final implementation, reconcile:

- `design/mobile-tool-call-timing-and-compaction.md`

### Task 3: Update fixtures and mobile handoff docs

Publish final examples showing:

- live `agent.tool_call`
- live `agent.tool_result`
- canonical persisted tool message with timing metadata

The exact file can be chosen during implementation, but the deliverable should be easy for mobile to consume in adapter tests.

### Task 4: Run manual validation

Validate at least these cases:

- one short successful tool call
- one longer tool call with a visible multi-second duration
- attach/resume or reconnect while a tool is in flight
- canonical `/messages` fetch after completion
- existing web thread view remains compatible

### Task 5: Record explicit follow-up if assistant timing is still desired

If product still wants precise non-tool timing after this rollout, create a follow-up design/plan reference instead of expanding this plan’s scope during finalization.

## Files Likely Affected

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `bud.spec.md`
- relevant service test files

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The rollout ships without a test guarding `message.content` vs `message.metadata` divergence | Medium | High | Add a direct assertion for that distinction rather than inferring it indirectly |
| Fixture docs show one contract while specs show another | Medium | Medium | Update both in the same phase and review examples against real serialized payloads |
| Manual validation only checks live stream or only checks canonical transcript, not both | Medium | Medium | Treat both surfaces as required checklist items |

## Exit Criteria

- Automated tests cover the new timing fields and the replay-safety rule.
- Protocol/spec/fixture docs all describe the same contract.
- Manual validation confirms live and persisted timing behavior without breaking current clients.

