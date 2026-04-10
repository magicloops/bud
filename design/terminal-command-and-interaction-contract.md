# Design: Terminal Command And Interaction Contract

**Status:** Draft
**Created:** 2026-04-08
**Related:**
- [`design/terminal-run-refactor-v2.md`](./terminal-run-refactor-v2.md)
- [`design/terminal-context-sync.md`](./terminal-context-sync.md)
- [`design/agent-terminal-context-awareness.md`](./agent-terminal-context-awareness.md)
- [`design/terminal-run-output-redesign.md`](./terminal-run-output-redesign.md)

---

## Summary

The current `terminal.run` contract is trying to do three different jobs:

1. execute a simple shell command and return its output
2. send arbitrary input to an interactive foreground program
3. stand in for "observe terminal state" when the model does not trust the result

That overload is the root cause of both complaints:

- the model is told to include `\n`, because `terminal.run` is really a "send input to the live terminal" tool
- the model often calls `terminal.capture` immediately after `terminal.run`, because the result shape changes by mode and is not reliably authoritative

The right fix is not to resurrect legacy detached `shell.run` as the main path. The right fix is to split the contract by intent while keeping everything inside the same thread-scoped tmux session.

---

## What The Current Code Actually Does

### 1. `terminal.run` is an input-submission API, not a shell-command API

Current service prompt and tool schema explicitly instruct the model to include `\n` for Enter in `service/src/agent/agent-service.ts`.

Current Bud behavior in `bud/src/main.rs`:

- decodes the `input`
- strips trailing newlines from the text portion
- sends the text with `tmux send-keys -l`
- sends one `Enter` key for each trailing newline

So `pwd\n` is not a bug in the current contract. It is how the existing API says "type `pwd` and press Enter" in a live terminal.

The problem is that the model should not be responsible for knowing that transport detail when the user intent is just "run a shell command".

### 2. `terminal.run` result semantics change by mode

Today the service decides mode heuristically:

- `shell` mode: Bud waits for quiescence and returns log-file output delta
- `repl` mode: Bud waits for screen stability and returns `capture-pane` output

That means the same tool name sometimes returns "command transcript" and sometimes returns "rendered screen". This makes the tool hard for the model to trust.

### 3. `terminal.capture` is still the only explicit observation tool

The model has one clear observation primitive today: `terminal.capture`.

Because `terminal.run` sometimes behaves like execution and sometimes behaves like observation, the model often falls back to an explicit capture even after being told not to.

### 4. Context is service-inferred and still partly heuristic

The service uses:

- `pendingCommands` tracking in `TerminalSessionManager`
- known-program hints from `service/src/terminal/known-programs.ts`
- pre-flight context sync in `service/src/terminal/context-sync-service.ts`

That is useful, but it means `terminal.run` behavior is still coupled to a context inference layer rather than an explicit tool contract.

### 5. The old `shell.run` plumbing is the wrong primary fix

The legacy run path in `RunManager` is a separate execution model. It does not share the thread terminal's exact foreground program, prompt, or interactive state. Bringing it back as the default "simple command" path would reintroduce split state and violate the thread-scoped terminal design.

If we want a shell-command tool, it should still execute inside the thread's persistent terminal session.

---

## Design Principles

1. Hide terminal transport details from the model.
2. Keep one terminal source of truth: the thread-scoped tmux session.
3. Separate execution, interaction, and observation into different tools.
4. Give each tool a stable result shape.
5. Preserve TUI and REPL support without making simple shell commands feel like TUI operations.

---

## Proposed Contract

### Tool 1: `terminal.exec`

Use for shell commands that are expected to run and return control to a shell prompt.

Example:

```json
{ "tool": "terminal.exec", "command": "pwd", "timeout_ms": 10000 }
```

Properties:

- model supplies `command`, not `command + "\n"`
- service validates that current context is `shell`
- service or Bud appends Enter internally
- Bud waits for shell-style readiness
- result is command-oriented, not screen-oriented

Expected result shape:

```json
{
  "kind": "command_result",
  "output": "/Users/adam/bud\n",
  "output_bytes": 17,
  "truncated": false,
  "definitive": true,
  "readiness": { "...": "..." },
  "context_after": { "mode": "shell" }
}
```

`terminal.exec` should be the default for questions like:

- "what directory are we in?"
- "list files"
- "run tests"
- "show git status"

### Tool 2: `terminal.send`

Use for arbitrary terminal interaction, not shell command execution.

Examples:

```json
{ "tool": "terminal.send", "text": "y", "submit": true }
{ "tool": "terminal.send", "keys": ["q"] }
{ "tool": "terminal.send", "text": "Please review src/main.rs", "submit": true, "wait_for": "screen_stable" }
```

Properties:

- works in shell, REPL, TUI, pager, or confirmation contexts
- supports structured input instead of newline encoding
- allows explicit `submit: true` instead of embedding `\n`
- allows explicit special keys
- may wait for readiness, but does not pretend to be a command-result tool

Expected result shape:

```json
{
  "kind": "interaction_ack",
  "submitted": true,
  "readiness": { "...": "..." },
  "context_after": { "...": "..." }
}
```

`terminal.send` is the right tool for:

- Claude Code prompts
- Python / Node / SQL REPL input
- `vim`, `less`, `more`, `top`
- confirmations and single-key actions
- launching an interactive program from the shell

### Tool 3: `terminal.observe`

Use for explicit observation of the terminal state.

Example:

```json
{ "tool": "terminal.observe", "view": "screen", "wait_for": "screen_stable", "timeout_ms": 5000 }
```

Properties:

- explicit replacement direction for the current `terminal.capture` mental model
- can observe rendered screen or recent transcript/tail
- can optionally wait before observing
- remains the expected tool for TUI polling

Expected result shape:

```json
{
  "kind": "observation",
  "view": "screen",
  "output": "...",
  "output_bytes": 4096,
  "truncated": false,
  "readiness": { "...": "..." },
  "context_after": { "...": "..." }
}
```

Keep `terminal.interrupt` as-is.

---

## Important Behavioral Rule

### Starting an interactive program is not `terminal.exec`

Commands like these are context transitions, not normal shell-command completions:

- `claude`
- `python`
- `node`
- `psql`
- `vim`
- `less`

Those should use `terminal.send({ text, submit: true })`, optionally followed by `terminal.observe(...)`.

That keeps `terminal.exec` semantically clean: it is for commands that should come back with a definitive command result.

---

## Why This Fixes The Two Reported Issues

### Issue 1: model appends `\n`

With the split contract:

- `terminal.exec` takes `command`, not raw input
- `terminal.send` takes structured `text` plus `submit`

The model no longer has to encode `\n` just to say "run this command". Enter becomes an implementation detail again.

### Issue 2: model calls `terminal.capture` after `terminal.run`

With the split contract:

- `terminal.exec` returns a definitive command result
- `terminal.send` returns an interaction ack
- `terminal.observe` is the explicit observation tool

Now "observe after interactive input" is normal, but "observe immediately after definitive shell execution" is abnormal and easy to discourage in both prompt guidance and service-side telemetry.

---

## Service Responsibilities

The service should own:

- exposing the new tool contract to the model
- pre-flight context sync before a user turn
- post-tool context refresh after exec/send
- rejecting `terminal.exec` when context is not `shell`
- mapping backward-compatible aliases during migration

The service should stop relying on prompt text alone to prevent bad tool sequencing.

Recommended result metadata additions:

- `kind`
- `definitive`
- `context_after`
- `recommended_next_tool` or `follow_up_hint`

That gives the model structured reasons not to call `observe` after a successful `exec`.

---

## Bud Responsibilities

Bud should continue to own:

- tmux input submission
- special-key submission
- readiness detection
- screen capture
- command-result packaging for shell execution

### Short-term

The service can introduce `terminal.exec` immediately by mapping it to the current `terminal_run` path and internally appending `\n`.

The service can introduce `terminal.send` immediately by mapping it to the current `terminal_input` path.

The service can introduce `terminal.observe` immediately as a thin alias over current `terminal.capture`.

### Medium-term

The wire protocol should match the intent split too:

- `terminal_exec`
- `terminal_input` / `terminal_send`
- `terminal_capture` / `terminal_observe`

That would remove the last mismatch where Bud still exposes `terminal_run` but the model conceptually thinks in terms of command execution.

---

## Backward Compatibility

Keep current tools during migration, but demote them.

Suggested compatibility behavior:

- `terminal.run` becomes an internal compatibility alias
- if it looks like a shell command and current context is `shell`, map to `terminal.exec`
- otherwise map to `terminal.send`
- `terminal.capture` becomes an alias for `terminal.observe`

Do not expose legacy detached `shell.run` to the model as the normal fast path.

---

## Suggested Agent Policy

1. In `shell` context, prefer `terminal.exec`.
2. In `repl`, `tui`, `pager`, or confirmation contexts, prefer `terminal.send`.
3. Use `terminal.observe` for rendered-screen inspection, waiting, or extra scrollback.
4. After a successful `terminal.exec` with `definitive: true`, do not immediately observe.
5. Only observe after exec when:
   - `truncated` is true
   - `definitive` is false
   - readiness confidence is low
   - the user explicitly wants the rendered screen

---

## Rollout Plan

### Phase 1: Service-level contract cleanup

- add `terminal.exec`, `terminal.send`, and `terminal.observe` to the agent harness
- keep current Bud protocol underneath
- update prompt/tool docs so the model no longer uses `\n` for shell commands

### Phase 2: Result-shape cleanup

- add `kind`, `definitive`, and `context_after` to tool results
- instrument how often the model calls observe immediately after exec

### Phase 3: Bud protocol cleanup

- rename/split the Bud request-response tool surface to match the new contract
- keep compatibility shims until old clients are gone

---

## Recommendation

Do not treat the newline as the bug. The newline is a symptom of an overloaded API.

The design direction should be:

- keep execution inside the persistent terminal session
- split command execution from interactive input
- make observation explicit
- move Enter/newline semantics out of the model contract

That preserves TUI compatibility while giving simple shell commands a fast, trustworthy one-call path.
