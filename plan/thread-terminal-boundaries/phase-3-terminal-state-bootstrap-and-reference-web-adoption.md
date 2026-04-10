# Phase 3: Terminal State Bootstrap And Reference Web Adoption

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Replace raw terminal-history replay as the normal browser bootstrap mechanism with an explicit safe terminal-state route and adopt it in the reference web thread view.

## Scope

### New State Route

Add:

- `GET /api/threads/:thread_id/terminal/state`

First-pass response should include:

- `session_id`
- terminal `state`
- current readiness snapshot if available
- `latest_byte_offset`
- a safe bootstrap snapshot
- `updated_at`

First-pass snapshot expectations:

- safe to write into xterm without provoking protocol replies from historical control traffic
- text-first is acceptable
- exact style/color/cursor fidelity is not required in the first pass

### Backend Bootstrap Source

Use existing terminal/session information plus a safe capture source to build the bootstrap snapshot.

Acceptable first-pass sources:

- rendered tmux capture output
- recent authoritative terminal state already available in the session manager

Not acceptable:

- replaying raw historical output bytes as the primary bootstrap payload

### Reference Web Adoption

Update the reference thread route so terminal open/reconnect does:

1. ensure the session row exists
2. fetch `terminal/state`
3. reset xterm
4. render the safe snapshot
5. attach the live stream using `latest_byte_offset`

The route should stop doing raw `/terminal/history` replay as its normal bootstrap path.

## Deliverables

- `GET /terminal/state`
- service/runtime helper support for bootstrap snapshot generation
- reference web adoption of the new bootstrap flow
- removal of normal open/reconnect dependence on raw `/terminal/history`

## Expected Files

- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/routes/$budId/budId.spec.md`

## Success Criteria

- [ ] `GET /terminal/state` exists and is ownership-aware.
- [ ] The route returns `latest_byte_offset`.
- [ ] The route returns a safe bootstrap snapshot.
- [ ] The reference web thread view uses `terminal/state` on open/reconnect.
- [ ] The reference web thread view no longer uses `/terminal/history` as its normal bootstrap mechanism.
- [ ] Normal bootstrap no longer depends on feeding old raw control bytes back through xterm.

## Risks And Notes

- The first-pass bootstrap may look plainer than the current raw replay path. That is acceptable if it is safe and stable.
- This phase should not yet flip stream attach semantics. It should prepare the client to do so safely in Phase 4.

