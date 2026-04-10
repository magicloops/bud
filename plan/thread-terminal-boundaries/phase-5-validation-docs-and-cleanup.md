# Phase 5: Validation, Docs, And Cleanup

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Finish the terminal-boundary work with tests, docs, spec updates, validation notes, and compatibility cleanup so the new contract is stable and documented.

## Scope

### Tests

Add or update focused coverage for:

- browser/controller classification logic where practical
- service route behavior for:
  - `terminal/send`
  - `terminal/state`
  - `terminal/stream?after_offset=...`
- audit/source propagation for `human` vs `emulator_protocol`
- live-only attach vs explicit offset resume semantics

### Docs And Specs

Update:

- `docs/proto.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

### Cleanup

By the end of this phase:

- the reference web client should no longer use `/terminal/input` as its normal path
- the reference web client should no longer use `/terminal/history` as its normal bootstrap path
- compatibility/fallback code paths should be clearly commented and minimized

### Validation Notes

Complete the manual checklist in [validation-checklist.md](./validation-checklist.md) and record any intentionally deferred edge cases.

## Success Criteria

- [ ] Protocol/docs/specs all describe the same terminal-boundary contract.
- [ ] The reference web client uses the new open/reconnect/input model end to end.
- [ ] The validated scenarios show no recurrence of the `1;2c` restore/replay bug class.
- [ ] Fallback paths are explicit and no longer masquerade as the primary architecture.

## Risks And Notes

- This phase should not leave a half-updated doc set behind. If code lands earlier, follow with docs/specs immediately.
- If any coverage gaps remain for IME/Alt/Meta/browser-specific keys, document them clearly rather than implying full parity.

