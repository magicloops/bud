# Review: Terminal Context Prompt Instructions

**Reviewed:** 2026-06-09
**Scope:** Current agent prompt guidance for `context_after`, REPL/interactive program hints, `terminal.send` gesture semantics, and cwd-related context.

## Question

Do the current prompt instructions still make sense after the `terminal.send` contract moved to `command` / `raw_text` / `key`, and after cwd context started flowing through message/tool-adjacent metadata?

## Summary

The intent of the quoted prompt block still makes sense: the model must not blindly send shell syntax when the foreground terminal is inside Python, Node, Claude Code, SQL shells, pagers, confirmations, or another interactive program.

The wording is now too strong in two places:

- `context_after` is not always a fresh, authoritative detection of the currently running program. It is authoritative only when readiness positively observes a shell return; otherwise it is usually inferred from service-side pending command tracking.
- The block predates the model-facing `terminal.send` gesture contract. It should talk in terms of `command`, `raw_text`, and `key`, not generic "send shell commands" or old `text` / `submit` behavior.

The cwd concern is a separate gap. Current terminal tool calls do not accept a model-facing `cwd` parameter. The current code carries cwd through `POST /messages` as `preferred_cwd`, daemon `host_cwd` result metadata, cached `terminal_session.cwd`, and persisted path-context metadata. The prompt should explain this distinction if we want the model to use cwd context correctly.

## Findings

### 1. `context_after` is a useful hint, not always proof

`TerminalToolExecutor` builds `context_after` from `TerminalSessionManager.getSessionContext(...)`. It marks the source as `observed` only when readiness says `prompt_type: "shell"`, confidence is at least `0.8`, and `looks_like_prompt` is true. Otherwise the source is `inferred`.

That means the existing line:

```text
Tool results include a "context_after" field indicating what program is currently running in the terminal.
```

overstates the current contract. A better contract is:

```text
Terminal tool results include "context_after". If source is "observed", the service has strong evidence of a shell prompt. If source is "inferred", treat the mode/program as a likely context hint based on prior tracked input, not proof.
```

This matters because a stale inferred `claude` or `python` context can survive until a later observed shell return clears pending command state.

### 2. The REPL-specific behavior is still correct, but should say "interactive program"

The registry still provides program-specific hints for Claude Code, Python, Node, SQL shells, and other programs. The core behavior remains right:

- Claude Code should receive natural language, not raw shell syntax.
- Python and Node should receive language code.
- SQL shells should receive SQL or shell-specific meta commands.

The current `TerminalContextMode` uses `mode: "repl"` for more than literal REPLs. It also covers assistant TUIs and command shells tracked as known interactive programs. The prompt should say "interactive program" or "REPL/TUI" when explaining the mode, while keeping the actual JSON enum unchanged.

### 3. The prompt already has the new `terminal.send` shape, but the quoted block has old mental models

The canonical prompt already documents examples like:

```json
{"type":"tool_call","tool":"terminal.send","command":"pwd"}
{"type":"tool_call","tool":"terminal.send","raw_text":"partial input"}
{"type":"tool_call","tool":"terminal.send","key":"ctrl+c"}
```

The `terminal_send` JSON Schema also exposes `command`, `raw_text`, `key`, `observe_after_ms`, and `wait_for`. It no longer advertises `text`, `submit`, or `timeout_ms`.

The quoted block should be reconciled with that contract:

- For shell mode, use `terminal.send` with `command` for shell line input plus Enter.
- For REPL/TUI mode, use `command` for line input appropriate to that program, not shell syntax.
- Use `raw_text` only for deliberate unsubmitted typing.
- Use `key` for interrupts and one-key TUI/pager actions.

The Claude Code exit example using `command:"exit"` and `key:"ctrl+c"` is still compatible with the new contract.

### 4. Cwd is present in the system, but not as a terminal tool argument

There are two different "tool call" meanings here. If we mean the browser/API call that creates a user message, cwd is now accepted. If we mean the model-facing `terminal.send` / `terminal.observe` tools, cwd is not an argument today.

Current cwd paths:

- `POST /api/threads/:threadId/messages` accepts optional `cwd` and stores it as `message.metadata.preferred_cwd`.
- `AgentConversationLoader` appends `[Preferred CWD: ...]` to that user message when reconstructing model context.
- Daemon `terminal_send_result` and `terminal_observe_result` can include `host_cwd`; the service caches it on `terminal_session.cwd`.
- Transcript writer stores `path_context_before`, `path_context_after`, `path_context`, and `terminal_visibility.observed_cwd` as metadata for file-link/freshness workflows.

Current non-paths:

- `terminal_send` does not accept `cwd`.
- `terminal_observe` does not accept `cwd`.
- `context_after` does not include `cwd`.
- Normal online provider calls currently do not inject terminal freshness notes, even if cached cwd changed.

So a prompt update should not say "set cwd on terminal.send" unless the tool schema changes. It should say that a user message may include preferred cwd context, but the persistent terminal still runs in its current process cwd. If the task depends on the working directory, the model should verify with `pwd`, `terminal.observe`, or an explicit shell `cd` command.

### 5. The prompt should mention result gesture metadata

Current terminal-send results expose explicit fields:

- `input_dispatched`
- `command_sent`
- `raw_text_sent`
- `key_sent`
- `enter_requested`
- legacy `submitted`

The prompt already says not to rely on `submitted` alone in nearby guidance. The `context_after` block should not reintroduce ambiguity. The model should reason from `delta`, `readiness`, `context_after.source`, and explicit gesture metadata together.

## Suggested Prompt Direction

This is a wording direction only, not an implementation change:

```text
CONTEXT AWARENESS (CRITICAL):
Terminal tool results include "context_after".
- If context_after.source is "observed", the service has strong readiness evidence for the reported mode.
- If context_after.source is "inferred", treat mode/program/hints as likely context from prior tracked input, not proof.
- When context_after.mode is "shell": the terminal appears to be at a shell prompt. Use terminal.send.command for shell line input plus Enter.
- When context_after.mode is "repl": the terminal is likely inside an interactive program or TUI. Do not send shell syntax unless that program expects shell syntax.
  * context_after.program identifies the tracked program when known.
  * context_after.hints provides program-specific interaction guidance.
- If the current output, prompt, or cwd matters and context is inferred or ambiguous, verify with terminal.observe or an appropriate command such as pwd before making assumptions.

TERMINAL.SEND GESTURES:
- Use command for line input plus Enter, including shell commands, REPL code, confirmations, and assistant/TUI natural-language prompts.
- Use raw_text only when intentionally typing without pressing Enter.
- Use key for one semantic key such as ctrl+c, enter, escape, q, or arrows.
```

The REPL-specific bullets can then stay mostly as-is, with "send Python code" / "send JavaScript code" / "send SQL commands" understood as `terminal.send.command` line input unless unsubmitted typing or a key gesture is specifically needed.

## Recommendation

Keep the context-awareness concept. Update the prompt wording before treating it as a reliable guardrail again.

Concrete follow-up:

- Fold `context_after.source` into the critical context block, not just as a trailing caveat.
- Replace shell/REPL phrasing that implies raw terminal text with `terminal.send.command` / `raw_text` / `key` semantics.
- Add a cwd note that matches the current implementation: preferred cwd may arrive from the user message, daemon cwd is cached for metadata/file resolution, but terminal tools do not currently take a cwd argument.
- Do not promise that `context_after.program` is always present or authoritative.
- Consider renaming the explanatory wording from "repl" to "interactive program" while preserving the wire enum.

## References

- `service/src/agent/default-system-prompt.md`
- `service/src/agent/tool-definitions.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/runtime/terminal/runtime-state.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/terminal/known-programs.ts`
