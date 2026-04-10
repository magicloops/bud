# Design: Reconsidering `terminal.exec` Vs `terminal.send`

**Status:** Draft
**Created:** 2026-04-09
**Related:**
- [`design/terminal-command-and-interaction-contract.md`](./terminal-command-and-interaction-contract.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)

---

## Summary

The original split between `terminal.exec` and `terminal.send` was directionally correct:

- `terminal.exec` for shell commands
- `terminal.send` for interactive input
- `terminal.observe` for explicit inspection

However, the current implementation has now exposed a structural problem:

- `terminal.exec` is not actually authoritative enough to justify being a distinct first-class agent tool
- but it is restrictive enough to fail on common shell-authoring tasks such as heredocs and multiline command construction

The practical result is that `terminal.exec` is currently the worst of both worlds:

- more limited than `terminal.send`
- but not materially more trustworthy

This document revisits whether `terminal.exec` should remain part of the model-facing contract at all.

## Context

The latest failure case was a natural shell-authoring request:

- create a directory
- create a Python file
- write a short script with multiline content

The model chose `terminal.exec` and emitted a heredoc-style shell command. That failed immediately because the current `terminal.exec` contract rejects commands containing newlines.

At the same time:

- asking the agent to use `terminal.send` instead worked
- `terminal.send` already uses the same tmux transport path as `terminal.exec`
- `terminal.exec` still does not return a real shell exit code

That means the present distinction between the two tools is mostly contract semantics and policy, not transport capability.

## What The Current Code Actually Means

### `terminal.exec`

Today `terminal.exec`:

- only accepts a single string without `\n` or `\r`
- sends that string into the live tmux shell and presses Enter
- waits for shell quiescence / readiness
- returns shell output and readiness
- does **not** return a real exit code

So `terminal.exec` is currently:

- shell-oriented
- newline-restricted
- output-oriented
- but still not fully authoritative

### `terminal.send`

Today `terminal.send`:

- accepts arbitrary text, including multiline text
- supports `submit: true` and special keys
- uses the same tmux send path
- returns post-send delta and readiness
- can already drive shell, REPL, or TUI interactions

So `terminal.send` is currently:

- more expressive
- more flexible
- better aligned with how tmux actually behaves

### Practical overlap

In the current tmux-backed architecture, both tools ultimately do some version of:

1. send text into the foreground terminal program
2. optionally press Enter
3. observe what happened next

That means the distinction is not "different transport layers." It is "different result shapes and different policy assumptions."

## Core Problem

The question is no longer "can we conceptually distinguish shell commands from interactive input?"

We can.

The real question is:

> does the current `terminal.exec` implementation deliver enough unique value to justify a separate agent-visible tool?

Right now, the answer appears to be "not really."

## Goals

- Reduce avoidable agent failures on normal shell-authoring tasks.
- Preserve the working `terminal.send` / `terminal.observe` interaction model.
- Avoid pretending that `terminal.exec` is authoritative if it still lacks real shell-result semantics.
- Keep the model contract simple enough that it makes the right choice reliably.

## Non-Goals

- Designing a perfect shell-command execution abstraction for every shell and prompt configuration.
- Reintroducing the old overloaded `terminal.run` API.
- Removing the ability to do explicit shell-vs-interactive reasoning in the service.

## Why `terminal.exec` Looked Valuable Initially

The original rationale for `terminal.exec` was strong:

- simple shell commands should not require the model to encode `\n`
- shell execution should feel distinct from TUI interaction
- shell command results should be more authoritative than screen captures
- the service should gate shell commands to shell context

Those are still good goals.

The issue is that the current implementation only achieves some of them.

## Current Pros Of Keeping `terminal.exec`

### 1. Cleaner intent separation

`terminal.exec` gives the model a clear "this is a shell command" tool, which is easier to reason about than treating shell as just another interactive mode.

### 2. Shell-only guardrails

The service can reject `terminal.exec` when the terminal is in a REPL or TUI, which prevents obviously wrong actions like sending `ls` into Claude Code or Python.

### 3. Output-oriented result

For commands like:

- `pwd`
- `ls`
- `git status`
- `cat README.md`

an output-oriented result is often more useful than a delta-oriented result.

### 4. Future upside

If Bud ever returns a real `exit_code`, `terminal.exec` could become a genuinely authoritative shell-command tool.

## Current Cons Of Keeping `terminal.exec`

### 1. No real exit status

This is the biggest conceptual weakness.

Today `terminal.exec` does not return `0`, `1`, or any other real command exit code. It only returns:

- output
- truncation
- readiness
- transport/runtime error

That makes it meaningfully less authoritative than its name suggests.

### 2. Hard newline restriction breaks normal shell authoring

The current contract rejects any command containing newlines.

That blocks common and natural shell patterns:

- heredocs
- `cat <<EOF`
- inline script creation
- loops written over multiple lines
- shell function definitions
- `python <<'PY'`

These are not exotic edge cases. They are normal agent-generated shell behavior for file creation and small script authoring.

### 3. It duplicates `terminal.send` transport

The actual dispatch path is still tmux input submission. So the distinction is not backed by a fundamentally different execution mechanism.

### 4. It increases model choice complexity

The model must choose between:

- "shell command"
- "interactive input"

even though many real tasks blend both concepts.

That creates avoidable failures like:

- choosing `terminal.exec` for a heredoc
- choosing `terminal.send` for a simple shell command
- switching tools based on subtle prompt wording rather than durable semantics

### 5. It overpromises on authority

The name `exec` suggests something closer to:

- run a command
- capture its exit status
- return its output definitively

But the current implementation is closer to:

- send one command line into the live shell
- wait for apparent shell readiness
- infer completion from prompt/quiescence

That is useful, but it is not truly command-execution authority.

## Option 1: Keep `terminal.exec` As-Is And Improve Prompting

### Shape

- Keep `terminal.exec`
- Teach the model stricter rules:
  - only use it for simple single-line shell commands
  - use `terminal.send` for multiline shell authoring
  - avoid heredocs with `terminal.exec`

### Pros

- minimal implementation work
- preserves the shell-only tool split
- keeps simple commands ergonomic

### Cons

- pushes subtle shell-authoring rules back onto the model
- keeps the current authority gap
- does not solve the conceptual mismatch between tool name and actual guarantees
- still likely to fail on natural model behavior

### Assessment

This is the cheapest option, but probably not the right one.

It treats the symptom as a prompting problem when the underlying issue is the tool boundary itself.

## Option 2: Invest In Making `terminal.exec` Truly Authoritative

### Shape

- keep `terminal.exec`
- add real exit code reporting
- support broader shell-command forms, or explicitly support multiline shell programs
- preserve `terminal.send` for REPL/TUI interaction

### Pros

- strongest long-term tool split
- `exec` would genuinely earn its name
- cleanest shell-vs-interactive contract if implemented well

### Cons

- much harder than it looks in a live tmux shell
- likely requires shell wrappers, sentinels, or prompt-sensitive hacks
- can pollute shell history/output or behave differently across shells
- adds engineering complexity before we have strong evidence that the distinction is worth it

### Assessment

This could be worth doing eventually, but only if we decide that a truly authoritative shell tool is strategically important.

Right now it looks like too much complexity for too little practical gain.

## Option 3: Remove `terminal.exec` From The Model-Facing Contract

### Shape

- remove `terminal.exec` from the agent toolset
- use `terminal.send` for shell commands as well as REPL/TUI input
- keep `terminal.observe` for explicit inspection
- let service-side context still distinguish shell vs REPL/TUI for guidance and safety

### Pros

- simplest model contract
- removes the newline/heredoc failure class entirely
- aligns with the actual tmux transport reality
- stops implying authority we do not currently have
- lets one tool handle:
  - simple shell commands
  - multiline shell authoring
  - REPL/TUI input

### Cons

- loses the clean "command result" abstraction
- shell commands now come back through delta/readiness semantics unless `terminal.send` is enhanced further
- weaker distinction between:
  - "run this shell command"
  - "type this into the current interactive program"
- may require some follow-up contract cleanup so shell-command sends remain ergonomic

### Assessment

This is the strongest near-term simplification.

It matches the current implementation reality better than the current split does.

## Option 4: Soft-Deprecate `terminal.exec`

### Shape

- remove `terminal.exec` from the model prompt/toolset
- keep the Bud/service implementation internally for now
- use `terminal.send` as the only model-facing input primitive
- revisit `terminal.exec` later if we build a truly authoritative path

### Pros

- same model simplification benefits as full removal
- lower-risk rollout
- preserves optional internal experimentation
- avoids immediate protocol churn

### Cons

- leaves unused or semi-unused code paths around
- can create temporary conceptual duplication in the codebase
- requires discipline to avoid drift between "hidden" and "active" tool paths

### Assessment

This is the safest practical direction if we want to stop exposing `terminal.exec` to the model without immediately ripping out the implementation.

## Recommendation

### Short version

Deprecate `terminal.exec` as a **model-facing** tool for now, and move to:

- `terminal.send` for all terminal input, including shell commands
- `terminal.observe` for explicit inspection

Keep the current `terminal.exec` implementation only as an internal or transitional path until we decide whether a truly authoritative shell tool is worth building.

### Why

Because the current `terminal.exec` does not presently justify its complexity:

- it has stricter input limits than `terminal.send`
- it uses the same tmux submission model underneath
- it still lacks a real exit code
- it causes natural failures on common shell-authoring tasks

That means it is currently better described as:

- a restricted shell-oriented convenience wrapper

not:

- a genuinely authoritative execution primitive

### Strategic principle

`terminal.exec` should only exist as a first-class model tool if it provides meaningfully stronger guarantees than `terminal.send`.

At the moment, it does not.

## Recommended Future Shape

### Near term

Use a two-input model:

- `terminal.send`
- `terminal.observe`

with service-side guidance that still tells the model:

- if the terminal is at a shell prompt, sending a shell command with `submit: true` is normal
- if the terminal is in a REPL/TUI, send natural interactive input instead

### Medium term

If we later decide we need a true shell-command tool, reintroduce `terminal.exec` only after it can provide at least:

- real `exit_code`
- trustworthy command-completion semantics
- a clear reason to exist separately from `terminal.send`

Until then, simpler is better.

## Migration Implications If We Follow This Direction

### Agent contract

- stop advertising `terminal.exec` in the model-facing tool list
- update prompt guidance so shell commands use `terminal.send`
- keep `terminal.observe` explicit

### Runtime semantics

- preserve shell-vs-REPL/TUI context awareness
- ensure shell-command sends remain easy to interpret
- decide whether shell-context `terminal.send` should prefer `wait_for: "shell_ready"` by default or remain explicit

### UI and docs

- update developer-visible tool rendering to stop treating `exec` as a normal agent path
- update protocol/spec/design docs to reflect the simplified tool surface

## Best Current Conclusion

The original split was conceptually sound, but the current implementation has made the tradeoff clearer:

- `terminal.send` is flexible and works
- `terminal.observe` handles explicit inspection
- `terminal.exec` is currently too restrictive to be convenient and too weakly authoritative to be essential

So the best current design direction is:

1. stop relying on `terminal.exec` as a normal model-facing tool
2. use `terminal.send` plus `terminal.observe` as the primary contract
3. only bring back a first-class `terminal.exec` if we later build a version that truly earns the distinction

