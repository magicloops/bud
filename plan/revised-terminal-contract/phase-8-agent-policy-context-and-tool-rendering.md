# Phase 8: Agent Policy, Context, And Tool Rendering

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Implemented

---

## Objective

Update the service, context rules, and developer-visible tool surfaces so the agent behaves according to observed post-send state rather than cached context or optimistic summaries.

By the end of this phase:

- observed post-send state outranks inferred state
- the agent chooses between `terminal.send`, `terminal.observe`, and verification using evidence
- developer-visible tool rows make the new send semantics legible

## Current Problem

Even if the runtime starts returning better data, the service can still distort it by:

- preferring cached `pendingCommands` context over fresh observation
- emitting strong follow-up hints based only on inferred mode
- summarizing `terminal.send` as if the program accepted the input

That is how we end up with claims like "Claude Code is actively working on the task" when the pane is still waiting for input.

## Scope

### In Scope

- `AgentService` summary and follow-up-hint logic
- session-context integration after send/observe
- rules for when `terminal.exec` is allowed
- developer-visible tool rendering for the richer send result

### Out Of Scope

- broad web workbench redesign
- redesign of non-terminal tool cards

## Implementation Tasks

### Task 1: Make observed context outrank inferred context

If the send result includes fresh observation, it should be the primary source of truth for:

- whether the program appears active
- whether it is waiting for more input
- whether the send was ambiguous

Pending-command tracking should remain a hint, not a proof source.

### Task 2: Rework next-action hints

Drive hints from result semantics such as:

- `screen_changed`
- `settled`
- `waiting_for_input`
- `may_still_be_processing`
- acceptance status

This should make these paths explicit:

- send again
- observe next
- verify because nothing visible happened

### Task 3: Keep `terminal.exec` shell-only and evidence-based

The follow-up work should not weaken the original shell gating. `terminal.exec` should still fail explicitly outside shell context, with hints that point toward `terminal.send` or `terminal.observe`.

### Task 4: Update developer-visible tool rendering

Tool rows should make the distinction between these states understandable:

- dispatch only
- dispatch plus observed change
- ambiguous send
- settled and waiting for input
- still processing

The goal is to let a developer inspect a thread and understand what happened without reading raw JSON.

### Task 5: Tighten prompt guidance to match the new data

Prompt instructions should be simplified once the result shape is trustworthy. The model should not need long behavioral prose to avoid bad follow-ups if the tool result already says whether to send, observe, or verify.

## Validation Checklist

- [x] observed post-send context overrides cached inference where they disagree
- [x] the agent does not claim progress when the send result is ambiguous
- [x] the agent can chain another `terminal.send` when the UI is visibly settled and waiting
- [x] `terminal.exec` shell gating still holds
- [x] developer-visible tool rendering makes the new send states legible

## Implementation Notes

- `terminal.send` now derives an explicit `state` from acceptance plus readiness, instead of relying on `context_after` alone.
- `context_after.source` now marks whether the post-tool context was observed (`shell` prompt detected) or inferred from pending-command/session tracking.
- `follow_up_hint` now points to `terminal.observe`, another `terminal.send`, or `terminal.exec` based on observed state.
- The tool renderer now exposes `state`, `next_action`, context source, and fast-observation evidence directly in the chat timeline.

## Exit Criteria

This phase is done when the service and UI stop amplifying optimistic send results and the agent's next action is consistently grounded in observed state.
