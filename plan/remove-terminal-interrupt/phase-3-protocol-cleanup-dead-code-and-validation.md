# Phase 3: Protocol Cleanup, Dead Code, And Validation

## Goal

Delete the dedicated interrupt runtime/protocol machinery and finish the active-reference cleanup once no active caller still needs it.

## Scope

Primary files:

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `bud/src/main.rs`
- `docs/proto.md`
- active specs/docs listed in the parent implementation spec

## Problem Statement

After Phase 2, the dedicated interrupt feature should no longer have any active caller:

- the agent will use `terminal.send(keys: ["C-c"])`
- the browser route will wrap the send path

At that point, keeping dedicated interrupt runtime/protocol code would be pure duplication:

- extra service helpers
- extra pending maps
- extra Bud wire messages
- extra tests/docs/specs

This phase removes that duplication and ensures the repo no longer describes `terminal.interrupt` as an active contract unless the reference is intentionally historical.

## Required Changes

### 1. Remove dedicated service runtime interrupt handling

Delete interrupt-specific runtime code that is no longer needed, including as applicable:

- `requestInterrupt(...)`
- `sendInterrupt(...)` if replaced by a generic send-key helper
- pending interrupt maps/state
- interrupt-specific readiness fallback handling
- interrupt-specific tests that are no longer relevant

### 2. Remove dedicated gateway/type/protocol plumbing

Delete interrupt-specific service/Bud protocol definitions and handlers:

- `TerminalInterruptMessage`
- `TerminalInterruptResultMessage`
- gateway schemas/handlers for interrupt result frames
- any runtime types whose only purpose was the dedicated interrupt path

### 3. Remove dedicated Bud interrupt protocol handling

Delete Bud-side code that only exists for the dedicated interrupt protocol, including as applicable:

- `TerminalInterruptFrame`
- `handle_interrupt(...)`
- interrupt-specific error helpers
- interrupt-result fan-out from readiness/activity detectors
- server-frame routing for `terminal_interrupt`

The browser endpoint should still function because it will already be routed through `terminal_send`.

### 4. Sweep active references

Update active source-of-truth docs/specs so they no longer present `terminal.interrupt` as an active feature.

Minimum expected sweep:

- `AGENTS.md`
- `docs/proto.md`
- `docs/terminal-testing.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/routes/routes.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`

Historical docs may remain if they are clearly archival, but active contract docs should not contradict the shipped behavior.

### 5. Finish with a dead-code/reference sweep

Run a final grep-based audit so the only remaining `terminal.interrupt` / `terminal_interrupt` mentions are intentional:

- browser `/terminal/interrupt` route and docs for that route
- historical design/debug/review/plan material
- the new removal design/plan docs themselves

## Acceptance Criteria

- no active runtime path depends on dedicated interrupt request/result handling
- dedicated Bud/service interrupt wire messages are removed if no active caller remains
- active docs/specs no longer present `terminal.interrupt` as an agent tool
- the browser interrupt route remains functional as a wrapper
- the final grep/reference sweep leaves only intentional historical references

## Validation Notes

Validation for this phase should include both:

- automated checks/tests for the send-key/browser-wrapper path
- manual confirmation that browser interrupt still works against a real shell/TUI session
