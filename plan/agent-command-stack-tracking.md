# Agent Command Stack Tracking

**Date:** 2025-12-03
**Status:** ✅ Implemented
**Design:** `design/agent-terminal-context-awareness.md` (Approach 2)

## Overview

Implement command stack tracking to give the agent awareness of what program is currently running in the terminal. When the agent sends a command like `claude\n`, track it as "pending" until a shell prompt is detected, then pass this context to the agent in subsequent tool results.

## Goals

1. Agent knows when it's inside a REPL (claude, python, node, etc.)
2. Agent receives program-specific interaction guidance
3. No platform-specific dependencies (pure TypeScript/application-level)
4. Graceful degradation if detection fails

## Non-Goals

- Process introspection via tmux/proc (future Phase 2)
- Automatic REPL detection via output patterns (Approach 4)
- Explicit REPL mode declaration tools (Approach 3)

---

## Data Model

### PendingCommand

```typescript
interface PendingCommand {
  input: string;           // Raw input sent, e.g., "claude\n"
  command: string;         // Parsed command name, e.g., "claude"
  sentAt: number;          // Timestamp when sent
  source: "agent" | "user"; // Who sent this command
}
```

### TerminalContext

```typescript
interface TerminalContext {
  mode: "shell" | "repl" | "unknown";
  pendingCommand?: PendingCommand;
  programInfo?: ProgramInfo;
}

interface ProgramInfo {
  name: string;            // "claude", "python", "node"
  displayName: string;     // "Claude Code", "Python REPL"
  interactionStyle: "natural_language" | "code" | "sql" | "commands";
  exitCommands: string[];  // ["exit", "/exit"]
  hints: string[];         // Interaction guidance
}
```

### Known Programs Registry

```typescript
const KNOWN_PROGRAMS: Record<string, ProgramInfo> = {
  "claude": {
    name: "claude",
    displayName: "Claude Code",
    interactionStyle: "natural_language",
    exitCommands: ["exit", "/exit", "Ctrl+C"],
    hints: [
      "Use natural language requests, not shell commands",
      "Ask Claude to perform tasks: 'Please review src/main.rs'",
      "To run shell commands, ask Claude: 'Run npm test'",
      "Do NOT send raw shell commands - Claude will misinterpret them"
    ]
  },
  "python": {
    name: "python",
    displayName: "Python REPL",
    interactionStyle: "code",
    exitCommands: ["exit()", "quit()", "Ctrl+D"],
    hints: [
      "Send Python code, not shell commands",
      "Use print() to display output",
      "Multi-line input uses ... continuation prompt"
    ]
  },
  "python3": { /* same as python */ },
  "node": {
    name: "node",
    displayName: "Node.js REPL",
    interactionStyle: "code",
    exitCommands: [".exit", "Ctrl+D"],
    hints: [
      "Send JavaScript code, not shell commands",
      "Use console.log() for output"
    ]
  },
  "psql": {
    name: "psql",
    displayName: "PostgreSQL",
    interactionStyle: "sql",
    exitCommands: ["\\q"],
    hints: [
      "Send SQL commands",
      "Commands end with semicolon",
      "Meta-commands start with backslash (\\dt, \\d table)"
    ]
  },
  "mysql": {
    name: "mysql",
    displayName: "MySQL",
    interactionStyle: "sql",
    exitCommands: ["exit", "quit"],
    hints: [
      "Send SQL commands",
      "Commands end with semicolon"
    ]
  }
};
```

---

## Implementation Plan

### Phase 1: Track Pending Commands

**File:** `service/src/runtime/terminal-manager.ts`

#### 1.1 Add State

```typescript
export class TerminalManager {
  // Existing
  private readonly readiness = new Map<string, { assessment: unknown; updatedAt: number }>();
  private readonly lastOffsets = new Map<string, number>();

  // NEW: Track pending commands per terminal
  private readonly pendingCommands = new Map<string, PendingCommand | null>();
}
```

#### 1.2 Parse Command from Input

Add helper to extract command name from input:

```typescript
private parseCommandFromInput(input: string): string | null {
  // Remove trailing newline and whitespace
  const trimmed = input.replace(/[\r\n]+$/, '').trim();
  if (!trimmed) return null;

  // Extract first word (the command)
  const firstWord = trimmed.split(/\s+/)[0];
  if (!firstWord) return null;

  // Handle common patterns:
  // - "claude" -> "claude"
  // - "./script.sh" -> "script.sh"
  // - "/usr/bin/python" -> "python"
  // - "python3 script.py" -> "python3"
  const basename = firstWord.split('/').pop() || firstWord;
  return basename.replace(/^\.\//, '');
}
```

#### 1.3 Track on sendInput

Modify `sendInput()` to track command when sent from shell context:

```typescript
async sendInput(
  budId: string,
  data: Buffer,
  opts: { source: "agent" | "user"; awaitReady?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const inputStr = data.toString('utf-8');

  // Only track if we're currently in shell mode (no pending command)
  // and input contains a newline (actually executing something)
  if (!this.pendingCommands.get(budId) && inputStr.includes('\n')) {
    const command = this.parseCommandFromInput(inputStr);
    if (command && this.isKnownReplProgram(command)) {
      this.pendingCommands.set(budId, {
        input: inputStr,
        command,
        sentAt: Date.now(),
        source: opts.source
      });
      this.debug("tracking pending command", { budId, command });
    }
  }

  // ... existing sendInput logic ...
}

private isKnownReplProgram(command: string): boolean {
  return command in KNOWN_PROGRAMS;
}
```

#### 1.4 Clear on Shell Return

Modify `storeReadiness()` to clear pending command when shell prompt detected:

```typescript
storeReadiness(budId: string, assessment: ReadinessAssessment): void {
  this.readiness.set(budId, { assessment, updatedAt: Date.now() });

  // Clear pending command if we're back at a shell prompt
  if (
    assessment.prompt_type === "shell" &&
    assessment.confidence >= 0.8 &&
    assessment.hints?.looks_like_prompt
  ) {
    const pending = this.pendingCommands.get(budId);
    if (pending) {
      this.debug("clearing pending command - returned to shell", {
        budId,
        command: pending.command,
        durationMs: Date.now() - pending.sentAt
      });
      this.pendingCommands.set(budId, null);
    }
  }
}
```

#### 1.5 Expose Context Getter

```typescript
getTerminalContext(budId: string): TerminalContext {
  const pending = this.pendingCommands.get(budId);

  if (!pending) {
    return { mode: "shell" };
  }

  const programInfo = KNOWN_PROGRAMS[pending.command];
  return {
    mode: programInfo ? "repl" : "unknown",
    pendingCommand: pending,
    programInfo
  };
}
```

---

### Phase 2: Pass Context to Agent

**File:** `service/src/agent/agent-service.ts`

#### 2.1 Include Context in Tool Results

Modify `executeTerminalCall()` to include context:

```typescript
async executeTerminalCall(threadId: string, directive: AgentDirective): Promise<TerminalCallResult> {
  // ... existing logic to send input and get output ...

  // Get terminal context
  const context = this.terminalManager.getTerminalContext(budId);

  return {
    output: decoded,
    outputBytes: tail.totalBytes,
    readiness: normalizedReadiness,
    lastLine,
    truncated: tail.truncated,
    omittedLines: 0,
    // NEW: Include context
    context: {
      mode: context.mode,
      program: context.programInfo?.name,
      programDisplayName: context.programInfo?.displayName,
      interactionStyle: context.programInfo?.interactionStyle,
      hints: context.programInfo?.hints
    }
  };
}
```

#### 2.2 Update TerminalCallResult Type

```typescript
type TerminalCallResult = {
  output: string;
  outputBytes: number;
  readiness: Record<string, unknown>;
  lastLine: string;
  truncated: boolean;
  omittedLines: number;
  // NEW
  context?: {
    mode: "shell" | "repl" | "unknown";
    program?: string;
    programDisplayName?: string;
    interactionStyle?: string;
    hints?: string[];
  };
};
```

---

### Phase 3: Enhance System Prompt

**File:** `service/src/agent/agent-service.ts`

#### 3.1 Add Context-Aware Section to System Prompt

Update `SYSTEM_PROMPT` to reference context:

```typescript
const SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.observe","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.interrupt"}

Guidelines:
- Include \\n to press Enter. For confirmations, send "y\\n". For single-key prompts (like q to exit pager), send just the key.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.observe to wait
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
- Use interrupt if a command hangs or you need to stop it.

CONTEXT AWARENESS:
- Tool results include a "context" field indicating what program is running
- When context.mode is "repl", you are INSIDE an interactive program, NOT at a shell
- When context.program is "claude" (Claude Code):
  * Use natural language requests, not shell commands
  * Ask Claude to perform tasks: "Please review src/main.rs for bugs"
  * Do NOT send shell syntax like "cat file.txt" - that becomes a request to Claude
  * To exit, send "exit\\n" or use terminal.interrupt
- When context.program is "python" or "node":
  * Send code in that language, not shell commands
  * Use the language's print/console.log for output
- Always check context.hints for program-specific guidance

- When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
`.trim();
```

---

### Phase 4: Handle Edge Cases

#### 4.1 User Input Clears Context

When user sends input (not agent), they may exit a REPL manually. We should be conservative:

```typescript
async sendInput(budId, data, opts) {
  // If user sends input while in REPL, they might be exiting
  // Don't clear immediately, but mark for potential clear on next shell prompt
  if (opts.source === "user") {
    const pending = this.pendingCommands.get(budId);
    if (pending) {
      // Check if input looks like an exit command
      const inputStr = data.toString('utf-8').trim();
      const programInfo = KNOWN_PROGRAMS[pending.command];
      if (programInfo?.exitCommands.some(cmd => inputStr.startsWith(cmd))) {
        this.debug("user sent exit command", { budId, command: pending.command, input: inputStr });
        // Don't clear yet - wait for shell prompt confirmation
      }
    }
  }
  // ... rest of sendInput
}
```

#### 4.2 Timeout Stale Commands

Add cleanup for commands that have been pending too long:

```typescript
private readonly STALE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

private cleanupStaleCommands(): void {
  const now = Date.now();
  for (const [budId, pending] of this.pendingCommands) {
    if (pending && now - pending.sentAt > this.STALE_COMMAND_TIMEOUT_MS) {
      this.logger.warn({ budId, command: pending.command }, "clearing stale pending command");
      this.pendingCommands.set(budId, null);
    }
  }
}
```

#### 4.3 Interrupt Clears Context

When interrupt is sent, the REPL likely exits:

```typescript
async sendInterrupt(budId: string): Promise<{ ok: boolean; error?: string }> {
  // ... existing interrupt logic ...

  // Clear pending command - interrupt usually exits REPLs
  const pending = this.pendingCommands.get(budId);
  if (pending) {
    this.debug("clearing pending command due to interrupt", { budId, command: pending.command });
    this.pendingCommands.set(budId, null);
  }

  return { ok: true };
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/runtime/terminal-manager.ts` | Add pendingCommands tracking, parseCommand, getTerminalContext |
| `service/src/agent/agent-service.ts` | Include context in tool results, update system prompt |
| `service/src/terminal/types.ts` | Add PendingCommand, TerminalContext, ProgramInfo types |

## New Files

| File | Purpose |
|------|---------|
| `service/src/terminal/known-programs.ts` | KNOWN_PROGRAMS registry |

---

## Testing Plan

### Manual Tests

1. **Claude Code detection**:
   - Send `claude\n` via agent
   - Verify context shows `mode: "repl", program: "claude"`
   - Verify hints include Claude-specific guidance
   - Send `exit\n`, verify context returns to `mode: "shell"`

2. **Python REPL detection**:
   - Send `python3\n` via agent
   - Verify context shows `mode: "repl", program: "python3"`
   - Send `exit()\n`, verify returns to shell

3. **User exit handling**:
   - Agent starts `claude`
   - User manually types `exit` in terminal
   - Verify context clears when shell prompt detected

4. **Interrupt handling**:
   - Agent starts `node`
   - Agent sends `terminal.interrupt`
   - Verify context clears

### Unit Tests

```typescript
describe("TerminalManager command tracking", () => {
  it("tracks known REPL commands", () => {
    manager.sendInput(budId, Buffer.from("claude\n"), { source: "agent" });
    const ctx = manager.getTerminalContext(budId);
    expect(ctx.mode).toBe("repl");
    expect(ctx.programInfo?.name).toBe("claude");
  });

  it("ignores unknown commands", () => {
    manager.sendInput(budId, Buffer.from("ls -la\n"), { source: "agent" });
    const ctx = manager.getTerminalContext(budId);
    expect(ctx.mode).toBe("shell");
  });

  it("clears on shell prompt", () => {
    manager.sendInput(budId, Buffer.from("python\n"), { source: "agent" });
    manager.storeReadiness(budId, { prompt_type: "shell", confidence: 0.9, hints: { looks_like_prompt: true } });
    const ctx = manager.getTerminalContext(budId);
    expect(ctx.mode).toBe("shell");
  });
});
```

---

## Rollout Plan

1. **Implement Phase 1-2** (tracking + tool results) - low risk, additive
2. **Test manually** with Claude Code, python, node
3. **Implement Phase 3** (system prompt) - higher impact on agent behavior
4. **Monitor agent logs** for context decisions
5. **Iterate on KNOWN_PROGRAMS** based on real usage

---

## Future Enhancements

- **Phase 2 (Hybrid)**: Add process introspection from Bud for ground truth
- **Nested contexts**: Handle shell-in-REPL scenarios (Claude Code running shell commands)
- **Context history**: Track sequence of context changes for debugging
- **UI indicator**: Show current terminal context in web UI
