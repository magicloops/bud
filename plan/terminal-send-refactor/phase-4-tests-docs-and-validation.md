# Phase 4: Tests, Docs, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Finish the refactor with explicit validation, updated documentation, and enough automated coverage to keep the settled-by-default behavior from regressing.

By the end of this phase:

- the most important Bud/service paths have regression coverage where practical
- protocol docs and specs match shipped behavior
- manual validation covers quick shell, interactive TUI, timeout, and bursty-output cases
- any deferred async-job work is recorded explicitly rather than left implicit

## Context

This refactor changes waiting behavior more than surface area, which makes validation especially important. The product risk is not just broken functionality; it is silently drifting back toward unnecessary send-plus-observe chains or misclassifying busy terminals as settled.

## Scope

### In Scope

- focused automated coverage for the new settle logic where practical
- protocol and spec updates
- manual validation against representative shell, REPL, and TUI flows
- recording explicit follow-up work for anything intentionally left out of scope

### Out Of Scope

- building a full async-job callback system
- broad frontend redesign
- introducing a different terminal backend

## Implementation Tasks

### Task 1: Add automated coverage where practical

Add or extend tests around:

- Bud-side quiescence classification helpers if they are separable enough to test directly
- service-side interpretation of settled vs timeout send results
- observe wait semantics where the runtime contract changed materially

The goal is not exhaustive terminal simulation. The goal is to lock the contract and its most failure-prone branches.

### Task 2: Update docs and specs

Update:

- `docs/proto.md`
- Bud and service specs
- the new plan-folder spec if the shipped behavior diverges from the original planned scope
- the root `bud.spec.md` document index

Make sure the documented defaults match the actual shipped values.

### Task 3: Run the manual validation checklist

Validate at least:

- a quick shell command that should settle in one send
- a TUI or REPL that emits output while thinking and then settles
- a bursty-output case that should not settle on the first brief pause
- an intentionally long-running command that should time out into partial progress
- an input that is ignored or produces no visible delta
- an explicit longer wait via `terminal.observe(wait_for:"settled")`

### Task 4: Record follow-up scope explicitly

If validation reveals remaining needs around:

- multi-minute background jobs
- async callbacks or wake-ups
- tuning beyond the initial quiet-window defaults

record those as explicit follow-up docs rather than quietly expanding this refactor.

## Files Likely Affected

- `docs/proto.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `plan/terminal-send-refactor/terminal-send-refactor.spec.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The refactor ships with only happy-path validation | Medium | High | Keep the manual checklist explicit and include bursty/timeout/unchanged cases |
| Specs or protocol docs drift from actual defaults | Medium | Medium | Update docs in the same phase as final tuning, not before |
| The async-job follow-up remains implicit and causes future scope confusion | Medium | Medium | Write down the deferred work explicitly before closing the phase |

## Exit Criteria

- Reasonable automated coverage exists for the new settle and timeout semantics.
- Protocol docs and specs reflect shipped behavior.
- Manual validation covers shell, TUI, timeout, bursty, and unchanged-result cases.
- Deferred async-job follow-up work is documented explicitly.
