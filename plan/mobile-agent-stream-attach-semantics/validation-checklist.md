# Mobile Agent Stream Attach Semantics Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Runtime Snapshot Foundation

### Route Contract

- [ ] `GET /api/threads/:thread_id/agent/state` returns idle shape for an inactive thread.
- [ ] `GET /api/threads/:thread_id/agent/state` returns active shape for an in-flight turn.
- [ ] `stream_cursor` exists before the first visible event of an active turn.
- [ ] `stream_cursor` is returned on idle snapshots too.
- [ ] `pending_tool` appears only while a tool is in flight.
- [ ] `draft_assistant` reflects the latest streamed draft text when present.

### Ownership And Cleanup

- [ ] unauthorized or cross-user reads return `404`.
- [ ] success resets runtime state to idle only after final durable state is available.
- [ ] failure resets runtime state to idle only after final durable state is available.
- [ ] cancel resets runtime state to idle only after final durable state is available.

## Phase 2: Reference Web Adoption

### Completed Thread Open

- [ ] open an already-completed thread
- [ ] confirm transcript renders from `/messages`
- [ ] confirm there is no transient stop-button flash
- [ ] confirm there is no fake pending-tool row

### Active Turn Open

- [ ] open a thread while another session/device has an active turn
- [ ] confirm pending tool state appears from `/agent/state` when applicable
- [ ] confirm draft assistant state appears from `/agent/state` when applicable
- [ ] confirm stream attaches with `stream_cursor`
- [ ] confirm explicit resync path works if the resume cursor cannot be honored

## Phase 3: Live-Only Attach And Handoff

### Stream Semantics

- [ ] fresh attach without a cursor does not replay prior buffered `agent.*` events
- [ ] fresh attach without a cursor still opens as SSE and receives heartbeat/live events
- [ ] reconnect with a valid cursor replays only newer buffered effects in the resume window
- [ ] reconnect with a stale cursor produces explicit `resync_required`

### Regression Checks

- [ ] terminal-stream attach behavior still matches pre-change behavior
- [ ] failure turns do not leave stale draft state visible
- [ ] canceled turns do not leave stale draft state visible
- [ ] the client does not need client-side gap repair for the tested recovery paths

## Docs / Spec Alignment

- [ ] `service/src/routes/routes.spec.md` updated
- [ ] `service/src/runtime/runtime.spec.md` updated
- [ ] `service/src/agent/agent.spec.md` updated
- [ ] `service/src/src.spec.md` updated if needed
- [ ] `web/src/routes/$budId/budId.spec.md` updated
- [ ] `docs/proto.md` updated
- [ ] `reference/IOS_MOBILE_BACKEND_HANDOFF.md` updated
- [ ] `reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md` updated
- [ ] `reference/IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md` updated
- [ ] `reference/AGENT_STREAM_EVENT_FIXTURES.md` updated
- [ ] `bud.spec.md` updated

## Notes

- This checklist validates the current single-instance, process-local runtime model only.
- If the implementation introduces a temporary compatibility gate, record both pre-flip and post-flip validation results here.
- If production needs cross-instance continuity later, add a separate validation pass once snapshot and resume storage move into shared ephemeral infrastructure.
