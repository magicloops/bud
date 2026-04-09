# Phase 1: Service Tool Contract And Agent Harness

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Replace the agent-facing tool surface and result model so the service speaks in terms of execution, interaction, and observation rather than the current overloaded `terminal.run` / `terminal.capture` pair.

By the end of this phase:

- the model sees `terminal.exec`, `terminal.send`, `terminal.observe`, and `terminal.interrupt`
- shell commands no longer encode `\n` in tool arguments
- tool results distinguish command output from interaction acknowledgements and observations
- persisted tool messages and runtime stream payloads use the new tool names and payload structure

## Current Problem

Today `service/src/agent/agent-service.ts` teaches the model a low-level terminal transport:

- `terminal.run` means "send raw input, maybe including `\n`"
- `terminal.capture` means "look at the terminal"
- the result payload always includes `output`, even though the meaning of that output changes by mode

That makes the model reason about terminal mechanics instead of user intent.

## Scope

### In Scope

- agent tool names and JSON schema
- system prompt/tool guidance
- parsed directive types
- tool-result payload redesign
- persisted tool-message metadata shape
- agent runtime / SSE payload updates where tool names or summaries surface
- local conversation replay logic for new tool names

### Out Of Scope

- Bud daemon wire cutover itself
- browser manual input route redesign
- final protocol/spec update pass

## Contract Direction

### `terminal.exec`

Agent-facing arguments:

```json
{
  "command": "pwd",
  "timeout_ms": 10000
}
```

Result direction:

- `kind: "command_result"`
- `output`
- `output_bytes`
- `truncated`
- `definitive`
- `readiness`
- `context_after`

### `terminal.send`

Agent-facing arguments:

```json
{
  "text": "Please review src/main.rs",
  "submit": true,
  "keys": [],
  "wait_for": "screen_stable",
  "timeout_ms": 30000
}
```

Result direction:

- `kind: "interaction_ack"`
- `submitted`
- `readiness`
- `context_after`
- optional `follow_up_hint`

### `terminal.observe`

Agent-facing arguments:

```json
{
  "view": "screen",
  "wait_for": "screen_stable",
  "lines": -50,
  "timeout_ms": 5000
}
```

Result direction:

- `kind: "observation"`
- `view`
- `output`
- `output_bytes`
- `truncated`
- `readiness`
- `context_after`

## Implementation Tasks

### Task 1: Replace the tool definitions in `AgentService`

Update:

- `AgentDirective`
- `CANONICAL_TOOLS`
- `SYSTEM_PROMPT`
- `toolNameForConversation()`
- `extractFunctionCall()`

Explicitly remove:

- tool descriptions that tell the model to include `\n` for shell commands
- prompt wording that treats post-`terminal.run` capture as a special-case optimization

### Task 2: Redesign `TerminalCallResult` into explicit variants

Current `TerminalCallResult` assumes every tool has:

- `output`
- `outputBytes`
- `truncated`
- `readiness`

That is wrong for `terminal.send`.

Replace it with a typed result model, for example:

- `ExecResult`
- `SendResult`
- `ObserveResult`

or a discriminated union around `kind`.

The goal is to make the correct next step obvious from the payload itself.

### Task 3: Rewrite `executeTerminalCall()`

Update the service-side execution flow so:

- `terminal.exec` calls a shell-command runtime method
- `terminal.send` calls an interactive-input runtime method
- `terminal.observe` calls an explicit observe method
- `terminal.exec` fails fast when the context is not shell

Do not let `terminal.exec` silently downgrade to interactive semantics.

### Task 4: Rewrite tool persistence and summaries

Update:

- `recordTerminalToolMessage()`
- `buildToolSummary()`
- `summarizeTerminalInput()`
- `buildConversation()`

New persisted metadata should reflect the new contract, for example:

- `tool: "terminal.exec"`
- `command`
- `kind`
- `definitive`
- `view`
- `submitted`

Do not spend effort on historical compatibility. Existing local rows can be skipped or treated as stale.

### Task 5: Update runtime stream tests and tool-call fixtures

Current tests hardcode `terminal.run` and `pwd\n`.

Update the service test fixtures so they reflect:

- `terminal.exec` with `command: "pwd"`
- `terminal.send` with structured submit semantics
- `terminal.observe` with explicit view fields

Primary targets:

- `service/src/runtime/agent-runtime-state.test.ts`
- any tool-rendering or message-shape tests in web/service

### Task 6: Adjust tool-result event payloads

If the UI or runtime stream exposes tool names and summaries, update the emitted event data accordingly.

Goals:

- event payloads use the new tool names
- result summaries are concise and intent-based
- `terminal.exec` and `terminal.observe` are visually distinct
- `terminal.send` does not masquerade as a command transcript

## Validation Checklist

- [ ] `AgentService` exposes the new tool names only
- [ ] shell-command examples in the prompt no longer embed `\n`
- [ ] `terminal.exec` directives parse `command`, not raw input
- [ ] `terminal.send` directives parse structured text/submit/key arguments
- [ ] `terminal.observe` directives parse observation-specific arguments
- [ ] `terminal.exec` results are marked as command results
- [ ] `terminal.send` results are acknowledgements, not fake command output
- [ ] tool persistence stores the new names and metadata shape
- [ ] conversation replay for new tool rows still reconstructs provider tool-use / tool-result history correctly
- [ ] runtime tests no longer assume `terminal.run("pwd\\n")`

## Exit Criteria

This phase is done when the service and agent harness no longer expose the old overloaded terminal tool surface and the new tool/result model is ready to wire into the runtime and Bud daemon.
