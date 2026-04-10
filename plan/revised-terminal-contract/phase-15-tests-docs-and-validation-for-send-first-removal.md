# Phase 15: Tests, Docs, And Validation For Send-First Removal

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Planned

---

## Objective

Finalize the removal of `terminal.exec` with the tests, documentation, and manual validation needed to make the send-first contract understandable and trustworthy.

By the end of this phase:

- automated coverage exists for the send-first agent/runtime/protocol surfaces where practical
- protocol/spec/docs no longer describe `terminal.exec` as active
- manual validation proves the new send-first model works for both shell and interactive use

## Scope

### In Scope

- tests affected by `terminal.exec` removal
- protocol/docs/spec updates for the send-first contract
- manual validation of shell commands through `terminal.send`
- manual validation that longer-running operations still escalate to `terminal.observe` appropriately

### Out Of Scope

- adding a replacement authoritative shell primitive
- unrelated terminal UX changes

## Implementation Tasks

### Task 1: Update automated coverage

Cover at least:

- shell-command sends through the agent/runtime contract
- removal of `terminal.exec` parsing/dispatch paths
- tool rendering and payload behavior after `terminal.exec` removal
- protocol validation that rejects or no longer accepts `terminal_exec`

### Task 2: Update protocol and design docs

Document:

- send-first model-facing contract
- `terminal.observe` as the explicit secondary hatch
- removal of `terminal_exec` from the active protocol
- historical note that `terminal.exec` was removed rather than deprecated because the project is still developer-only

### Task 3: Update touched specs and plan docs

At minimum:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`
- `plan/revised-terminal-contract/revised-terminal-contract.spec.md`

### Task 4: Complete the send-first validation checklist

Run the updated validation checklist after Phase 14 lands.

## Validation Checklist

- [ ] `terminal.exec` no longer appears in the model-facing tool list
- [ ] `terminal_exec` / `terminal_exec_result` are removed from the active protocol docs
- [ ] simple shell commands such as `pwd` and `ls` work through `terminal.send`
- [ ] multiline shell authoring works through `terminal.send`
- [ ] longer-running shell commands still steer the agent toward `terminal.observe` when needed
- [ ] REPL/TUI flows still work after the send-first simplification
- [ ] touched specs and plans describe the send-first contract accurately

## Exit Criteria

This phase is done when the repo documents and validates the send-first contract end to end and no active docs, specs, or tests still assume `terminal.exec` exists.

