# Plan: Clarify terminal.run Output in System Prompt

**Status:** Implemented (2025-12-19)
**Created:** 2025-12-19
**Related:** [`debug/agent-terminal-run-output-flow.md`](../debug/agent-terminal-run-output-flow.md)

---

## Problem Statement

The LLM agent is calling `terminal.capture` after `terminal.run` even though `terminal.run` already returns terminal output in its response. This wastes tokens, increases latency, and is unnecessary.

### Root Cause

**The system prompt and tool definitions never tell the LLM that `terminal.run` returns output.**

Current messaging:
- `terminal_run` description: "Send input to the persistent terminal" — sounds input-only
- `terminal_capture` description: "Get terminal screen output" — sounds like the way to get output
- System prompt line 78-81: "Use terminal.capture to get terminal screen output" — the ONLY mention of getting output

The LLM logically concludes: send input → call capture to see what happened.

### Evidence

From code analysis (`agent-service.ts`):
- Line 986: `output: result.output` — output IS included in tool result
- Lines 314-322: Tool result IS added to conversation with full JSON payload
- Lines 896-904: `terminal.run` returns `TerminalCallResult` with `output` field

The output is being sent correctly. The problem is purely documentation in the prompt.

---

## Objective

Update the system prompt and tool definitions so the LLM understands:
1. `terminal.run` returns output (not just readiness info)
2. `terminal.capture` is only needed for specific scenarios
3. The typical workflow doesn't require capture after run

### Success Criteria

- LLM stops calling `terminal.capture` after every `terminal.run`
- LLM still uses `terminal.capture` appropriately (TUI apps, low confidence, scrollback)
- No regression in agent behavior for shell commands or REPL interactions

---

## Proposed Changes

### 1. Update `terminal_run` Tool Description

**File:** `service/src/agent/agent-service.ts`
**Lines:** 135-136

**Current:**
```typescript
{
  name: "terminal_run",
  description: "Send input to the persistent terminal (include \\n to press Enter).",
  ...
}
```

**Proposed:**
```typescript
{
  name: "terminal_run",
  description: "Send input to the terminal and receive output. Returns: terminal output, readiness assessment, and context. Include \\n to press Enter.",
  ...
}
```

### 2. Update `terminal_capture` Tool Description

**File:** `service/src/agent/agent-service.ts`
**Lines:** 164-167

**Current:**
```typescript
{
  name: "terminal_capture",
  description:
    "Get terminal screen output. Use to see TUI app content, scroll through history, " +
    "or wait for a command to finish. Returns the rendered screen (what you would see visually).",
  ...
}
```

**Proposed:**
```typescript
{
  name: "terminal_capture",
  description:
    "Capture terminal screen (for TUI apps, scrollback history, or waiting). " +
    "NOT needed after terminal.run - output is already included. Use only for: " +
    "TUI apps (rendered screen), scrollback (lines: -200), or low confidence waits (wait: true).",
  ...
}
```

### 3. Add Tool Response Documentation to System Prompt

**File:** `service/src/agent/agent-service.ts`
**Location:** After "Tools:" section (after line 63), add new section

**Add:**
```
Tool Responses:
All terminal tools return a JSON result with:
- output: The terminal output text (already included - no need to capture separately)
- readiness: { ready, confidence, trigger, hints }
- context: { mode: "shell"|"repl", program?, hints? }

You do NOT need to call terminal.capture after terminal.run. The output is already in the response.
Only use terminal.capture for:
- TUI applications (to see the rendered screen layout)
- Scrollback history (use lines: -200 or -500)
- Low confidence waits (when terminal.run returns confidence < 0.5, use wait: true)
```

### 4. Update the terminal.capture Guidelines Section

**File:** `service/src/agent/agent-service.ts`
**Lines:** 78-81

**Current:**
```
- Use terminal.capture to get terminal screen output:
  - Add wait:true if a command might still be running (waits for readiness first)
  - Add lines:-200 or lines:-500 for more scrollback history
  - Works well for TUI apps (rendered screen instead of raw byte stream)
```

**Proposed:**
```
- terminal.capture is NOT needed after terminal.run (output is already included). Use it only for:
  - TUI apps: Get the rendered screen layout (visual representation)
  - Scrollback: Retrieve more history with lines:-200 or lines:-500
  - Low confidence: If terminal.run returns confidence < 0.5, use terminal.capture with wait:true
```

---

## Full Updated System Prompt

For reference, here's the complete updated system prompt:

```
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.capture"}
- {"type":"tool_call","tool":"terminal.capture","wait":true}
- {"type":"tool_call","tool":"terminal.interrupt"}

Tool Responses:
All terminal tools return a JSON result with:
- output: The terminal output text (already included - no need to capture separately)
- readiness: { ready, confidence, trigger, hints }
- context: { mode: "shell"|"repl", program?, hints? }

You do NOT need to call terminal.capture after terminal.run. The output is already in the response.
Only use terminal.capture for:
- TUI applications (to see the rendered screen layout)
- Scrollback history (use lines: -200 or -500)
- Low confidence waits (when terminal.run returns confidence < 0.5, use wait: true)

Guidelines:
- Include \\n to press Enter. For confirmations, send "y\\n". For single-key prompts (like q to exit pager), send just the key.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.capture with wait:true
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
- Use interrupt if a command hangs or you need to stop it.
- terminal.capture is NOT needed after terminal.run (output is already included). Use it only for:
  - TUI apps: Get the rendered screen layout (visual representation)
  - Scrollback: Retrieve more history with lines:-200 or lines:-500
  - Low confidence: If terminal.run returns confidence < 0.5, use terminal.capture with wait:true

CONTEXT AWARENESS (CRITICAL):
[... rest unchanged ...]
```

---

## Implementation Checklist

### Code Changes

- [x] Update `terminal_run` tool description (`agent-service.ts:136`)
- [x] Update `terminal_capture` tool description (`agent-service.ts:165-167`)
- [x] Add "Tool Responses" section to system prompt (after line 63)
- [x] Update terminal.capture guidelines section (lines 78-81)

### Documentation Updates

- [x] Update `debug/agent-terminal-run-output-flow.md` to mark issue as fixed
- [ ] Update `service/src/agent/agent.spec.md` if tool descriptions changed significantly

### Testing

- [ ] Manual test: Send a shell command, verify agent doesn't call capture afterward
- [ ] Manual test: Start a TUI app, verify agent appropriately uses capture
- [ ] Manual test: Long-running command with low confidence, verify agent uses capture with wait
- [ ] Verify no regression in REPL context handling (Python, Claude Code, etc.)

---

## Spec Files to Update

- [ ] `service/src/agent/agent.spec.md` — Update tool descriptions table if changed

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LLM ignores new documentation | Low | Medium | Use explicit, repeated messaging |
| Breaking existing workflows | Low | High | Changes are additive/clarifying, not behavioral |
| Token count increase | Low | Low | New text is ~150 tokens, within acceptable range |

---

## Rollback

If the changes cause issues:
1. Revert the system prompt changes in `agent-service.ts`
2. No database or protocol changes to roll back

---

## Future Considerations

1. **Prompt Management System**: This change is a band-aid. The broader solution from `design/prompt-management.md` (extracting prompts to markdown files) would make these changes easier to review and iterate on.

2. **Tool Response Examples**: Consider adding example tool responses in the system prompt to make the format crystal clear.

3. **Metrics**: Consider adding observability to track how often terminal.capture is called immediately after terminal.run, to measure the impact of this change.

---

*Created: 2025-12-19*
