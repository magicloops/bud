# Validation Checklist: Tool Timing For Mobile Compaction

Manual validation pending.

## Automated Verification Completed

- [x] `pnpm --dir service exec node --import tsx --test src/agent/agent-service.test.ts src/agent/conversation-loader.test.ts src/agent/transcript-writer.test.ts src/runtime/agent-runtime-state.test.ts`

Add more focused commands here once the final test file set is known.

## Live Stream Contract

- [ ] `agent.tool_call` includes `started_at`
- [ ] `agent.tool_result` includes `started_at`, `finished_at`, and `duration_ms`
- [ ] `agent.tool_result.duration_ms` is non-negative
- [ ] The top-level timing fields match the nested canonical `message.metadata` timing fields

## Canonical Transcript Contract

- [ ] `GET /api/threads/:thread_id/messages` returns completed tool rows with `metadata.started_at`
- [ ] `GET /api/threads/:thread_id/messages` returns completed tool rows with `metadata.finished_at`
- [ ] `GET /api/threads/:thread_id/messages` returns completed tool rows with `metadata.duration_ms`
- [ ] `message.created_at` remains distinct from `metadata.finished_at`

## Replay Safety

- [ ] Canonical tool `message.content` does not gain timing-only fields
- [ ] Historical tool replay through `conversation-loader.ts` still works
- [ ] No model-facing replay regression appears because of the metadata/content divergence

## Resume / Recovery

- [ ] Replayed tool events after resume carry the same timing fields as live events
- [ ] Cursor-based attach/resume behavior is unchanged
- [ ] `agent.resync_required` behavior is unchanged

## Client Compatibility

- [ ] The existing web thread view still loads and renders tool rows without breakage
- [ ] First-party TypeScript consumers compile cleanly after the additive fields
- [ ] Mobile fixtures or handoff docs reflect the final shipped payloads

## Aggregation Semantics

- [ ] A client can compute per-tool duration directly from `duration_ms`
- [ ] A client can compute grouped total tool duration by summing child `duration_ms`
- [ ] A client can compute grouped wall interval using `min(started_at)` and `max(finished_at)`
- [ ] The docs clearly state that exact assistant/non-tool timing is still approximate in this tranche

## Docs / Specs

- [x] `docs/proto.md` reflects the shipped tool timing fields
- [x] Relevant service specs are updated
- [ ] `bud.spec.md` includes the new plan references and still reads coherently
