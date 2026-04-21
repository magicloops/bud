# Implementation Spec: Tool Timing For Mobile Compaction

**Status**: Planned
**Created**: 2026-04-21
**Design Doc**: [../../design/mobile-tool-call-timing-and-compaction.md](../../design/mobile-tool-call-timing-and-compaction.md)
**Related Design**: [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md)
**Related Design**: [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-service-timing-model-and-capture-boundaries.md](./phase-1-service-timing-model-and-capture-boundaries.md)
**Phase 2**: [phase-2-canonical-metadata-and-agent-stream-rollout.md](./phase-2-canonical-metadata-and-agent-stream-rollout.md)
**Phase 3**: [phase-3-client-adoption-and-turn-aggregation-contract.md](./phase-3-client-adoption-and-turn-aggregation-contract.md)
**Phase 4**: [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md)

---

## Context

Bud already has the right structural model for grouped tool rows:

- each live tool call has a stable `client_id`
- each live tool call has a stable `call_id`
- the canonical persisted tool row arrives in `agent.tool_result`
- `/api/threads/:thread_id/messages` later returns that same canonical row with full metadata

That means compacted or grouped mobile tool rows do not require a new transcript route, grouped backend row, or grouped SSE event.

The remaining gap is timing. Today:

- `agent.tool_call` has no server timestamp
- `agent.tool_result` has no authoritative start/end timing
- persisted tool metadata has no `started_at`, `finished_at`, or `duration_ms`
- `message.created_at` reflects durable row creation time, not the true start of tool execution

The result is that mobile can already group tool rows, but it cannot show accurate durations without relying on local receipt time.

## Objective

Add authoritative server-side timing for one tool call while preserving the existing transcript and stream architecture.

Specifically:

- keep grouped tool rows as a client concern
- capture one authoritative `started_at` and `finished_at` per tool call in the service
- expose those timestamps and `duration_ms` in canonical persisted tool metadata
- add matching additive timing fields to live `agent.tool_call` and `agent.tool_result`
- keep `message.content` as the current replay payload so conversation replay does not gain UI-only timing data

## Fixed Decisions

These decisions are fixed for this plan:

- Tool timing belongs to the existing canonical tool message, not a new table or grouped-summary row.
- Grouping or compaction remains a client-side presentation feature.
- `started_at` is captured immediately before `agent.tool_call` is emitted and before the tool executes.
- `finished_at` is captured immediately after tool execution resolves and before the canonical tool row is emitted.
- `duration_ms` is derived from those timestamps in the service.
- Timing fields are persisted in `message.metadata`, not `message.content`.
- `agent.tool_call` gains `started_at`.
- `agent.tool_result` gains `started_at`, `finished_at`, and `duration_ms`.
- The agent runtime snapshot `/agent/state.pending_tool` remains unchanged in this tranche.
- Exact assistant-response timing remains out of scope for this plan.
- No database migration is required because the new canonical timing fields live in the existing JSONB metadata column.

## Success Criteria

- [ ] A completed canonical tool row in `/api/threads/:thread_id/messages` exposes `started_at`, `finished_at`, and `duration_ms` under `metadata`.
- [ ] `agent.tool_call` exposes `started_at`.
- [ ] `agent.tool_result` exposes `started_at`, `finished_at`, and `duration_ms`.
- [ ] The nested canonical `message.metadata` carried by `agent.tool_result` exposes the same timing values.
- [ ] `message.content` remains suitable for conversation replay and does not gain timing-only fields.
- [ ] First-party type definitions and fixtures reflect the additive fields without breaking current clients.
- [ ] Specs and protocol docs describe the shipped timing contract clearly enough for mobile adoption.

## Non-Goals

- building grouped-summary transcript rows on the backend
- changing `/api/threads/:thread_id/messages` route shape
- adding a new tool-timing table or indexed relational timing store
- adding exact assistant draft timestamps or precise non-tool timing
- introducing a turn-summary route or turn-summary SSE event
- redesigning stream attach/resume semantics
- changing message ordering or pagination

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-service-timing-model-and-capture-boundaries.md](./phase-1-service-timing-model-and-capture-boundaries.md) | Urgent | Establish one authoritative timing model and capture boundary in the service agent loop |
| 2 | [phase-2-canonical-metadata-and-agent-stream-rollout.md](./phase-2-canonical-metadata-and-agent-stream-rollout.md) | Urgent | Ship additive persisted metadata and SSE timing fields without polluting replay payloads |
| 3 | [phase-3-client-adoption-and-turn-aggregation-contract.md](./phase-3-client-adoption-and-turn-aggregation-contract.md) | High | Align first-party consumer types and document aggregation rules for mobile compaction |
| 4 | [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md) | High | Add focused tests, update docs/specs/fixtures, and validate compatibility and timing semantics |

## Expected Files And Areas

### Service

- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`

### Web

- `web/src/features/threads/use-agent-stream.ts`
- `web/src/lib/api-types.ts`

Only lightweight type alignment is expected in this repo. Mobile compaction UI work lives in the separate mobile repo.

### Docs / Specs

- `docs/proto.md`
- `design/mobile-tool-call-timing-and-compaction.md`
- `plan/tool-timing/tool-timing.spec.md`
- `bud.spec.md`

## Sequencing Notes

- Phase 1 should land before any SSE contract work so the service has one authoritative timing source and no duplicated timestamp capture.
- Phase 2 should update canonical metadata and stream payloads together so live and persisted timing cannot drift semantically.
- Phase 3 should document aggregation and client adoption only after the exact shipped fields are stable.
- Phase 4 should include both stream-level and canonical-transcript validation because the contract is intentionally split across those two surfaces.
- If implementation reveals that product really needs exact assistant-response timing, record that as a new follow-up rather than adding assistant timing fields opportunistically in this tool-timing rollout.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `started_at` and `finished_at` are captured from different service layers and drift semantically | Medium | High | Capture both boundaries in `AgentService.runAgentFlow(...)` and thread them through downstream calls rather than recomputing later |
| Tool timing leaks into `message.content` and bloats replay context | Medium | High | Treat preservation of replay payload shape as a hard design requirement and test it directly |
| Clients interpret `message.created_at` and `finished_at` as equivalent | Medium | Medium | Document the distinction explicitly in specs and fixtures |
| The web client or future typed consumers reject additive stream fields | Low | Medium | Update first-party TypeScript shapes in the same rollout and keep fields additive/optional |
| Product over-interprets `turn_wall_time_ms - tool_time_ms` as exact assistant time | Medium | Medium | Document that exact non-tool timing is still approximate in this tranche |

## Rollout Strategy

1. Add one service-owned timing model and pass it through the agent execution boundary.
2. Persist timing to canonical tool `message.metadata` only.
3. Add matching additive fields to `agent.tool_call` and `agent.tool_result`.
4. Update first-party types and fixtures to tolerate and document the new fields.
5. Validate canonical transcript, live stream, resume behavior, and compatibility with existing rendering/replay paths.
6. Record exact assistant-timing work as a separate follow-up if still needed.

## Definition Of Done

- [ ] Tool timing is captured once in the service and not recomputed differently downstream.
- [ ] Canonical tool rows expose `started_at`, `finished_at`, and `duration_ms` in `metadata`.
- [ ] Live `agent.tool_call` and `agent.tool_result` expose the new additive timing fields.
- [ ] `message.content` remains replay-safe and timing-free.
- [ ] First-party types, specs, and docs describe the timing contract accurately.
- [ ] Mobile has enough authoritative timing to compute per-tool duration and grouped tool totals without local receipt-time inference.

