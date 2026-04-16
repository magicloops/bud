# Phase 2: Agent Removal And Browser Wrapper Cutover

## Goal

Remove `terminal.interrupt` from the model-facing contract while preserving the browser `/terminal/interrupt` endpoint as a thin wrapper over the general send-key path.

## Scope

Primary files:

- `service/src/agent/agent-service.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/routes/threads.ts`
- `service/src/agent/agent-service.test.ts`
- `web/src/components/message-renderers/tools/tools.spec.md`

## Problem Statement

Once `terminal.send` can express `C-c`, the agent no longer needs a dedicated interrupt tool.

However, the browser escape hatch is still useful and should survive. That means this phase must:

- remove the model-facing tool
- keep the browser endpoint
- move the browser endpoint onto a shared send-key helper instead of the dedicated interrupt helper

## Required Changes

### 1. Remove `terminal_interrupt` from the agent harness

Delete the dedicated tool from:

- tool schema/registration
- tool-call parsing
- execution branching
- tool summaries and truncation-reason logic

After this phase, the model-facing input contract should be:

- `terminal.send`
- `terminal.observe`

### 2. Route browser interrupts through the send path

Keep:

- `POST /api/threads/:thread_id/terminal/interrupt`

but implement it as a wrapper over a shared send-key helper.

Recommended direction:

- introduce or reuse a general helper that sends keys via the `terminal_send` path
- have the browser route call that helper with `["C-c"]`
- keep the route response compact (`{ ok: true }` / `503` on failure) rather than surfacing agent-style delta details

The browser route should remain a product/API affordance, not a reason to keep dedicated interrupt internals.

### 3. Replace interrupt-specific tests with send-key coverage

Remove or rewrite tests so they validate:

- the model uses `terminal.send`
- `C-c` flows through the send path
- the browser wrapper still works

### 4. Clean up active renderer/spec assumptions

Update active developer-facing tool docs/specs so `terminal.interrupt` is no longer presented as a rendered/first-class agent tool.

## Acceptance Criteria

- the agent no longer advertises `terminal_interrupt`
- the browser `/terminal/interrupt` route still works
- browser interrupts are implemented through shared send-key logic
- no active model prompt or tool summary instructs the model to use `terminal.interrupt`

## Out Of Scope For This Phase

- deleting dedicated Bud/service interrupt protocol types and handlers
- the final active-doc/spec/reference sweep
