# Phase 2: Runtime And Bud Protocol Cutover

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Cut over the service runtime and Bud daemon so the wire protocol matches the new execution/interaction/observation contract.

By the end of this phase:

- service runtime methods match the new tool surface
- Bud implements separate request types for command execution, interactive input, and observation
- the old `terminal_run` path is removed from the main agent flow
- execution remains thread-scoped and tmux-backed

## Current Problem

The service tool surface and the Bud wire surface currently mirror the same overload:

- `terminal_run` is used for both shell commands and interactive program input
- `terminal_input` is a lower-level fire-and-forget path
- `terminal_capture` is the only explicit observe request

That leaves the model-level contract hostage to Bud's low-level input semantics.

## Scope

### In Scope

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `service/src/ws/gateway.ts`
- `bud/src/main.rs`
- runtime method renames and request/response handlers
- low-level input helpers needed by the new tools

### Out Of Scope

- final docs/spec updates
- browser API redesign for manual typing

## Contract Direction

### Service runtime methods

Add or rename runtime methods so the agent path speaks in intent:

- `execCommand(sessionId, command, options)`
- `sendInteraction(sessionId, interaction, options)`
- `observeTerminal(sessionId, options)`

Keep the existing low-level browser/manual path separate, likely still as `sendInput(...)`.

### Bud wire messages

Break the wire surface along the same boundaries:

- `terminal_exec`
- `terminal_exec_result`
- `terminal_send`
- `terminal_send_result`
- `terminal_observe`
- `terminal_observe_result`

`terminal_output` and `terminal_ready` may remain as auxiliary transport/state signals if still useful, but they should no longer define the main agent command contract.

### Structured interaction input

`terminal_send` should support structured input rather than newline conventions.

Recommended fields:

- `text`
- `submit`
- `keys`
- `wait_for`
- `timeout_ms`

That lets Bud decide how to translate:

- `submit: true` -> `Enter`
- `keys: ["q"]` -> single-key action
- `keys: ["ctrl_c"]` or keep `terminal_interrupt` separate

## Implementation Tasks

### Task 1: Rewrite service-side terminal protocol types

Update `service/src/terminal/types.ts` to reflect the new message family.

Add:

- request/response interfaces for exec/send/observe
- typed wait semantics such as `wait_for: "none" | "shell_ready" | "screen_stable"`
- explicit result payload types for command vs interaction vs observation

Remove `terminal_run` from the main typed tool path.

### Task 2: Rewrite `TerminalSessionManager`

Update `service/src/runtime/terminal-session-manager.ts`:

- replace `runCommand()` with `execCommand()`
- add `sendInteraction()`
- replace or wrap `capturePane()` with `observeTerminal()`
- add pending maps for the new request/response types
- keep low-level browser input methods separate from the agent tool runtime

Do not route `terminal.exec` through the raw `sendInput()` helper.

### Task 3: Rewrite gateway validation and routing

Update `service/src/ws/gateway.ts`:

- zod schemas for new Bud messages
- handler routing for new result message types
- removal of `terminal_run_result` as the primary command-execution result type

If `terminal_ready` remains, ensure it is auxiliary rather than the main result path for agent calls.

### Task 4: Implement Bud-side request handlers

Update `bud/src/main.rs` to add separate handlers:

- `handle_exec()`
- `handle_send()`
- `handle_observe()`

Recommended behavior:

- `terminal_exec`
  - accepts a shell command string
  - submits the command plus Enter internally
  - uses shell/quiescence readiness
  - returns command output delta and readiness

- `terminal_send`
  - accepts structured text/submit/keys
  - submits input without pretending it is a shell command
  - optionally waits according to `wait_for`
  - returns an interaction acknowledgement with readiness

- `terminal_observe`
  - returns explicit screen or transcript data
  - supports waiting before capture when requested

### Task 5: Reuse and refactor low-level input helpers

The daemon already has useful pieces:

- splitting text from trailing newlines
- sending literal text with `tmux send-keys -l`
- sending Enter separately
- quiescence and activity-based waiting
- capture-pane helpers

Extract those into shared internal helpers so the new handlers do not duplicate the same logic three times.

### Task 6: Define authoritative result semantics

The runtime and Bud need shared expectations:

- `terminal_exec_result` is authoritative command output
- `terminal_send_result` is not a screen snapshot by default
- `terminal_observe_result` is the only explicit observation payload

Keep the result contract clean even if it costs an extra `observe` call in interactive flows.

### Task 7: Keep the browser input path working

Manual terminal input from the browser is still needed for xterm usage.

For this phase:

- keep the browser route on the low-level input path
- do not try to force the browser onto the agent's new `terminal.send` abstraction unless implementation proves it is an obvious win

The goal is to avoid conflating human keyboard input with agent intent.

## Validation Checklist

- [ ] service runtime methods match the new intent-split contract
- [ ] Bud understands the new request types
- [ ] `terminal_exec` runs shell commands without requiring `\n` in the request
- [ ] `terminal_send` supports structured submit/key semantics
- [ ] `terminal_observe` returns explicit observation data
- [ ] `terminal_exec_result` returns command output and readiness
- [ ] `terminal_send_result` does not masquerade as a command transcript
- [ ] the browser manual-input path still works after the runtime refactor
- [ ] gateway schemas and routing accept only the new result frames for the main agent flow

## Exit Criteria

This phase is done when the service runtime and Bud daemon speak the same breaking protocol for execution, interaction, and observation, and the agent no longer depends on the old `terminal_run` transport model.
