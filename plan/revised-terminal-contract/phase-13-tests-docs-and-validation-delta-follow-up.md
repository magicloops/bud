# Phase 13: Tests, Docs, And Validation For Delta Follow-Up

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Draft

---

## Objective

Finish the delta-observation follow-up with tests, docs, and validation that prove the new minimal delta-first contract works across `terminal.send` and `terminal.observe`.

By the end of this phase:

- automated coverage exists for delta extraction and payload shaping where practical
- protocol/spec/docs describe delta-first behavior and explicit observe modes
- manual validation covers both append-heavy and repaint-heavy interactive workflows

## Current Problem

Without a final pass, the repo will contain:

- the original cutover plan
- the first stabilization plan
- the delta-first design

but not one consistent tested/documented record of the shipped behavior.

## Scope

### In Scope

- Bud helper-level delta tests where feasible
- service tests for delta payload shaping and delivered-baseline tracking
- protocol docs for delta-first send/observe behavior
- spec updates
- manual validation against real TUIs, REPLs, and shell flows

### Out Of Scope

- unrelated terminal UX changes
- compatibility restoration for removed old tools

## Implementation Tasks

### Task 1: Add or update Bud helper tests

Cover at least:

- additive delta extraction for append-like changes
- changed-window extraction for bounded rewrites
- repaint fallback to bounded current-tail excerpt
- explicit observe mode routing

### Task 2: Add or update service tests

Cover at least:

- minimal model-facing send payload shaping
- default observe delta shaping
- delivered-baseline tracking across send and observe
- explicit `screen` / `history` observe behavior

### Task 3: Update protocol documentation

Document:

- delta-first `terminal.send` results
- delta-first default `terminal.observe`
- explicit `screen` / `history` observe modes
- model-facing payload expectations versus internal-only metadata

### Task 4: Update touched specs

At minimum:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `plan/revised-terminal-contract/revised-terminal-contract.spec.md`
- `bud.spec.md` if the top-level document catalog changes

### Task 5: Complete the updated validation checklist

Run the manual scenarios in [validation-checklist-follow-up.md](./validation-checklist-follow-up.md) after the new delta-first phases land.

## Validation Checklist

- [ ] Bud helper tests cover delta extraction and fallback behavior where practical
- [ ] service tests cover minimal payload shaping and delivered-baseline tracking
- [ ] `docs/proto.md` reflects the delta-first send/observe contract
- [ ] touched specs describe the delta-first follow-up accurately
- [ ] manual validation passes for Claude Code, at least one REPL, a repaint-heavy wait scenario, and normal shell exec flows

## Exit Criteria

This phase is done when the delta-first follow-up is tested, documented, and understandable without relying on the chat transcript or the design/debug docs alone.
