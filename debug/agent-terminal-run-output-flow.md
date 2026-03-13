# Debug: Agent terminal.run Output Flow Analysis

**Status:** Issue identified and fix implemented (2025-12-19)
**Fix:** [`plan/agent-tool-output-documentation.md`](../plan/agent-tool-output-documentation.md)

## Summary

**Key Question**: Does `terminal.run` automatically return terminal output, or must the agent call `terminal.capture` separately?

**Answer**: **`terminal.run` automatically includes terminal output in its response.** The agent does NOT need to call `terminal.capture` after every command. However, `terminal.capture` is still useful for specific scenarios (see below).

---

## Environment

- Service: Node.js/Fastify (`service/src/agent/`)
- Agent Implementation: `agent-service.ts`
- Terminal Management: `runtime/terminal-session-manager.ts`
- LLM Provider: OpenAI Responses API (via `providers/openai-responses.ts`)

---

## Findings

### 1. System Prompt (Exact Text)

From `agent-service.ts:55-118`:

```
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.capture"}
- {"type":"tool_call","tool":"terminal.capture","wait":true}
- {"type":"tool_call","tool":"terminal.interrupt"}

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
- Use terminal.capture to get terminal screen output:
  - Add wait:true if a command might still be running (waits for readiness first)
  - Add lines:-200 or lines:-500 for more scrollback history
  - Works well for TUI apps (rendered screen instead of raw byte stream)

CONTEXT AWARENESS (CRITICAL):
Tool results include a "context" field indicating what program is currently running in the terminal.
- When context.mode is "shell": You are at a shell prompt. Send shell commands.
- When context.mode is "repl": You are INSIDE an interactive program, NOT at a shell.
  * The context.program field tells you which program (e.g., "claude", "python", "node")
  * The context.hints array provides program-specific interaction guidance
  * DO NOT send shell commands - they will be interpreted as input to the REPL

IMPORTANT REPL-SPECIFIC BEHAVIOR:
- When context.program is "claude" (Claude Code):
  * You are inside an AI coding assistant
  * Use NATURAL LANGUAGE requests, not shell commands
  * Ask Claude to perform tasks: "Please review src/main.rs for bugs"
  * To run shell commands, ask Claude: "Run npm test"
  * Do NOT send raw shell syntax like "cat file.txt" - Claude will misinterpret it
  * To exit, send "exit\\n" or use terminal.interrupt
- When context.program is "python" or "python3":
  * Send Python code, not shell commands
  * Use print() to display output
- When context.program is "node":
  * Send JavaScript code, not shell commands
  * Use console.log() for output
- When context.program is "psql", "mysql", or "sqlite3":
  * Send SQL commands, not shell commands
  * Commands typically end with semicolons

Always check context.hints for additional program-specific guidance.

OUTPUT FORMAT:
- When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
- The "message" field supports markdown formatting. Use it for clarity:
  * **bold** for emphasis
  * \`code\` for commands, paths, and technical terms
  * Code blocks with language tags for multi-line code
  * Lists for multiple items or steps
```

---

### 2. Tool Definitions

Three canonical tools are defined in `CANONICAL_TOOLS` (`agent-service.ts:133-192`):

#### terminal_run
```typescript
{
  name: "terminal_run",
  description: "Send input to the persistent terminal (include \\n to press Enter).",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "Exact input to send (include \\n for Enter)."
      },
      timeout_ms: {
        type: "integer",
        description: "Optional max wait for readiness (ms)."
      }
    },
    required: ["input"]
  }
}
```

#### terminal_capture
```typescript
{
  name: "terminal_capture",
  description: "Get terminal screen output. Use to see TUI app content, scroll through history, or wait for a command to finish. Returns the rendered screen (what you would see visually).",
  parameters: {
    type: "object",
    properties: {
      wait: {
        type: "boolean",
        description: "Wait for terminal to become ready before capturing. Use after terminal.run returns low confidence. Default: false."
      },
      lines: {
        type: "integer",
        description: "Lines of scrollback history. Negative = from current position. Default: -50. Use -200 or -500 for more history."
      },
      timeout_ms: {
        type: "integer",
        description: "Max wait time in ms (only applies if wait=true). Default: 5000."
      }
    },
    required: []
  }
}
```

#### terminal_interrupt
```typescript
{
  name: "terminal_interrupt",
  description: "Send Ctrl+C to the terminal to interrupt the current process.",
  parameters: { type: "object", properties: {}, required: [] }
}
```

---

### 3. What terminal.run Returns

The `TerminalCallResult` type (`agent-service.ts:39-53`) defines what's returned:

```typescript
interface TerminalCallResult {
  output: string;              // Terminal output text (ANSI stripped)
  outputBytes: number;         // Total byte count
  readiness: Record<string, unknown>;  // Readiness assessment
  lastLine: string;            // Last line of output
  truncated: boolean;          // Whether output was truncated
  omittedLines: number;        // Lines omitted if truncated
  context?: {
    mode: "shell" | "repl" | "unknown";
    program?: string;          // e.g., "claude", "python", "node"
    programDisplayName?: string;
    interactionStyle?: string; // "natural_language", "code", "sql"
    hints?: string[];          // Program-specific guidance
  };
}
```

**JSON sent to LLM** (`recordTerminalToolMessage`, lines 977-1005):

```json
{
  "tool": "terminal.run",
  "call_id": "call_abc123",
  "input": "ls -la\n",
  "output": "total 48\ndrwxr-xr-x  5 user  staff  160 Dec 19 10:00 .\n...",
  "output_bytes": 512,
  "readiness": {
    "ready": true,
    "confidence": 0.95,
    "trigger": "prompt_detected",
    "hints": {
      "looks_like_prompt": true,
      "looks_like_confirmation": false,
      "looks_like_password": false,
      "looks_like_pager": false,
      "looks_like_error": false,
      "may_still_be_processing": false
    }
  },
  "last_line": "user@host:~$ ",
  "truncated": false,
  "omitted_lines": 0,
  "context": {
    "mode": "shell"
  }
}
```

---

### 4. Execution Flow for terminal.run

From `executeTerminalCall` (lines 805-905):

1. **Capture offset** - Records current byte position in output stream
2. **Send input** - Sends input via `TerminalSessionManager.sendInput()`
3. **Wait for readiness** - Waits for terminal to report "ready" (up to timeout)
4. **Get context** - Checks if in shell vs REPL mode
5. **Retrieve output** - Uses different methods based on mode:
   - **Shell mode**: `tailOutput()` - retrieves new output since command sent (byte-offset based)
   - **REPL mode**: `capturePane()` - gets rendered screen via tmux capture-pane
6. **Decode and clean** - Strips ANSI codes, normalizes line endings
7. **Return result** - Returns full `TerminalCallResult` with output included

---

### 5. Two Output Capture Mechanisms

#### Shell Mode: tailOutput()
- Queries `terminalSessionOutputTable` for chunks after `sinceOffset`
- Returns incremental output (only what was produced by the command)
- Efficient for long-running sessions with lots of prior output

#### REPL Mode: capturePane()
- Calls tmux `capture-pane` on the bud daemon
- Returns rendered screen (what user would see visually)
- Better for REPLs where incremental output isn't as meaningful
- Falls back to `tailOutput()` if capture fails

---

### 6. System Prompt Guidance on Readiness

The system prompt (`agent-service.ts:55-118`) teaches the agent about readiness:

```
## Readiness Interpretation
- confidence ≥ 0.8: Terminal is ready for next input
- confidence 0.5-0.8: Probably ready, can proceed carefully
- confidence < 0.5: Terminal may still be processing; consider waiting

If you need to wait for a command to finish, use terminal.capture with wait: true.
```

**When to use terminal.capture according to the prompt**:
- TUI applications (content that's only visible on-screen)
- Scrolling through history
- When `terminal.run` returns low confidence (<0.5)
- After long-running commands when output may have scrolled off

---

### 7. Readiness Assessment Structure

Returned from bud daemon (via `terminal-session-manager.ts:549-575`):

```typescript
interface ReadinessAssessment {
  ready: boolean;
  confidence: number;           // 0.0-1.0
  trigger: "prompt_detected" | "quiescence" | "timeout" | "activity_stable";
  prompt_type?: "shell" | "python" | "node" | "confirmation" | "password" | "pager";
  hints: {
    looks_like_prompt: boolean;
    looks_like_confirmation: boolean;
    looks_like_password: boolean;
    looks_like_pager: boolean;
    looks_like_error: boolean;
    may_still_be_processing: boolean;
  };
  quiet_for_ms?: number;
  activity_checks?: number;     // For activity-based detection
  stable_checks?: number;
}
```

---

### 8. Context Awareness (Shell vs REPL)

The system tracks whether the agent is in a shell or REPL:

**Shell Mode** (`context.mode: "shell"`):
- Agent should send shell commands
- Output retrieved via byte-offset (incremental)

**REPL Mode** (`context.mode: "repl"`):
- Tracks which program is running (claude, python, node, etc.)
- Output retrieved via tmux capture-pane (visual)
- Context includes:
  - `program`: "claude", "python", "node", etc.
  - `programDisplayName`: "Claude Code", "Python REPL"
  - `interactionStyle`: "natural_language", "code", "sql"
  - `hints`: Program-specific guidance

Known programs defined in `terminal/known-programs.ts` with exit commands and interaction styles.

---

### 9. Conversation History Format

Tool calls appear in the conversation as:

```
1. Assistant message with tool_use:
   { type: "tool_use", id: "call_123", name: "terminal_run", input: {...} }

2. User message with tool_result:
   { type: "tool_result", tool_use_id: "call_123", content: "<JSON with output>" }
```

The output is **always** included in the tool_result - no separate capture needed.

---

## When terminal.capture IS Needed

Despite `terminal.run` returning output, `terminal.capture` is still useful for:

1. **TUI applications** - Content only visible on rendered screen
2. **Low confidence scenarios** - When `terminal.run` returns confidence < 0.5
3. **Scrollback history** - Getting more history with `lines: -200` or `lines: -500`
4. **Long-running commands** - When output may have scrolled past the captured window
5. **Waiting for completion** - Using `wait: true` to block until ready

---

## Key Files

| File | Purpose |
|------|---------|
| `service/src/agent/agent-service.ts` | Main agent logic, tool definitions, system prompt |
| `service/src/agent/agent.spec.md` | Agent specification |
| `service/src/runtime/terminal-session-manager.ts` | Terminal session management, output capture |
| `service/src/agent/terminal/known-programs.ts` | REPL detection and program-specific hints |
| `service/src/agent/providers/openai-responses.ts` | LLM provider implementation |

## Key Line References (agent-service.ts)

| Lines | Content |
|-------|---------|
| 55-118 | `SYSTEM_PROMPT` - Full system prompt text |
| 133-192 | `CANONICAL_TOOLS` - Tool definitions array |
| 805-905 | `executeTerminalCall()` - terminal.run execution logic |
| 806 | Capture offset before input |
| 810-817 | Send input to terminal |
| 819-822 | Wait for readiness |
| 838-876 | Get output (REPL via capturePane, shell via tailOutput) |
| 896-904 | Return result with output included |
| 977-1005 | `recordTerminalToolMessage()` - Format for LLM |
| 1007-1021 | `decodeTail()` - ANSI stripping and cleanup |

---

## Conclusion

The current implementation **automatically includes output** in `terminal.run` responses. The agent receives:
- Full terminal output (ANSI-stripped)
- Readiness assessment with confidence score
- Context about shell vs REPL mode
- Hints about what the output looks like (prompt, error, etc.)

This design means:
- Most commands don't need a follow-up `terminal.capture`
- The agent can immediately proceed if confidence is high (≥0.8)
- The agent should use `terminal.capture(wait: true)` only when confidence is low
- The agent uses `terminal.capture(lines: -N)` for scrollback history access

---

## Issue: LLM Calling terminal.capture Unnecessarily

**Status:** Fixed (2025-12-19)

### Observed Behavior

The LLM calls `terminal.capture` after `terminal.run` even though `terminal.run` already returns output.

### Root Cause: System Prompt Gap

**The system prompt and tool definitions never tell the LLM that `terminal.run` returns output.**

1. **Tool examples only show input format** (lines 59-64):
   ```
   Tools:
   - {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
   - {"type":"tool_call","tool":"terminal.capture"}
   ```
   No mention of what the response contains.

2. **System prompt says `terminal.capture` is for getting output** (lines 78-81):
   ```
   - Use terminal.capture to get terminal screen output:
     - Add wait:true if a command might still be running...
   ```
   This is the ONLY place that describes how to "get terminal screen output."

3. **`terminal_run` description only mentions sending input** (line 136):
   ```
   description: "Send input to the persistent terminal (include \\n to press Enter)."
   ```
   No mention of returning output.

4. **`terminal_capture` description explicitly says "Get output"** (lines 165-167):
   ```
   description: "Get terminal screen output. Use to see TUI app content..."
   ```

### Why This Causes the Problem

The LLM reads:
- `terminal.run` = "send input"
- `terminal.capture` = "get output"

So it logically concludes: run a command → call capture to see what happened.

The LLM doesn't know that `terminal.run` already returns output until it sees the tool_result JSON, and even then it may not realize this is the standard behavior.

### Verification: Output IS Being Sent

Confirmed that output is included in tool results:
- `recordTerminalToolMessage` (line 986): `output: result.output`
- `conversation.push` (lines 314-322): `content: JSON.stringify(toolPayload)`
- `buildConversation` (line 476): `content: raw` (full JSON with output)

The output is definitely being sent to the LLM. The issue is purely that the system prompt doesn't document this.

### Fix Implemented (2025-12-19)

The system prompt and tool definitions were updated in `service/src/agent/agent-service.ts`:

1. **Updated `terminal_run` description** to mention it returns output:
   ```
   "Send input to the terminal and receive output. Returns: terminal output, readiness assessment, and context."
   ```

2. **Updated `terminal_capture` description** to clarify when to use it:
   ```
   "Capture terminal screen (for TUI apps, scrollback history, or waiting). NOT needed after terminal.run - output is already included."
   ```

3. **Added "Tool Responses" section** to system prompt explaining:
   - All tools return output, readiness, and context
   - "You do NOT need to call terminal.capture after terminal.run"
   - When to actually use terminal.capture

4. **Updated guidelines section** to reinforce the same message

---

*Created: 2025-12-19*
