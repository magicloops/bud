# tool-timing

Implementation planning documents for adding authoritative tool-call timing to the existing transcript and agent-stream contract so mobile can compact sequential tool rows and show accurate durations.

## Purpose

This folder turns the design work in:

- [../../design/mobile-tool-call-timing-and-compaction.md](../../design/mobile-tool-call-timing-and-compaction.md)
- [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md)
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)

into an actionable phased implementation and validation plan.

The plan assumes:

- grouped or compacted tool rows remain a client-side presentation concern
- the backend should add authoritative timing to canonical tool metadata
- the backend should optionally expose matching server-clock timestamps on live `agent.tool_call` and `agent.tool_result` events
- tool timing belongs in persisted `message.metadata`, not in the replayed `message.content` payload
- exact assistant-response timing remains out of scope for this tranche

## Files

### `implementation-spec.md`

Parent implementation spec for the tool-timing rollout.

Documents:

- the current tool lifecycle and timing gap
- fixed design decisions
- phase sequencing
- risks and definition of done

### `phase-1-service-timing-model-and-capture-boundaries.md`

Service-foundation phase covering:

- authoritative timing boundaries for one tool call
- where `started_at` and `finished_at` are captured in the agent loop
- threading timing data through service types and writer boundaries

### `phase-2-canonical-metadata-and-agent-stream-rollout.md`

Contract phase covering:

- canonical persisted tool metadata additions
- additive `agent.tool_call` and `agent.tool_result` fields
- preserving the existing replay payload in `message.content`

### `phase-3-client-adoption-and-turn-aggregation-contract.md`

Consumer phase covering:

- first-party type updates and compatibility notes
- mobile compaction and duration aggregation rules
- limits around exact non-tool timing in this tranche

### `phase-4-tests-docs-and-validation.md`

Finalization phase covering:

- automated test coverage
- spec and protocol doc updates
- fixture and handoff updates
- manual validation

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/mobile-tool-call-timing-and-compaction.md](../../design/mobile-tool-call-timing-and-compaction.md) - design review and recommended timing contract
- [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md) - current stable message identity model for tool rows
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) - live stream attach/resume semantics that the additive tool timing fields must preserve
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current agent orchestration and event contract
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - current route and SSE contract
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Exact assistant-response timing remains intentionally out of scope for this plan. If product later needs authoritative non-tool timing, add a separate design/plan set for assistant draft timestamps or explicit turn summaries rather than expanding this tool-timing tranche mid-implementation.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
