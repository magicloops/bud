# Phase 5: Transport Parity And Input Delivery

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Deprecated on 2026-04-09 after successful Claude Code send validation

---

## Objective

This phase captured the transport-parity hypothesis that emerged after an early Claude Code failure. It remains as historical record and fallback investigation guidance, but it is no longer the active starting phase for follow-up work.

The latest validation on 2026-04-09 showed that `terminal.send` can successfully deliver a prompt into an already-open Claude Code session. That shifts the active focus away from transport parity and toward post-send evidence, wait semantics, and agent interpretation.

If transport concerns resurface, this phase provides the playbook to revisit them.

Historical objective:

- we know whether the Claude Code failure is transport, timing, pane-targeting, or only post-send interpretation
- the current `terminal.send` path is demonstrably equivalent to the old path for "text + Enter" into TUIs
- the system has enough debug instrumentation to prove what was sent and what appeared in the pane

## Current Problem

The strongest observed symptom was not merely "the screen stayed stable." It was:

- `terminal.send` claimed success
- Claude Code remained at an idle prompt
- the typed prompt text did not visibly appear in the TUI

That indicated a possible transport regression. Even though the old and new code paths looked similar on paper, parity was treated as an open question until a later Claude Code validation showed successful prompt delivery.

## Scope

### In Scope

- Bud-side tmux dispatch behavior for `text`, `submit`, and `keys`
- dispatch ordering and timing for literal text versus Enter
- pane/session targeting
- debug-gated logging and capture instrumentation needed to prove parity
- service-side request correlation if needed for parity debugging

### Out Of Scope

- final agent summary wording
- final wait-semantic redesign
- final docs/spec polish

## Implementation Tasks

### Task 1: Build an old-vs-new parity matrix

Use the old `terminal_run` / `terminal_input` behavior as the reference point for:

- one-line natural-language prompt + Enter
- one-line shell-like text sent into a TUI
- multi-line text
- special-key follow-up after text

The goal is to document where behavior is identical and where it diverges.

### Task 2: Add debug-gated dispatch instrumentation

At minimum, log:

- the exact tmux helper path taken
- whether literal text was dispatched
- when Enter was dispatched relative to text
- the target session or pane
- short post-dispatch captures at approximately `0ms`, `50ms`, and `200ms`

This logging should be gated so it is useful for debugging without becoming the normal runtime surface.

### Task 3: Audit input encoding and segmentation

Verify that the new path matches the old behavior for:

- newline normalization
- splitting text versus Enter presses
- ordering of literal text and special keys
- punctuation-heavy natural-language prompts
- longer prompt strings that exercise tmux literal-send behavior

### Task 4: Audit pane targeting and focus assumptions

The send path should confirm it is targeting the expected tmux session and pane. If the newer path implicitly changed targeting assumptions, fix that before changing higher-level semantics.

### Task 5: Fix any parity gap and centralize the send helper

If a regression is found:

- fix it in the Bud send helper layer first
- avoid patching around it in the service or agent prompt
- document the invariant that `submitted: true` requires a successful transport dispatch, but not necessarily visible acceptance

### Task 6: Record transport invariants for later phases

At the end of this phase, the team should have a short set of invariants that later phases can rely on, for example:

- literal text dispatch happens before Enter
- prompt text is visible in Claude Code on the happy path
- the target pane is stable and correct

## Validation Checklist

- [ ] A Claude Code prompt visibly appears in the pane after `terminal.send`
- [ ] A simple Python REPL input visibly appears in the pane after `terminal.send`
- [ ] Text dispatch happens before Enter for the common "text + submit" path
- [ ] The targeted tmux session/pane is the expected one
- [ ] Debug traces are sufficient to explain a failed send without relying on guesswork

## Exit Criteria

This phase is deprecated rather than active. Reopen it only if later evidence suggests that text delivery into a TUI is failing again and higher-level semantic fixes are insufficient to explain the behavior.
