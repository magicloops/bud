# Phase 3: Tests, Docs, And Validation

## Goal

Treat the interrupt fix as complete only after the new behavior is exercised across shell, REPL/TUI, and offline/error paths, and the updated contract is documented in the repo specs.

## Task 1: Add Automated Coverage

### Service Tests

- interrupt dispatch failure returns a non-successful tool result
- pending REPL context is not cleared on dispatch alone
- pending REPL context clears once shell return is actually observed
- interrupt request tracking resolves only the matching result
- legacy fallback uses preserved `terminal_ready` payloads rather than generic tail reconstruction

### Bud Tests

Where practical, add focused coverage around the new interrupt-result helper/refactor:

- quiescence-based interrupt flow
- activity-based interrupt flow
- payload construction for `terminal_interrupt_result`

If full Bud integration tests remain impractical in this tranche, document the gap and cover the shared helper logic directly.

## Task 2: Update Protocol And Module Specs

Docs/specs to update in the same implementation tranche:

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

Required doc outcomes:

- interrupt request/result shapes are documented
- legacy rollout behavior is documented if it remains part of the shipped implementation
- service and bud specs no longer describe interrupt as a pure fire-and-listen path

## Task 3: Run Manual Validation

### Shell Flow

- start a long-running shell command
- interrupt it
- confirm shell prompt return is reflected correctly
- confirm interrupt-local output is shown without stale history replay

### REPL Flow

- launch Python or another tracked REPL
- start work that can be interrupted
- interrupt it
- confirm `context_after` remains REPL unless shell was actually observed
- confirm shell return later clears REPL context

### TUI Flow

- launch Claude Code or another tracked TUI/interactive app
- interrupt it
- validate both cases if reproducible locally:
  - app remains running after Ctrl+C
  - app exits back to shell after Ctrl+C

### Failure / Rollout Flow

- simulate `bud_offline` or missing session
- confirm no false success tool result is produced
- if mixed-version fallback is implemented, validate a legacy-bud path that still uses preserved `terminal_ready`

## Release Gate

Do not mark this work complete until:

- automated coverage exists for the service-side correctness fixes
- protocol/spec docs are updated
- manual validation covers shell, REPL/TUI, and failure cases
