# Debug: agent-stream-state-and-resume-implementation

## Environment
- OS / arch / versions: local macOS development environment in the Bud monorepo
- DB connection style: PostgreSQL via Drizzle ORM
- LLM mode (real/mocked): real provider integration in service code paths; implementation/debug pass focused on server and reference-web behavior

## Repro Steps
1. Open a thread that previously completed an agent turn.
2. Attach `GET /api/threads/:thread_id/agent/stream` without a resume cursor.
3. Observe buffered `agent.*` and `final` events replay on attach when the service process still has them in memory.
4. Reopen the same thread after a service restart and observe the replay disappear because the in-memory buffer was cleared.
5. Compare this with an active-turn open or reconnect case, where some replay is useful but should be bounded and explicit.

## Observed
- The current shared agent SSE path treats attach-time replay as both:
  - reconnect recovery
  - current-turn bootstrap
- `service/src/runtime/event-bus.ts` replays the whole channel buffer when no cursor is provided.
- `service/src/agent/agent-service.ts` clears the agent buffer only at the start of the next turn, so completed-turn frames remain replayable until then.
- `web/src/routes/$budId/$threadId.tsx` relies on the stream as implicit bootstrap and reconnect recovery, which couples the client to those replay semantics.

## Expected
- Durable transcript history should come from `GET /api/threads/:thread_id/messages`.
- In-flight truth should come from an explicit `GET /api/threads/:thread_id/agent/state`.
- `GET /api/threads/:thread_id/agent/stream` should be live-only by default and only do bounded replay when the client explicitly resumes from a valid cursor.
- If bounded resume is impossible, the server should explicitly require resync instead of silently falling back.

## Hypotheses
- The simplest robust fix is to move agent-stream state and bounded replay into a dedicated per-thread runtime manager rather than stretching the generic SSE bus further.
- The runtime snapshot and the resume window should share one server-owned cursor space so `/agent/state` and `/agent/stream?after=<cursor>` obey a single invariant.
- The reference web thread route should keep an always-on stream attached across completed turns, using `/agent/state` for bootstrap and explicit resync handling instead of closing the stream on every `final`.

## Proposed Fix
- Add a dedicated runtime manager for agent threads that owns:
  - best-effort in-flight snapshots
  - opaque monotonic stream cursors
  - a bounded replay window with cursor checkpoints
  - live listener attachment with explicit `resync_required`
- Add `GET /api/threads/:thread_id/agent/state`.
- Change `GET /api/threads/:thread_id/agent/stream` to:
  - treat no-cursor attaches as live-only
  - honor bounded replay for `after=<cursor>` or compatible resume carriers
  - emit explicit `agent.resync_required` when resume cannot be honored
- Update the reference web thread view to:
  - load `/messages` and `/agent/state` together
  - render pending tool / draft assistant UI from `/agent/state`
  - attach the agent stream with `after=<state.stream_cursor>`
  - keep the stream open across `final`
  - recover from `agent.resync_required` by refetching `/messages` plus `/agent/state`

## Spec Files Affected
- `bud.spec.md`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/lib/lib.spec.md`
- `docs/proto.md`
