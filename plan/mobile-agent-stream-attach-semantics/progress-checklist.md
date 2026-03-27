# Mobile Agent Stream Attach Semantics Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the runtime-snapshot and live-only-attach work lands.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Runtime Snapshot Foundation

### Backend Contract

- [ ] service tracks agent runtime state per thread.
- [ ] `GET /api/threads/:thread_id/agent/state` exists.
- [ ] the route is ownership-aware like other thread routes.
- [ ] idle response shape is documented.
- [ ] active response shape is documented.
- [ ] `stream_cursor` is exposed as an opaque monotonic resume token.
- [ ] `stream_cursor` exists before the first visible event of an active turn.
- [ ] `stream_cursor` is returned on idle snapshots too.

### Lifecycle Semantics

- [ ] pending tool state is represented explicitly.
- [ ] draft assistant state is represented explicitly.
- [ ] success clears runtime state back to idle only after final durable state is available.
- [ ] failure clears runtime state back to idle only after final durable state is available.
- [ ] cancel clears runtime state back to idle only after final durable state is available.

## Phase 2: Reference Web Adoption

### Thread Open

- [ ] web fetches `/messages` and `/agent/state` on thread open.
- [ ] web seeds pending tool UI from `/agent/state`.
- [ ] web seeds draft assistant UI from `/agent/state`.
- [ ] web stop-button visibility depends on actual runtime state, not stale replay.

### Stream Attach

- [ ] web attaches `agent/stream` with the snapshot cursor.
- [ ] web no longer depends on fresh-attach replay for active-turn bootstrap.
- [ ] web handles explicit `resync_required` by refetching `/messages` plus `/agent/state`.
- [ ] web does not depend on client-side gap repair for normal recovery.
- [ ] reconnect recovery still reconciles against canonical history when needed.

## Phase 3: Live-Only Attach And Handoff

### Backend Stream Semantics

- [ ] no-cursor agent-stream attach is live-only.
- [ ] valid cursor replay still replays only newer buffered effects within the bounded window.
- [ ] stale cursor produces explicit `resync_required`.
- [ ] terminal-stream semantics are unchanged.

### Docs And Fixtures

- [ ] protocol docs are updated.
- [ ] service specs are updated.
- [ ] web specs are updated.
- [ ] iOS/backend handoff docs are updated.
- [ ] fixtures cover passive open, active-turn open, reconnect, and stale cursor `resync_required`.

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Explicit current-turn snapshot route, resume-token invariant, and durable idle-reset ordering are still to be implemented |
| 2 | Not Started | Reference web still uses the pre-change bootstrap model and does not yet follow a server-owned resync path |
| 3 | Not Started | Agent-stream no-cursor attach still replays the current buffer today and stale resume is not yet explicit |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If rollout sequencing changes, update this checklist and the phase docs together.
