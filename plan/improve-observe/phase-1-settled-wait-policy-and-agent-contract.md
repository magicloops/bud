# Phase 1: Settled Wait Policy And Agent Contract

**Status**: Implemented
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Urgent

## Goal

Make the service, not the model, own the effective timeout policy for settled terminal waits.

`wait_for: "settled"` should receive a one-hour budget for both `terminal.send` and `terminal.observe`. Other wait modes should keep their existing smaller budgets unless explicitly changed later.

## Scope

### In Scope

- Add a central service-side settled wait budget constant, initially `3_600_000ms`.
- Apply that budget to:
  - `terminal.send` when `wait_for` is omitted, because send defaults to settled
  - `terminal.send` when `wait_for: "settled"`
  - `terminal.observe` when `wait_for: "settled"`
- Keep smaller defaults for `wait_for: "none"`, `wait_for: "changed"`, and `wait_for: "shell_ready"`.
- Stop presenting `timeout_ms` as a normal model-facing choice.
- Continue tolerating legacy or replayed `timeout_ms` values if needed, but clamp or ignore them under service policy for agent-initiated tools.
- Ensure the daemon receives an explicit timeout budget from the service so service local timeouts and Bud waits stay aligned.

### Out Of Scope

- Daemon quiescence/readiness changes.
- Human interrupt UI.
- Protocol version bump.
- Removing wire-level `timeout_ms` from the daemon protocol.

## Implementation Notes

### Service Policy

Add or centralize policy constants near the terminal request dispatcher or a shared terminal policy module:

```typescript
const TERMINAL_SETTLED_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const TERMINAL_DEFAULT_WAIT_TIMEOUT_MS = 30 * 1000;
const TERMINAL_LOCAL_TIMEOUT_GRACE_MS = 1000;
```

The exact location should match existing ownership. The important contract is that send and observe go through the same resolver:

```typescript
resolveTerminalWaitTimeout(waitFor, requestedTimeoutMs)
```

Policy:

- if `waitFor === "settled"`, return `TERMINAL_SETTLED_WAIT_TIMEOUT_MS`
- if send omits `waitFor`, treat it as `"settled"`
- otherwise return the existing short default unless a lower-level caller explicitly requests a different value
- for model-originated tool calls, do not allow arbitrary `timeout_ms` to exceed or replace product policy

### Model Tool Schema

Update the canonical tool definitions in `service/src/agent/model-runner.ts`:

- remove `timeout_ms` from the advertised schema if provider compatibility allows it
- otherwise mark it as internal/advanced and tell the model not to set it

The preferred target is simpler:

- model chooses `wait_for: "settled"` when it wants a settled wait
- service chooses the actual timeout

### System Prompt

Update `AGENT_SYSTEM_PROMPT` in `service/src/agent/conversation-loader.ts`:

- explain that `terminal.send` waits for settled output by default
- explain that `terminal.observe(wait_for:"settled")` is the explicit long-wait inspection tool
- avoid telling the model to set `timeout_ms`
- keep guidance for alternate wait modes when no-output commands or quick reaction checks need different behavior

### Tool Replay / Stored Rows

Historical tool rows may include `timeout_ms`. Replay can tolerate them, but should not let old rows alter the current policy for new live tool calls.

## Acceptance Criteria

- [x] `terminal.send` default settled waits pass `timeout_ms: 3600000` to Bud.
- [x] `terminal.observe(wait_for:"settled")` passes `timeout_ms: 3600000` to Bud.
- [x] non-settled send/observe modes keep short defaults.
- [x] model-facing schema or prompt no longer encourages arbitrary `timeout_ms`.
- [x] service local timeout remains Bud timeout plus a small grace period.
- [x] tests cover timeout policy resolution for send default, send settled, observe settled, and non-settled modes.

## Tests

- Unit tests for the timeout policy resolver.
- Existing terminal-tool-executor tests updated from `30000` expectations to settled policy expectations.
- Request-dispatcher tests for local timeout math with large settled waits.

## Specs To Update In This Phase

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`

Protocol docs can wait until Phase 4 if exact wording changes during implementation.
