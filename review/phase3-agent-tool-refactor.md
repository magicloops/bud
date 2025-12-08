# Phase 3 Review: Agent Tool Refactor

**Reviewed:** 2025-11-30
**Status:** ⚠️ MOSTLY COMPLETE (85%)
**Design Doc:** `plan/persistent-terminal.md` Section 12, Phase 3

---

## Scope

Phase 3 deliverables from design doc:
- [ ] Agent tools: terminal.run, terminal.observe, terminal.interrupt
- [ ] Tool handlers in backend
- [ ] Agent system prompt
- [ ] Integration with agent loop
- [ ] Readiness-driven decision making

---

## Implementation Review

### 1. Agent Tools ✅

**File:** `service/src/agent/agent-service.ts` (lines 71-124)

| Tool | Parameters | Returns | Implemented | Status |
|------|------------|---------|-------------|--------|
| `terminal.run` | `input: string, timeout_ms?: number` | `{output, readiness, lastLine, truncated}` | Lines 71-92 | ✅ |
| `terminal.observe` | `timeout_ms?: number` | `{output, readiness, lastLine, truncated}` | Lines 94-111 | ✅ |
| `terminal.interrupt` | none | `{output, readiness, lastLine, truncated}` | Lines 113-124 | ✅ |

**Tool Definitions (OpenAI function format):**
```typescript
{
  name: "terminal.run",
  description: "Send input to the persistent terminal",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string" },
      timeout_ms: { type: "integer", nullable: true }
    },
    required: ["input"]
  }
}
```

### 2. Tool Handlers ✅

**File:** `service/src/agent/agent-service.ts` (lines 814-874)

#### terminal.run Handler (Lines 851-873)
```typescript
const input = directive.input ?? directive.command ?? "";
await this.terminalManager.sendInput(budId, Buffer.from(input), { source: "agent" });
const readiness = await this.terminalManager.waitForReadiness(budId, timeoutMs);
const tail = await this.terminalManager.tailOutput(budId, backfillBytes);
return { output, readiness, lastLine, truncated, omittedLines: 0 };
```

#### terminal.observe Handler (Lines 836-849)
```typescript
const readiness = await this.terminalManager.waitForReadiness(budId, timeoutMs);
const tail = await this.terminalManager.tailOutput(budId, backfillBytes);
return { output, readiness, lastLine, truncated, omittedLines: 0 };
```

#### terminal.interrupt Handler (Lines 820-834)
```typescript
await this.terminalManager.sendInterrupt(budId);
const readiness = await this.terminalManager.waitForReadiness(budId, timeoutMs);
const tail = await this.terminalManager.tailOutput(budId, backfillBytes);
return { output, readiness, lastLine, truncated, omittedLines: 0 };
```

### 3. Readiness Integration ✅

**Readiness Flow:**
1. Tool handler calls `terminalManager.waitForReadiness(budId, timeoutMs)`
2. Polls in-memory cache every 100ms (lines 285-296 in terminal-manager.ts)
3. Returns assessment when timestamp advances or timeout
4. Assessment included in tool result to agent

**Readiness Assessment Structure:**
```typescript
{
  ready: boolean,
  confidence: number,        // 0.0-1.0
  trigger: "prompt_detected" | "quiescence" | "timeout",
  prompt_type?: "shell" | "python" | "node" | ...,
  hints: {
    looks_like_prompt: boolean,
    looks_like_confirmation: boolean,
    looks_like_password: boolean,
    looks_like_pager: boolean,
    looks_like_error: boolean,
    may_still_be_processing: boolean
  }
}
```

**Fallback Values (when Bud doesn't respond):**
| Tool | Fallback Readiness |
|------|-------------------|
| terminal.run | `{ready: true, confidence: 0.5, trigger: "quiescence"}` |
| terminal.observe | `{ready: false, confidence: 0.3, trigger: "observe"}` |
| terminal.interrupt | `{ready: true, confidence: 0.6, trigger: "interrupt"}` |

### 4. System Prompt ✅

**File:** `service/src/agent/agent-service.ts` (lines 53-67)

```
You are Bud Agent, coordinating terminal access to a user's machine.
Always produce STRICT JSON.

You have a persistent terminal; state (cwd, env, running processes)
persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.observe","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.interrupt"}

Guidelines:
- Include \\n to press Enter. For confirmations, send "y\\n".
  For single-key prompts (like q to exit pager), send just the key.
- Check readiness from tool results: if confidence < 0.5,
  observe before sending more input.
- Use interrupt if a command hangs or you need to stop it.
- When done, respond with {"type":"final","status":"succeeded",...}
```

**Coverage vs Design Doc:**

| Guidance | Design Doc | System Prompt | Status |
|----------|------------|---------------|--------|
| Newline handling | ✅ Include `\n` for Enter | ✅ | ✅ |
| Confidence interpretation | ✅ < 0.5 → observe | ✅ | ✅ |
| Interrupt usage | ✅ For stuck processes | ✅ | ✅ |
| Prompt types explained | ✅ Shell, Python, etc | ❌ Not detailed | ⚠️ |
| Hints usage | ✅ Use hints for decisions | ❌ Not mentioned | ⚠️ |

### 5. Agent Loop Integration ✅

**File:** `service/src/agent/agent-service.ts` (lines 195-281)

**Loop Flow:**
```
1. runAgentFlow() starts
2. invokeModel(conversation) → get Claude response
3. extractFunctionCall() → parse tool_call directive
4. executeTerminalCall() → run tool, get result with readiness
5. recordTerminalToolMessage() → store in DB
6. Add tool result to conversation
7. Loop: Claude sees readiness in next turn
8. Exit when Claude returns "final" directive
```

**Key Points:**
- Agent receives full readiness assessment in tool result
- Claude decides based on confidence (per system prompt instruction)
- No hardcoded logic; relies on Claude following instructions
- Max steps: `config.agentMaxSteps` (default 5)

### 6. Message Recording ✅

**File:** `service/src/agent/agent-service.ts` (lines 876-901)

```typescript
private async recordTerminalToolMessage(threadId, directive, result) {
  const payload = {
    tool: directive.tool,
    call_id: directive.callId,
    input: directive.input ?? directive.command ?? null,
    output: result.output,
    readiness: result.readiness,
    last_line: result.lastLine,
    truncated: result.truncated,
    omitted_lines: result.omittedLines
  };
  // Insert into messageTable with role: "tool"
}
```

### 7. Legacy Compatibility ⚠️

**File:** `service/src/agent/agent-service.ts`

**shell.run Still Exists:**
- Type includes `"shell.run"` (line 20)
- Alternative execution path (lines 721-812)
- Uses SessionManager instead of TerminalManager
- Returns `{exitCode, stdout, stderr}` - no readiness

**Conversation Reconstruction:**
- Lines 395-443 handle both terminal.* and shell.run in history
- Agent can work with mixed history

**Note:** Design doc says "maintain compatibility switch until stable" - this is implemented.

---

## Gaps & Issues

### ~~Gap 1: Fallback Readiness Missing Hints~~ ✅ FIXED

**Fixed 2025-11-30:** Added `DEFAULT_READINESS_HINTS` constant and `normalizeReadiness()` helper.
- All fallback readiness objects now include proper hints
- Added validation to ensure Bud responses also have hints (fills in defaults if missing)

### ~~Gap 2: output_bytes Not Returned~~ ✅ FIXED

**Fixed 2025-11-30:** Added `outputBytes` to `TerminalCallResult` type and all return paths.
- Now returns `{output, outputBytes, readiness, lastLine, truncated, omittedLines}`
- `outputBytes` reflects `tail.totalBytes` from terminal manager
- Also added to SSE event emission and message recording

### ~~Gap 3: System Prompt Missing Hint Details~~ ✅ FIXED

**Fixed 2025-11-30:** Enhanced system prompt with detailed hints guidance:
```
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
```

### ~~Gap 4: No Decision Logging~~ ✅ FIXED

**Fixed 2025-11-30:** Added `logReadinessDecision()` helper method that logs:
- Tool name, ready status, confidence, trigger
- Decision classification: `ready_to_proceed` (≥0.8), `probably_ready` (0.5-0.8), `should_observe` (<0.5)
- Active hints (only lists hints that are true)

---

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Agent can complete multi-step terminal tasks | ✅ |
| Agent handles confirmations correctly | ✅ |
| Agent uses observe() for long-running commands | ✅ (per system prompt) |
| Agent can interrupt stuck processes | ✅ |
| Readiness drives agent decisions | ✅ (via Claude) |
| Legacy shell.run still works | ✅ |

---

## File References

| File | Lines | Purpose |
|------|-------|---------|
| `service/src/agent/agent-service.ts` | 53-67 | System prompt |
| `service/src/agent/agent-service.ts` | 71-124 | Tool definitions |
| `service/src/agent/agent-service.ts` | 195-281 | Agent loop |
| `service/src/agent/agent-service.ts` | 814-874 | Tool handlers |
| `service/src/agent/agent-service.ts` | 876-901 | Message recording |
| `service/src/runtime/terminal-manager.ts` | 285-296 | waitForReadiness |
| `service/src/terminal/types.ts` | 90-106 | Readiness types |

---

## Verdict

**Phase 3: ✅ COMPLETE**

All functionality implemented and gaps addressed:
- All three terminal tools implemented (terminal.run, terminal.observe, terminal.interrupt)
- Readiness flows through to agent with proper hints
- System prompt provides detailed guidance on confidence thresholds and hints usage
- Agent loop integrates correctly with decision logging
- Legacy shell.run compatibility maintained
- output_bytes now included in results

**Fixed 2025-11-30:**
- Added DEFAULT_READINESS_HINTS and normalizeReadiness() for proper fallbacks
- Enhanced system prompt with hints documentation
- Added logReadinessDecision() for debugging agent behavior
- Added outputBytes to TerminalCallResult and all downstream paths
