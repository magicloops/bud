# Phase 1: Service Context And Dispatch Correctness

## Goal

Fix the two service-side correctness bugs without waiting on any Bud protocol work:

- interrupt must not erase REPL/TUI context before shell return is observed
- interrupt dispatch failure must not be reported as a successful submission

## Scope

Files expected in this phase:

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/agent/agent-service.ts`
- related service tests

This phase intentionally leaves the legacy interrupt-output reconstruction in place. Finding 3 is handled in Phase 2.

## Problem Statement

The current service behavior does two harmful things:

1. `sendInterrupt()` clears `pendingCommands` immediately after frame dispatch.
2. `AgentService.executeTerminalCall()` ignores the `{ ok, error }` return from `sendInterrupt()`.

Those behaviors combine into bad model-facing output:

- `context_after` can claim shell mode even when the REPL/TUI is still running
- the tool result can say Ctrl+C was sent when nothing reached the bud

## Task 1: Preserve REPL Context Until Shell Return Is Observed

### Change

Stop clearing `pendingCommands` inside `sendInterrupt()` at dispatch time.

### Desired Rule

- dispatching Ctrl+C is not proof that the foreground program exited
- only an observed shell return should clear the pending REPL/TUI command
- existing shell-detection paths remain the clearing authority:
  - `storeReadinessAssessment(...)` when prompt detection proves shell
  - `ContextSyncService.refreshSnapshot(...)` / `checkAndSync(...)` when captured screen state proves shell

### Implementation Notes

- keep `getSessionContext()` behavior unchanged so the agent continues to infer REPL mode while the pending command is still present
- rely on `buildContextAfterSnapshot(...)` to override inferred state only when readiness explicitly proves shell
- do not introduce a new interrupt-only state machine in this phase unless the code change clearly requires it

### Acceptance Criteria

- after interrupting Claude Code, Python, or another tracked REPL/TUI, `context_after` stays inferred REPL/TUI unless shell return was actually observed
- when shell return is observed with high confidence, pending REPL state is still cleared as before

## Task 2: Fail Closed On Interrupt Dispatch Failure

### Change

Make the agent interrupt path branch on the dispatch result from `sendInterrupt()`.

### Desired Rule

- if dispatch fails, the tool result must not claim success
- `submitted` must be `false`
- the tool payload and summary must include the failure reason
- the phase must not wait for readiness or tail output after a failed dispatch

### Chosen Agent Behavior

For this plan, the agent should record a structured unsuccessful tool result rather than silently converting the problem into a successful interrupt or immediately pretending nothing happened.

That means:

- `error` carries the transport/runtime failure code such as `bud_offline` or `session_not_found`
- `submitted` is `false`
- summary text changes from `Sent Ctrl+C` to a failure-specific message
- output fields remain empty for that failed dispatch

If later work wants all terminal tools to share one common structured transport-error model, that can be a separate follow-up.

### Acceptance Criteria

- interrupt dispatch failure no longer produces `submitted: true`
- no readiness wait or output tail happens after failed dispatch
- tool summary text makes the failure explicit

## Task 3: Add Phase-1 Regression Tests

### Service Runtime / Agent Tests

- pending REPL context survives interrupt dispatch until shell return is observed
- shell prompt detection still clears pending REPL context after interrupt
- agent interrupt returns `submitted: false` and `error` when `sendInterrupt()` reports failure
- summary generation for failed interrupts does not say `Sent Ctrl+C`

## Out Of Scope For This Phase

- no Bud-side frame additions
- no `terminal_interrupt_result` yet
- no change to browser interrupt endpoint semantics
- no change to DB-tail reconstruction beyond avoiding it on dispatch failure
