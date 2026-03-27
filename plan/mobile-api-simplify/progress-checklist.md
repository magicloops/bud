# Mobile API Simplify Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the transcript-history and agent-stream simplification phases land.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Message History Contract

### Backend Contract

- [x] `GET /api/threads/:thread_id/messages` supports opaque cursor paging.
- [x] `before` loads older history.
- [x] `after` loads newer history where needed.
- [x] page responses include explicit metadata instead of a bare array.
- [x] page ordering is stable with a documented tie-break rule.
- [x] page boundaries are exclusive and documented.

### Fixtures And Docs

- [x] latest-page example is checked in.
- [x] older-page example is checked in.
- [x] empty/end-of-history example is checked in.
- [x] mobile/web handoff docs no longer imply nonexistent paging behavior.

## Phase 2: Agent Stream Contract

### Event Semantics

- [x] successful turns expose stable identifiers for tool and assistant reconciliation.
- [x] failure turns emit documented `final` semantics.
- [x] canceled turns emit documented `final` semantics.
- [x] replay behavior is explicit and tested.
- [x] duplicate replay behavior is documented as expected.

### Recovery Model

- [x] clients can reconcile live SSE against canonical transcript history without synthetic guesswork.
- [x] stream fixtures exist for success, failure, cancel, and reconnect/replay.

## Phase 3: Reference Web Simplification

### Transcript Consumption

- [x] web thread loader uses the new paged transcript contract.
- [x] web can prepend older history without losing anchor.
- [x] web uses backend-provided identifiers for live reconciliation.
- [x] web no longer depends on full-array transcript replacement on every `final`.

### Reference Behavior

- [x] workbench/thread specs describe the new transcript model accurately.
- [x] the reference web client demonstrates the intended consumption pattern for future clients.

## Phase 4: True Assistant Streaming

### Backend

- [x] `AgentService` uses streaming model invocation for assistant output.
- [x] assistant text deltas are emitted under a documented event family.
- [x] final assistant persistence still converges to canonical history.

### Client Semantics

- [x] clients can render draft assistant content incrementally.
- [x] final assistant content replaces or finalizes the draft cleanly.
- [x] cancel/failure behavior remains clear under the streaming model.

## Phase 5: Polish, Validation, And Handoff

### Tool Payloads

- [x] tool truncation semantics are documented per tool.
- [x] output-size semantics are documented per tool.
- [x] optional summary/preview fields are added if still justified.

### Handoff And Validation

- [x] fixtures are published for the final transcript and SSE contracts.
- [x] `reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md` is updated.
- [x] `reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md` is updated.
- [x] touched specs are updated.
- [x] end-to-end validation is complete.

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Cursor-paged history contract, examples, and handoff docs are aligned |
| 2 | Complete | Stable identifiers, resume-by-event-id replay, checked-in stream fixtures, replay tests, and web/manual validation are now in place |
| 3 | Complete | Web uses paged history plus backend-provided live identifiers and only falls back to canonical refetch on reconnect/drift |
| 4 | Complete | Provider streaming, assistant draft SSE events, web draft reconciliation, and the live send/tool/final smoke path are validated |
| 5 | Complete | Tool-payload semantics, fixtures, handoff docs, and the full build/test/smoke validation set are aligned with the shipped contract |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If sequencing changes, update the checklist and the phase docs together.
