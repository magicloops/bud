# Phase 4: Tests, Docs, And Developer Cutover

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Finalize the breaking terminal-contract cutover with tests, protocol/spec updates, and clear developer guidance for using fresh threads/local data after the change.

By the end of this phase:

- tests cover the new contract at the service and Bud layers
- protocol/spec docs describe the shipped contract
- developer-facing docs explain the breaking cutover and local expectations
- manual validation confirms both shell and TUI workflows still work

## Current Problem

Without a finalization pass, the code and docs will drift:

- the service and Bud may use new tool names while specs still mention `terminal.run`
- developers may inspect old local threads and think the new contract is broken
- UI tool rendering may still refer to removed tool names

This phase is the point where the cutover becomes understandable rather than tribal knowledge.

## Scope

### In Scope

- service test updates
- daemon test additions where practical
- `docs/proto.md`
- touched specs
- developer cutover notes
- manual validation

### Out Of Scope

- compatibility shims
- durable migration of historical local data

## Implementation Tasks

### Task 1: Update service tests

Review and update tests covering:

- agent runtime state
- tool parsing and result recording
- gateway schema validation
- context transitions where tests exist

Add focused coverage for:

- `terminal.exec` shell-only behavior
- `terminal.send` structured arguments
- `terminal.observe` payload shape
- new tool-result persistence metadata

### Task 2: Add targeted Bud tests where realistic

The daemon is currently monolithic, so full integration coverage may be awkward.

Prefer small extracted-unit tests where feasible for:

- structured send-input translation (`text` + `submit` + `keys`)
- exec helper behavior
- wait-mode selection helpers

If the code has to be refactored slightly to make those tests feasible, keep that refactor narrow and in service of the contract.

### Task 3: Update protocol docs

Update `docs/proto.md` to reflect:

- the new exec/send/observe request-response messages
- the continued role of `terminal_output`
- any remaining `terminal_ready` semantics if still present

Use shipped message names and payload fields only.

### Task 4: Update touched specs

Update at minimum:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`

Update web specs too if tool-rendering or developer-facing labels changed.

### Task 5: Document the developer-only cutover

Because there is no compatibility layer, add a small explicit note where appropriate:

- old local threads/tool rows may not replay cleanly
- developers should use new threads or reset local data if debugging the new contract

This can live in:

- this plan's validation notes
- a brief README/spec note if implementation proves it necessary

### Task 6: Run manual validation

Capture results in [validation-checklist.md](./validation-checklist.md) for at least:

- shell exec flow
- REPL/TUI send + observe flow
- explicit observe after low-confidence interactive step
- exec rejection inside a REPL
- browser manual terminal input still working

## Validation Checklist

- [ ] service tests cover the new tool names and payloads
- [ ] Bud tests or helper-level checks cover structured interaction input
- [ ] `docs/proto.md` documents the new contract
- [ ] service and Bud specs no longer describe `terminal.run` / `terminal.capture` as the agent contract
- [ ] developer guidance is explicit that old local history may be stale after the cutover
- [ ] shell and interactive workflows both pass manual validation on a local stack

## Exit Criteria

This phase is done when the breaking contract is fully documented, validated, and understandable to developers working from a fresh local stack.
