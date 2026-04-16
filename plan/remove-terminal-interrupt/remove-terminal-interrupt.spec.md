# remove-terminal-interrupt

Implementation planning documents for removing the agent-facing `terminal.interrupt` tool while keeping the browser interrupt route as a thin wrapper over the general send path.

## Purpose

This folder turns:

- [../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md](../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md)

into an actionable phased implementation and validation plan.

The plan assumes:

- `terminal.send` is already the primary terminal-input contract
- the browser interrupt menu is still a useful escape hatch and should remain
- the correct tmux-native representation of `Ctrl+C` is `C-c`
- dedicated agent/runtime/protocol interrupt machinery should be removed once the browser route no longer depends on it
- active code, specs, and developer docs should stop presenting `terminal.interrupt` as a supported agent feature
- historical design/debug/review/plan documents may remain as historical record if they are clearly archival

## Files

### `implementation-spec.md`

Parent implementation spec for the interrupt-removal work.

Documents:

- the current redundancy between `terminal.interrupt` and `terminal.send`
- the decision to keep the browser wrapper but remove the agent tool
- phase sequencing
- risks, rollout, and definition of done

### `phase-1-send-key-chords-and-guidance.md`

Prerequisite phase covering:

- tmux-native modifier chord support such as `C-c`
- canonical key-notation guidance for the agent/tool docs

### `phase-2-agent-removal-and-browser-wrapper-cutover.md`

Cutover phase covering:

- removal of `terminal.interrupt` from the agent harness
- browser `/terminal/interrupt` migration onto the shared send-key path

### `phase-3-protocol-cleanup-dead-code-and-validation.md`

Cleanup/finalization phase covering:

- deletion of dedicated interrupt runtime/protocol machinery
- active doc/spec/reference cleanup
- final validation

### `validation-checklist.md`

Companion checklist for the removal plan.

Covers:

- key-chord support
- agent-tool removal
- browser wrapper retention
- protocol/dead-code cleanup
- final active-reference sweep

## Dependencies

- [../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md](../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md) - primary design review and recommendation
- [../fix-interrupt/implementation-spec.md](../fix-interrupt/implementation-spec.md) - nearby interrupt-correctness work that is now historical context for the longer-term removal direction
- [../revised-terminal-contract/implementation-spec-follow-up.md](../revised-terminal-contract/implementation-spec-follow-up.md) - broader send-first contract history
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder intentionally preserves the browser `/terminal/interrupt` endpoint. A later cleanup pass may still choose to rename or remove that HTTP affordance, but that is out of scope for this removal plan.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
