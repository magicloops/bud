# Phase 9: Tests, Docs, And Validation Follow-Up

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Draft

---

## Objective

Finish the stabilization work with tests, documentation, and a validation pass that proves the revised contract now works for both shell and interactive workflows.

By the end of this phase:

- automated coverage exists for the new send/observe semantics where practical
- protocol and spec docs reflect the stabilized contract
- developers can understand both the initial cutover and the follow-up fixes from the repo docs alone

## Current Problem

Without a final pass, the code may improve while the documentation still only describes the first cutover. That would make the follow-up behavior hard to understand and easy to regress.

## Scope

### In Scope

- service tests
- Bud helper-level tests where feasible
- `docs/proto.md`
- touched specs
- follow-up validation notes
- developer guidance for interpreting the richer send result

### Out Of Scope

- compatibility support for the removed old tools
- non-terminal documentation unrelated to this stabilization work

## Implementation Tasks

### Task 1: Add or update service tests

Cover at least:

- richer `terminal.send` result parsing and persistence
- ambiguous send versus observed-success handling
- next-action hint behavior
- timeout and late-result handling where service behavior changed

### Task 2: Add Bud helper-level tests where realistic

Prefer focused tests around:

- text-plus-submit dispatch helpers
- baseline fingerprint helpers
- `changed` / `settled` wait classification helpers

If testability requires small refactors, keep them narrow and motivated by the runtime contract.

### Task 3: Update protocol documentation

Document:

- the richer `terminal_send` request fields
- the richer `terminal_send_result` shape
- the stabilized `terminal_observe` wait semantics

### Task 4: Update touched specs

At minimum:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`
- `plan/revised-terminal-contract/revised-terminal-contract.spec.md`

### Task 5: Complete the follow-up validation checklist

Run through the scenarios in [validation-checklist-follow-up.md](./validation-checklist-follow-up.md) against a fresh local stack and capture any remaining gaps.

## Validation Checklist

- [ ] service tests cover the new send-result semantics
- [ ] Bud helper-level checks cover the new wait/capture behavior where practical
- [ ] `docs/proto.md` reflects the stabilized send/observe contract
- [ ] touched specs describe both the original cutover and the follow-up stabilization accurately
- [ ] manual validation passes for Claude Code, at least one REPL, and normal shell exec flows

## Exit Criteria

This phase is done when the stabilized revised terminal contract is tested, documented, and understandable without relying on chat history or the debug doc alone.
