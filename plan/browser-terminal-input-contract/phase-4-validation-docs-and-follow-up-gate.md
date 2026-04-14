# Phase 4: Validation, Docs, And Follow-Up Gate

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Finish the browser input hardening work with explicit validation, documentation updates, and a clear go/no-go gate for any future PTY-backed browser attach design.

By the end of this phase:

- the manual validation checklist is complete
- relevant specs/docs reflect the new browser input model
- the unsupported phase-1 limitations are clearly recorded
- we have a clear criterion for whether a future PTY-backed browser transport is actually needed

## Scope

### In Scope

- manual validation
- repo spec/doc updates
- PR summary / rollout notes
- explicit recording of phase-1 limitations
- future-follow-up gate for optional emulator replies / unsupported workflows

### Out Of Scope

- implementing PTY-backed browser attach
- expanding phase-1 support after the validation pass unless a blocking workflow is found

This phase is the end of the current plan. It is not a bridge into an already-approved “next phase” inside this folder.

## Implementation Tasks

### Task 1: Complete manual validation

Run the scenarios in [validation-checklist.md](./validation-checklist.md), with extra attention to:

- the known leaked-byte focus/refocus repros
- shell typing and editing
- raw `Ctrl+C`
- pager usage
- Claude Code watch/interrupt/manual command workflows
- paste behavior in the known Chrome-on-macOS environment

### Task 2: Update specs and docs

Update the relevant specs to reflect that browser terminal input is now:

- human-intent driven
- no longer sourced from `xterm.onData`
- intentionally limited in phase 1

At minimum:

- `web/web.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/routes/routes.spec.md`
- `bud.spec.md`

### Task 3: Record known limitations

Document in the final implementation summary / PR notes:

- no `Alt` / `Meta` terminal forwarding in phase 1
- no IME/composition support in phase 1
- no emulator-originated reply support in phase 1
- current copy/paste validation coverage, especially the known Chrome-on-macOS path

### Task 4: Follow-up gate

At the end of validation, explicitly answer:

- Did any real workflow fail because emulator-originated replies are absent?
- Did any critical workflow fail because `Alt` / `Meta` was not forwarded?
- Did any critical workflow fail because IME/composition is unsupported?

Only if the answer reveals a real blocking workflow should we open a separate PTY-backed browser attach design/plan.

That separate PTY-backed browser attach work corresponds to the **earlier conceptual phase 2**, and is intentionally not planned in this folder yet.

## Suggested Validation Outputs

- completed manual checklist with dated notes
- short summary of supported/unsupported browser interactions
- explicit list of any unsupported combos seen in development logs during manual testing

## Exit Criteria

This phase is done when the browser input hardening work is fully documented, manually validated, and either accepted as sufficient for the escape-hatch scope or escalated into a separate future design track.
