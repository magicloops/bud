# Phase 4: Live-Only Terminal Stream And Durable Resume

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Make terminal stream semantics explicit and durable:

- no cursor means live-only
- explicit cursor means catch up from durable output after that byte offset

and remove overlapping replay responsibilities from the normal browser reconnect path.

## Scope

### Terminal Stream Contract

Evolve:

- `GET /api/threads/:thread_id/terminal/stream`

to support:

- `GET /api/threads/:thread_id/terminal/stream?after_offset=<n>`

Semantics:

#### No `after_offset`

- live-only attach
- no buffered historical `terminal.output` replay

#### With `after_offset`

- replay only durable output strictly after that byte offset
- then continue live

### Durable Replay Source

Use the durable output store keyed by `(session_id, byte_offset)` for catch-up behavior rather than relying on generic in-memory event-buffer replay.

This should be implemented terminal-specifically. Do not silently change generic SSE behavior for every route.

### Reference Web Resume

Update the reference web thread route/controller so it:

- tracks `last_rendered_byte_offset`
- reconnects the stream with `after_offset=<last_rendered_byte_offset>`
- refetches `terminal/state` when session identity changes or durable catch-up cannot be honored cleanly

### `/terminal/history` Reclassification

Reclassify `/terminal/history` as:

- explicit history/scrollback access
- not normal reconnect bootstrap
- not the primary source for live catch-up

## Deliverables

- terminal stream offset-based attach semantics
- terminal-specific durable catch-up behavior
- reference web offset-based resume
- `/terminal/history` reclassified in code/docs/comments

## Expected Files

- `service/src/routes/threads.ts`
- `service/src/runtime/event-bus.ts` if touched, but only in a terminal-specific way
- `service/src/runtime/terminal-session-manager.ts`
- `web/src/routes/$budId/$threadId.tsx`
- browser controller modules added in earlier phases

## Success Criteria

- [ ] No-cursor terminal-stream attach is live-only.
- [ ] `after_offset` catch-up replays only output strictly after the requested byte offset.
- [ ] Catch-up uses durable output semantics rather than replay-all in-memory buffering.
- [ ] The reference web terminal resumes using `last_rendered_byte_offset`.
- [ ] Open/reconnect no longer uses overlapping replay from both SSE buffering and `/terminal/history`.

## Risks And Notes

- Session replacement/closure needs explicit handling. If the tracked session changes, the browser should refetch `terminal/state` rather than pretending offset resume still applies.
- Keep `terminal.status`, `terminal.ready`, and online/offline events coherent during the attach/resume change.

