# Phase 14: Remove `terminal.exec` And Adopt A Send-First Contract

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Planned

---

## Objective

Remove `terminal.exec` entirely from the Bud/service/web/model-facing contract and move to a simpler two-tool interaction model:

- `terminal.send` as the primary terminal input interface for both shell and interactive programs
- `terminal.observe` as the explicit follow-up hatch for longer-running or ambiguous operations

By the end of this phase:

- the agent no longer sees or calls `terminal.exec`
- Bud and service no longer expose `terminal_exec` / `terminal_exec_result`
- shell command execution happens through `terminal.send`
- prompt guidance, summaries, and tool rendering reflect the send-first model

## Context

The original revised contract split one overloaded tool into:

- `terminal.exec`
- `terminal.send`
- `terminal.observe`
- `terminal.interrupt`

That split solved the original newline-encoding problem, but later validation exposed a simpler reality:

- `terminal.send` is now the most reliable and flexible tool
- `terminal.observe` gives us the explicit inspection escape hatch we wanted
- `terminal.exec` still does not provide a real exit code
- `terminal.exec` is restrictive enough to fail on normal multiline shell authoring such as heredocs

The current tmux-backed implementation means `terminal.exec` and `terminal.send` are closer than the model-facing contract suggests. This phase takes the next step and removes `terminal.exec` completely rather than preserving a weakly authoritative shell-only path.

## Scope

### In Scope

- removing `terminal.exec` from the model/tool schema
- removing service-side `terminal.exec` execution handling
- removing Bud-side `terminal_exec` request/response handling
- updating docs/specs/protocol/tool rendering for a send-first model
- updating guidance so shell commands use `terminal.send`

### Out Of Scope

- building a new authoritative shell-command primitive
- changing the browser’s lower-level manual terminal input path unless needed for shared cleanup
- adding a compatibility alias for `terminal.exec`

## Implementation Tasks

### Task 1: Remove `terminal.exec` from the agent contract

- remove `terminal_exec` from the model-facing tool list
- remove `terminal.exec` parsing and dispatch from `AgentService`
- update the system prompt so shell commands are expressed through `terminal.send`
- rewrite examples and guidance so:
  - simple shell commands use `terminal.send` with `submit: true`
  - `terminal.observe` is the explicit follow-up for longer-running shell/TUI work

### Task 2: Remove service/runtime support for `terminal.exec`

- remove `execCommand()` from the active `TerminalSessionManager` contract
- remove pending-exec tracking and Bud gateway handling for `terminal_exec_result`
- remove `terminal.exec` tool-result persistence/summary code
- update service types to reflect the send/observe/interrupt-only contract

### Task 3: Remove Bud protocol support for `terminal_exec`

- remove `TerminalExecFrame` / `terminal_exec_result`
- remove Bud `handle_exec(...)`
- remove `terminal_exec` protocol docs and examples
- keep the tmux send path unified behind `terminal.send`

### Task 4: Rework shell guidance around `terminal.send`

- clarify in prompt/tool docs that `terminal.send` is now the normal way to run shell commands
- decide and document the recommended default wait behavior for shell sends
- keep shell-vs-REPL/TUI context awareness for guidance, but not as a separate tool boundary
- make `terminal.observe` the explicit secondary hatch when:
  - the command may still be running
  - the result delta is ambiguous or too small
  - the model wants broader context than the send result provides

### Task 5: Update developer-visible tool surfaces

- remove `terminal.exec` rendering paths from the web tool components
- ensure send-first tool cards still make shell activity understandable
- avoid surfacing stale “command result” assumptions after the contract change

## Files Likely Affected

### Service

- `service/src/agent/agent-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `service/src/ws/gateway.ts`
- `service/src/agent/terminal-send-outcome.ts`

### Bud

- `bud/src/main.rs`

### Web

- `web/src/components/message-renderers/tools/terminal-run.tsx`
- `web/src/components/message-renderers/tools/index.ts`

### Docs / Specs

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Losing the output-oriented “command result” abstraction makes shell turns harder for the model to reason about | Medium | Medium | Tighten `terminal.send` shell guidance and validate common shell tasks explicitly |
| Shell commands and TUI input become harder to distinguish conceptually | Medium | Medium | Keep shell-vs-REPL/TUI context awareness and teach explicit observe follow-up rules |
| Existing docs/specs continue to imply `terminal.exec` exists | High | Medium | Treat doc/spec cleanup as part of the same phase, not as follow-up debt |
| Hidden references to `terminal_exec` remain in service/Bud protocol handling | Medium | High | Remove the protocol path end-to-end and verify by searching for `terminal_exec` / `terminal.exec` after implementation |

## Exit Criteria

- `terminal.exec` is gone from the model-facing tool surface
- `terminal_exec` / `terminal_exec_result` are gone from the Bud/service wire contract
- shell commands can be executed through `terminal.send` without relying on `terminal.exec`
- docs/specs/tool rendering no longer describe `terminal.exec` as an active part of the contract

