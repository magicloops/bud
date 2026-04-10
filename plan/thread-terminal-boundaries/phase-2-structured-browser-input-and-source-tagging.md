# Phase 2: Structured Browser Input And Source Tagging

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Move normal browser terminal interaction onto a structured browser-facing send contract and make source tagging explicit end to end.

## Scope

### Browser-Facing Send Route

Add a thread-scoped browser route:

- `POST /api/threads/:thread_id/terminal/send`

First-pass request shape:

```json
{
  "text": "git status",
  "submit": true,
  "keys": []
}
```

Supported first-pass interactions:

- printable text
- Enter / submit
- common navigation/edit keys already modeled by Bud `terminal_send`
- Ctrl+C via the existing interrupt route can stay separate

### Runtime Reuse

Implement the route by reusing the existing `terminal_send` runtime/Bud path rather than inventing a second interactive transport.

The intent is convergence:

- agent interactive input
- browser interactive input

should use the same underlying structured send path where practical.

### Source Taxonomy

Adopt an explicit source taxonomy across browser, service, and daemon paths:

- `human`
- `emulator_protocol`
- `agent`
- `system`

Phase 2 requirements:

- normal browser typing uses `human`
- browser emulator protocol uses `emulator_protocol`
- agent tool calls retain `agent`
- existing system-owned paths retain `system`

### Raw Fallback

Keep a narrow source-tagged raw-bytes fallback for browser cases that the structured route does not cover yet.

This fallback should be:

- explicit
- controller-owned
- source-tagged
- documented as transitional

not the default browser interaction path.

### Audit Logging

Update terminal input logging/recording so:

- `human` traffic remains attributable to the acting user
- `emulator_protocol` is not conflated with human input
- source values are preserved consistently in logs/runtime writes

The existing `terminal_session_input_log.source` column should be reused in this phase.

## Deliverables

- new `POST /terminal/send` route
- controller migration to use structured send for common browser input
- explicit source taxonomy across touched input paths
- raw-fallback policy and code path

## Expected Files

- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `bud/src/main.rs`
- `web/src/routes/$budId/$threadId.tsx`
- new controller/input modules under `web/src/lib/`
- touched specs for service/web/bud terminal behavior

## Success Criteria

- [ ] The reference web client uses `POST /terminal/send` for normal typing/special-key interaction.
- [ ] The browser keeps a source-tagged raw fallback for unsupported cases only.
- [ ] `human` vs `emulator_protocol` is explicit in touched service/runtime logging paths.
- [ ] The backend no longer stamps emulator protocol as human-originated input.
- [ ] Existing common browser input cases still work after the route switch.

## Risks And Notes

- Do not overreach on browser input coverage in this phase. It is acceptable to keep a raw fallback while coverage is tightened.
- Avoid changing agent tool behavior in the same patch set except where reuse of the runtime path is needed.
- If a schema change becomes necessary later to formalize source values, treat that as follow-up work, not a blocker for this phase.

