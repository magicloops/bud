# research

Current-state research notes for codebase investigations that are not yet implementation plans, debug repro notes, or design proposals.

## Purpose

This folder captures focused analysis of existing behavior, known tradeoffs, and candidate fix directions before the work is promoted into `plan/`, `debug/`, or `design/`.

## Files

### `terminal-observation-long-waits.md`

Research note on the Bud daemon and service-side `terminal.send` / `terminal.observe` wait path, covering output quiescence, the former 30-second default timeout budgets, premature settled readiness, post-dispatch quiescence timing, and long-running TUIs such as Codex and Claude Code. Promoted into [../plan/improve-observe/implementation-spec.md](../plan/improve-observe/implementation-spec.md) and updated with the Phase 1-4 implementation outcome.

## Dependencies

- [../bud.spec.md](../bud.spec.md) - root architecture and documentation catalog
- [../bud/bud.spec.md](../bud/bud.spec.md) - daemon subsystem overview
- [../service/src/runtime/terminal/terminal.spec.md](../service/src/runtime/terminal/terminal.spec.md) - service terminal dispatcher ownership
- [../service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md) - agent tool contract ownership

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
