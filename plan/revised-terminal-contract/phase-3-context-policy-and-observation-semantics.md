# Phase 3: Context Policy And Observation Semantics

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Tighten the context and follow-up rules so the new tool contract behaves predictably in shell, REPL, and TUI contexts.

By the end of this phase:

- `terminal.exec` is enforced as a shell-only action
- interactive program launches and exits still update context correctly
- `terminal.observe` becomes the explicit follow-up path for TUI work
- result payloads include enough context and intent for the model to choose the right next tool

## Current Problem

Bud currently relies on a mix of:

- `pendingCommands`
- known-program lookup
- readiness hints
- context sync snapshots

Those are already useful, but they were built around the old `terminal.run` semantics. After the contract cutover, the context rules need to match the new tool boundaries rather than implicitly guessing what the model meant.

## Scope

### In Scope

- shell-only gating for `terminal.exec`
- REPL/TUI launch tracking for `terminal.send`
- post-tool context refresh
- observation wait semantics
- follow-up hints or `definitive` markers in results
- web tool-display updates if the new distinctions should be visible to developers

### Out Of Scope

- full redesign of context sync
- generic browser terminal UX changes

## Contract Direction

### Shell gating

If the current context is not shell:

- `terminal.exec` should fail explicitly
- the error/result should explain that the terminal is currently in `repl`, `tui`, `pager`, or other non-shell context
- the payload should include `context_after` or a clear hint toward `terminal.send` / `terminal.observe`

### Launching interactive programs

Starting a REPL or TUI from the shell should use `terminal.send`, not `terminal.exec`.

Examples:

- `python`
- `node`
- `claude`
- `psql`
- `vim`
- `less`

The service and runtime should preserve that transition in context tracking.

### Explicit observation

`terminal.observe` should cover:

- rendered screen inspection
- optional waiting before capture
- explicit transcript/tail retrieval if still needed

Do not let `terminal.send` quietly start returning screenshots just because an interactive program is active.

## Implementation Tasks

### Task 1: Rework context transitions around the new tools

Adjust `service/src/runtime/terminal-session-manager.ts` and any helpers so:

- `terminal.exec` never establishes REPL context
- `terminal.send` can establish or maintain REPL/TUI context
- known interactive launches still set `pendingCommands` or its replacement
- shell-return signals still clear the interactive context

### Task 2: Refresh context snapshots after the right operations

Review `service/src/terminal/context-sync-service.ts` integration points.

At minimum:

- refresh after successful `terminal.exec`
- refresh after `terminal.send` when it likely changed the mode
- keep observe/capture snapshots aligned with what the agent is seeing

The main goal is to reduce stale context at the start of the next turn.

### Task 3: Add explicit shell-context failure behavior for `terminal.exec`

Do not silently coerce.

Recommended failure payload:

```json
{
  "kind": "command_result",
  "definitive": false,
  "error": "not_in_shell_context",
  "context_after": {
    "mode": "repl",
    "program": "claude"
  },
  "follow_up_hint": "Use terminal.send or terminal.observe in the current context."
}
```

### Task 4: Formalize wait semantics

Normalize the meaning of:

- `shell_ready`
- `screen_stable`
- `none`

Recommended mapping:

- `terminal.exec` -> always shell-style readiness
- `terminal.send` -> caller chooses or defaults based on context/program
- `terminal.observe` -> can wait before capture but remains observation-only

### Task 5: Decide how much guidance belongs in result payloads

Prompt text alone should not carry the whole policy.

Add structured hints where they materially help:

- `definitive`
- `context_after`
- `follow_up_hint`

This should make "observe after exec" a data-driven exception rather than a fragile instruction in the system prompt.

### Task 6: Update developer-visible tool rendering if needed

If web tool cards or summaries display raw tool names:

- update them for `terminal.exec`, `terminal.send`, and `terminal.observe`
- make the distinction visible enough that developers can inspect agent behavior without reading raw JSON

Likely touch points:

- `web/src/components/message-renderers/tools/`
- `web/src/components/workbench/`

## Validation Checklist

- [ ] `terminal.exec` fails explicitly outside shell context
- [ ] launching a known REPL/TUI via `terminal.send` updates context tracking
- [ ] returning to shell clears the interactive context
- [ ] `terminal.observe` is the explicit mechanism for screen inspection
- [ ] interactive workflows still work without `terminal.send` returning pseudo-command output
- [ ] result payloads include enough structured information to guide the next tool choice
- [ ] developer-visible tool rendering stays understandable after the rename

## Exit Criteria

This phase is done when the new tool contract is enforced by runtime behavior and result payloads, not just by prompt wording, across shell and interactive contexts.
