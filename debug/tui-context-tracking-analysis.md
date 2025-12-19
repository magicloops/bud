# Debug: TUI Application Context Tracking Analysis

## Problem Statement

The Bud Agent can become confused about whether it's inside a TUI application (like Claude Code) or at a shell prompt. This leads to the agent sending inappropriate commands:

- **In Claude Code but thinks it's at shell**: Agent sends shell commands like `ls -la` which Claude Code interprets as a natural language request
- **At shell but thinks it's in Claude Code**: Agent sends natural language requests which the shell tries to execute as commands

**Trigger scenarios**:
1. User manually exits Claude Code (types "exit" or `/exit`)
2. Claude Code crashes or is killed
3. Terminal session is closed and a new one is created
4. Shell prompt detection fails (unusual prompt format)
5. Network reconnection causes state desync

---

## Current Implementation

### How Context Tracking Works

The system uses a **command-based tracking** approach in `TerminalSessionManager`:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User/Agent sends input containing known REPL program name + newline    │
│  e.g., "claude\n"                                                       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  parseCommandFromInput() extracts "claude"                              │
│  isKnownReplProgram("claude") → true                                    │
│  pendingCommands.set(sessionId, { command: "claude", ... })             │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  All subsequent tool results include context:                            │
│  { mode: "repl", program: "claude", programDisplayName: "Claude Code" } │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Context cleared when:                                                   │
│  1. handleTerminalReady() receives prompt_type="shell" with conf >= 0.8  │
│  2. terminal.interrupt is sent (assumes Ctrl+C exits REPL)               │
│  3. 30 minutes timeout (STALE_COMMAND_TIMEOUT_MS)                        │
│  4. Session is closed                                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `service/src/runtime/terminal-session-manager.ts` | Tracks `pendingCommands` Map, provides `getSessionContext()` |
| `service/src/terminal/known-programs.ts` | Registry of known REPL programs (claude, python, node, etc.) |
| `service/src/agent/agent-service.ts` | Includes context in tool results, system prompt guides agent behavior |
| `bud/src/main.rs` | Readiness detection, shell prompt detection (`detect_prompt()`) |

### Where Context is Passed

1. **System Prompt** (`agent-service.ts:54-117`): Instructs agent how to interpret context
2. **Tool Results** (`agent-service.ts:876-884`): Every tool result includes `context` field
3. **Message Storage** (`agent-service.ts:957-985`): Context persisted in message metadata

### Shell Prompt Detection (Bud Daemon)

The `detect_prompt()` function in `main.rs:1532-1542` looks for:

```rust
// Shell prompts - clears REPL context
if line.ends_with('$') || line.ends_with('#') || line.ends_with('%') || line.contains(":~$")
    → prompt_type: "shell", confidence: 0.95

// Python prompts - does NOT clear Claude Code context
if line.starts_with(">>>") || line.starts_with("...")
    → prompt_type: "python", confidence: 0.95
```

---

## Failure Modes

### 1. User Manually Exits Claude Code

**Scenario**: User types "exit" or `/exit` in Claude Code

**What happens**:
- Input "exit\n" is sent through `sendInput()`
- Claude Code exits, shell prompt appears
- Bud daemon detects shell prompt, sends `terminal_ready` with `prompt_type: "shell"`
- Service should clear `pendingCommands` in `handleTerminalReady()`

**Why it might fail**:
- Shell prompt detection regex doesn't match (unusual shell, custom prompt)
- `terminal_ready` message lost/delayed during network issues
- Confidence < 0.8 so clearing condition not met

### 2. Claude Code Crashes

**Scenario**: Claude Code crashes or is killed externally

**What happens**:
- No "exit" command sent
- Shell prompt appears immediately
- Same detection path as #1

**Why it might fail**:
- Same reasons as #1
- Additionally, no user input to trigger readiness check

### 3. Session Replaced

**Scenario**: Session is closed and new one created (idle timeout, manual close, reconnect)

**What happens**:
- `closeSession()` calls `clearSessionCache(sessionId)`
- This deletes from `pendingCommands` Map
- New session has no pending command

**Why it might fail**:
- If session ID changes but `clearSessionCache()` isn't called properly
- Memory state and DB state get out of sync

### 4. Unusual Shell Prompt

**Scenario**: User has custom shell prompt that doesn't match detection patterns

**What happens**:
- User exits Claude Code
- Shell prompt appears but isn't recognized
- `terminal_ready` has `prompt_type: null`, clearing condition not met

**Example undetected prompts**:
- `λ ` (Powerline/custom)
- `❯ ` (Starship)
- `user@host➜ ~/dir` (oh-my-zsh)
- `(venv) user@host $` (may work due to trailing $)

### 5. Agent Never Sees Updated Context

**Scenario**: Context updated but agent doesn't receive it

**What happens**:
- `pendingCommands` cleared correctly
- But agent's in-memory conversation history still contains old tool results with `mode: "repl"`
- Agent may continue behaving as if in REPL

**Note**: This is less of an issue because each tool call returns fresh context.

---

## Why Previous Approaches Are Insufficient

Before exploring better solutions, let's understand why the initial options fall short:

| Option | Why It Fails |
|--------|--------------|
| **Exit Command Detection** | Too narrow. Users exit via Ctrl+C, Ctrl+D, kill, crashes, new sessions. Explicit "exit" is minority case. |
| **Regex Shell Detection** | Brittle. Custom prompts are infinite (Starship, Powerline, oh-my-zsh). False positives risk is high. |
| **Timeout Reduction** | Still reactive. 5 minutes is long enough for many confused interactions. |
| **User Reset** | Bad UX. Users shouldn't need to manage agent's internal state. |

**The fundamental problem**: We're trying to *infer* terminal state from *input commands* and *output patterns*, when we should be *showing the LLM the actual screen* and letting it determine context.

---

## Proposed Solutions (LLM-Based)

### Option 6: Inline Screen Snapshot (Recommended)

**Approach**: Include last N lines (5-10) from `capture-pane` in every tool result. The LLM sees actual terminal state and determines context itself.

**Philosophy**: "Show, don't tell" - instead of inferring context and telling the LLM, we show it ground truth.

#### What Different States Look Like

```
┌─────────────────────────────────────────────────────────────────────┐
│ CLAUDE CODE ACTIVE                                                  │
├─────────────────────────────────────────────────────────────────────┤
│ ╭─ Claude ──────────────────────────────────────────────────────╮   │
│ │ I'll help you with that. Let me check the file structure...   │   │
│ ╰───────────────────────────────────────────────────────────────╯   │
│ >                                                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ SHELL PROMPT                                                        │
├─────────────────────────────────────────────────────────────────────┤
│ user@hostname:~/project$ npm test                                   │
│ > myproject@1.0.0 test                                              │
│ > jest                                                              │
│ PASS src/test.ts                                                    │
│ user@hostname:~/project$                                            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ PYTHON REPL                                                         │
├─────────────────────────────────────────────────────────────────────┤
│ >>> x = 5                                                           │
│ >>> print(x)                                                        │
│ 5                                                                   │
│ >>>                                                                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ VIM / EDITOR                                                        │
├─────────────────────────────────────────────────────────────────────┤
│   1 def main():                                                     │
│   2     print("hello")                                              │
│ ~                                                                   │
│ ~                                                                   │
│ :w                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

These are visually distinct - any capable LLM can distinguish them instantly.

#### Implementation

```typescript
// In executeTerminalCall(), after getting output:
const screenCapture = await this.terminalSessionManager.capturePane(sessionId, {
  startLine: -10,  // Last 10 lines
  joinLines: true
});

return {
  output: decoded,
  outputBytes,
  readiness: finalReadiness,
  lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
  truncated,
  omittedLines: 0,
  context: getContext(),  // Keep as hint, may be stale
  screenSnapshot: screenCapture.output  // NEW: Ground truth
};
```

#### System Prompt Update

```markdown
TERMINAL STATE VISIBILITY:
Tool results include a "screenSnapshot" field showing the last 10 lines of the terminal.
This is GROUND TRUTH - use it to understand actual terminal state:

- Shell prompt: Line ends with $, #, %, ❯, or similar. Send shell commands.
- Claude Code: Shows ">" prompt with Claude branding/output style. Use natural language.
- Python REPL: Shows ">>>" or "..." prompts. Send Python code.
- Editor (vim/nano): Shows line numbers, ~ for empty lines. Use editor commands.

The "context" field contains our tracking-based guess which MAY BE STALE.
If screenSnapshot and context disagree, TRUST THE SCREEN.
```

#### Cost Analysis

| Metric | Value |
|--------|-------|
| Lines per snapshot | 10 |
| Tokens per line | ~10 |
| Tokens per tool result | ~100 |
| Tool calls per agent run | ~10 |
| Extra tokens per run | ~1000 |
| Cost at Claude Opus ($15/M) | ~$0.015 |
| Cost at Claude Haiku ($0.25/M) | ~$0.00025 |

**Verdict**: Negligible cost increase.

#### Latency Analysis

| Operation | Time |
|-----------|------|
| `tmux capture-pane` | 10-50ms |
| Already calling for REPL mode | 0 (existing) |
| Network overhead | ~5ms |

**Verdict**: Minimal latency. Already calling capture-pane for REPL context.

#### Advantages

- **Self-correcting**: Agent sees reality, can't be confused
- **Universal**: Works for ANY program, not just registered ones
- **No false positives**: LLM understands nuance human regex can't
- **Simple**: Just include data, remove complex inference logic
- **Zero additional LLM calls**: Uses main agent's intelligence

#### Disadvantages

- Slightly more tokens per tool result (~100)
- Relies on main LLM's visual understanding
- Screen content may be ambiguous (rare)

#### Code Changes Required

1. `agent-service.ts:executeTerminalCall()` - Add capture and include in result
2. `agent-service.ts:SYSTEM_PROMPT` - Add screen visibility guidance
3. `agent-service.ts:recordTerminalToolMessage()` - Include screenSnapshot in payload
4. Optionally: Simplify/remove `pendingCommands` tracking (keep as hint)

---

### Option 7: Dedicated Context Analysis LLM

**Approach**: Use a separate, smaller LLM call to analyze terminal screen and return structured context. The main agent receives this analysis rather than raw screen content.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ After each tool call or before agent turn:                          │
│                                                                     │
│  capture-pane (30 lines)                                            │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Context Analyzer (Haiku / GPT-4o-mini)                      │    │
│  │                                                             │    │
│  │ Prompt: "Analyze this terminal. What's running? What        │    │
│  │          input does it expect? Return JSON."                │    │
│  │                                                             │    │
│  │ Input: Last 30 lines of screen                              │    │
│  │ Output: { mode, program, waitingForInput, inputType }       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│         │                                                           │
│         ▼                                                           │
│  Tool result includes structured context (not raw screen)           │
└─────────────────────────────────────────────────────────────────────┘
```

#### Structured Output

```typescript
interface TerminalContextAnalysis {
  mode: "shell" | "repl" | "tui" | "editor" | "pager" | "unknown";
  program?: string;           // "bash", "python", "claude", "vim"
  programVersion?: string;    // "Python 3.11.0"
  waitingForInput: boolean;
  inputType?: "command" | "code" | "text" | "password" | "confirmation" | "key";
  confidence: number;         // 0.0 - 1.0
  reasoning: string;          // Brief explanation
}
```

#### Implementation

```typescript
class ContextAnalyzer {
  private cache = new Map<string, { analysis: TerminalContextAnalysis; timestamp: number }>();
  private readonly CACHE_TTL_MS = 5000;  // 5 second cache

  async analyze(sessionId: string, screenContent: string): Promise<TerminalContextAnalysis> {
    // Check cache first
    const cached = this.cache.get(sessionId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.analysis;
    }

    const response = await this.llm.invokeSync(
      [
        { role: "system", content: CONTEXT_ANALYSIS_PROMPT },
        { role: "user", content: `Terminal screen:\n\`\`\`\n${screenContent}\n\`\`\`` }
      ],
      [],  // No tools
      { model: "claude-haiku-4-5", maxOutputTokens: 200, responseFormat: "json" }
    );

    const analysis = JSON.parse(response.content[0].text);
    this.cache.set(sessionId, { analysis, timestamp: Date.now() });
    return analysis;
  }
}
```

#### Context Analysis Prompt

```markdown
Analyze this terminal screen and determine the current state.

Return JSON with:
- mode: "shell" | "repl" | "tui" | "editor" | "pager" | "unknown"
- program: Name of the active program (e.g., "bash", "python", "claude", "vim")
- waitingForInput: Is the terminal waiting for user input?
- inputType: What type of input is expected?
  - "command": Shell command
  - "code": Programming code (REPL)
  - "text": Natural language or free text
  - "password": Password prompt (won't echo)
  - "confirmation": y/n or yes/no
  - "key": Single keypress (pager, editor)
- confidence: 0.0-1.0 how sure you are
- reasoning: One sentence explaining your determination

Be especially careful to distinguish:
- Shell prompts (ending in $, #, %, ❯) from program output
- Claude Code (TUI with natural language prompt) from regular shell
- REPLs (>>>, In[], etc.) from shell
```

#### Cost Analysis

| Metric | Value |
|--------|-------|
| Lines analyzed | 30 |
| Input tokens | ~300 |
| Output tokens | ~50 |
| Cost at Haiku ($0.25/$1.25/M) | ~$0.00014 |
| Calls per agent run | ~10 (with caching, maybe 2-3 actual) |
| Cost per run (with cache) | ~$0.0003-0.001 |

**Verdict**: Extremely cheap (~$0.001 per agent run).

#### Latency Analysis

| Component | Time |
|-----------|------|
| capture-pane | 10-50ms |
| Haiku inference | 200-500ms |
| **Total added** | **~250-550ms per uncached call** |
| With 5s cache | Often 0ms |

**Verdict**: Noticeable but acceptable, especially with caching.

#### Advantages

- **Sophisticated analysis**: More context (30 lines), dedicated reasoning
- **Structured output**: Easy to integrate, predictable
- **Separation of concerns**: Context detection isolated from task execution
- **Cacheable**: Terminal state doesn't change rapidly
- **Tunable**: Can adjust prompt, model, thresholds independently
- **Cheaper model**: Main agent can be Opus, context analyzer is Haiku

#### Disadvantages

- Additional latency (~200-500ms per uncached call)
- Another potential failure point
- More infrastructure (new service/class)
- Cache invalidation complexity
- Two LLMs must agree on context interpretation

#### When to Use

Best suited for:
- High-stakes operations where context accuracy is critical
- When main LLM is very expensive (Opus) and you want to offload
- When you need structured context for UI display, logging, etc.
- Complex TUI applications beyond simple shell/REPL detection

---

### Option 6 vs Option 7 Comparison

| Aspect | Option 6 (Inline) | Option 7 (Dedicated LLM) |
|--------|-------------------|--------------------------|
| **Latency** | ~0ms | +200-500ms (uncached) |
| **Cost** | ~$0.015/run | ~$0.001/run |
| **Accuracy** | High (main LLM) | High (specialized prompt) |
| **Complexity** | Low | Medium |
| **Failure modes** | LLM misreads | LLM fails, cache stale |
| **Structured output** | No (LLM interprets) | Yes (JSON schema) |
| **Works offline** | N/A | No (needs LLM) |
| **Cacheable** | No | Yes (5s TTL) |

---

### Option 8: Hybrid Approach

**Approach**: Combine both strategies for maximum robustness.

1. **Always include screen snapshot** (Option 6) - Ground truth available
2. **Add lightweight heuristic hints** - Fast, no LLM needed
3. **Optionally trigger dedicated analysis** - When heuristics are uncertain

```typescript
// In tool result
{
  output: "...",
  screenSnapshot: "last 10 lines",  // Always present
  contextHint: {
    mode: "shell",                  // Fast heuristic guess
    confidence: 0.7,
    source: "heuristic"
  },
  contextAnalysis?: {               // Present if heuristic was uncertain
    mode: "shell",
    program: "zsh",
    waitingForInput: true,
    confidence: 0.95,
    source: "llm_analysis"
  }
}
```

**Decision Logic**:
```typescript
if (heuristicConfidence >= 0.9) {
  // High confidence, skip LLM analysis
  return { contextHint };
} else {
  // Uncertain, call dedicated analyzer
  const analysis = await contextAnalyzer.analyze(screenSnapshot);
  return { contextHint, contextAnalysis: analysis };
}
```

#### Advantages

- Best of both worlds
- Optimizes for common cases (high confidence = fast)
- Falls back to sophisticated analysis when needed
- Agent always has screen snapshot as ground truth

#### Disadvantages

- Most complex to implement
- Multiple code paths to maintain

---

## Recommendation

### Phase 1: Implement Option 6 (Inline Screen Snapshot)

**Why start here**:
1. Simplest to implement (~50 lines of code)
2. No additional latency
3. Leverages main LLM's intelligence (which is already smart)
4. Self-correcting by design
5. Can always add Option 7 later if needed

**Implementation steps**:
1. Add `capturePane()` call in `executeTerminalCall()` for all modes (not just REPL)
2. Include `screenSnapshot` in tool result payload
3. Update system prompt with screen visibility guidance
4. Keep `pendingCommands` tracking as a fallback hint
5. Test with various terminal states (shell, Claude Code, Python, vim, etc.)

### Phase 2: Evaluate and Iterate

After deploying Phase 1, monitor:
- Does agent correctly interpret screen content?
- Any cases where it misreads state?
- Token usage acceptable?

### Phase 3 (If Needed): Add Option 7

If Phase 1 shows weaknesses:
- Add `ContextAnalyzer` service
- Trigger on uncertainty or periodically
- Cache results for efficiency

---

## Implementation Plan for Option 6

### File Changes

#### 1. `agent-service.ts` - executeTerminalCall()

```typescript
// After line 856 (end of shell mode output handling)
// Add screen capture for ALL modes:

const screenCapture = await this.terminalSessionManager.capturePane(sessionId, {
  startLine: -10,
  joinLines: true
}, 2000);  // 2 second timeout

return {
  output: decoded,
  outputBytes,
  readiness: finalReadiness,
  lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
  truncated,
  omittedLines: 0,
  context,
  screenSnapshot: screenCapture.output  // NEW
};
```

#### 2. `agent-service.ts` - SYSTEM_PROMPT

Add after "CONTEXT AWARENESS (CRITICAL)":

```typescript
SCREEN VISIBILITY (GROUND TRUTH):
Tool results include "screenSnapshot" showing the actual terminal screen (last 10 lines).
USE THIS to verify terminal state:
- If you see "$", "#", "%", or "❯" at line end → Shell prompt, send commands
- If you see ">" with Claude-style output boxes → Claude Code, use natural language
- If you see ">>>" or "In[N]:" → Python/IPython REPL, send Python code
- If you see line numbers and ~ → Editor (vim/nano), use editor commands

The "context" field is our TRACKING-BASED GUESS which may be STALE.
If screenSnapshot shows something different, TRUST THE SCREEN.
```

#### 3. `agent-service.ts` - TerminalCallResult type

```typescript
type TerminalCallResult = {
  output: string;
  outputBytes: number;
  readiness: Record<string, unknown>;
  lastLine: string;
  truncated: boolean;
  omittedLines: number;
  context?: { ... };
  screenSnapshot: string;  // NEW
};
```

#### 4. `agent-service.ts` - recordTerminalToolMessage()

Include `screenSnapshot` in the recorded payload.

---

## Test Scenarios

After implementing Option 6 (Inline Screen Snapshot), verify these scenarios:

### Critical Scenarios

| Scenario | Screen Shows | Expected Agent Behavior |
|----------|--------------|------------------------|
| At shell prompt | `user@host:~$` | Sends shell commands |
| In Claude Code | `> ` with Claude UI | Uses natural language |
| Exit Claude Code normally | Shell prompt returns | Recognizes shell from screen |
| Claude Code crashes | Shell prompt appears | Recognizes shell from screen |
| In Python REPL | `>>> ` | Sends Python code |
| In vim | Line numbers, `~` | Uses vim commands |
| In pager (less) | `:` at bottom | Sends `q` or space |
| Custom shell prompt (❯) | `❯ ` | Recognizes as shell |
| New tmux session | Fresh shell prompt | Recognizes shell |

### Edge Cases

| Scenario | Potential Issue | Expected Handling |
|----------|-----------------|-------------------|
| Screen has `$` in output (not prompt) | False positive | LLM sees context, understands it's output |
| Claude Code shows shell command in output | Confusion | LLM sees Claude UI frame, knows it's still in Claude |
| Very long output scrolls prompt off screen | Missing prompt | LLM uses other visual cues |
| Split tmux panes | Wrong pane captured | May need to handle - future work |

### Manual Testing Script

```bash
# 1. Start in shell, verify agent sends shell commands
send_message "List files in current directory"
# Expected: Agent sends "ls\n" or similar

# 2. Start Claude Code
send_message "Start Claude Code"
# Agent sends "claude\n"

# 3. Verify agent uses natural language in Claude Code
send_message "Ask Claude to check the current directory"
# Expected: Agent sends natural language, not "ls"

# 4. Exit Claude Code manually (simulate user)
tmux send-keys "exit" Enter

# 5. Send another message, verify agent recognizes shell
send_message "What's in the home directory"
# Expected: Agent sends shell command, recognizes shell from screen
```

---

## Related Code References

### Current Implementation
- `terminal-session-manager.ts:296-308` - Input command tracking (`pendingCommands`)
- `terminal-session-manager.ts:549-568` - Shell prompt detection clearing
- `terminal-session-manager.ts:627-651` - `getSessionContext()` returning context
- `terminal-session-manager.ts:793-839` - `capturePane()` implementation
- `known-programs.ts:21-33` - Claude Code program info
- `agent-service.ts:54-117` - System prompt context awareness section
- `agent-service.ts:684-885` - `executeTerminalCall()` where changes needed
- `main.rs:1532-1542` - Bud daemon prompt detection

### Files to Modify (Option 6)
- `service/src/agent/agent-service.ts` - Main changes
- `service/src/agent/agent.spec.md` - Update spec if exists

### Optional Future Files (Option 7)
- `service/src/terminal/context-analyzer.ts` - New file
- `service/src/terminal/terminal.spec.md` - Update spec

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-12-16 | Analyzed current implementation | Found command-based tracking is fragile |
| 2025-12-16 | Rejected regex-based detection | Too brittle for custom prompts |
| 2025-12-16 | Rejected exit command detection | Too narrow, misses crashes/kills |
| 2025-12-16 | Proposed Option 6 (Inline Screen Snapshot) | Simple, self-correcting, no latency |
| 2025-12-16 | Proposed Option 7 (Dedicated LLM) | More sophisticated, adds latency |
| 2025-12-16 | **Recommended: Start with Option 6** | Simplest path to robust solution |

---

## Open Questions

1. **Should we remove `pendingCommands` tracking entirely?**
   - Pros: Simpler code, no stale state
   - Cons: Useful for activity-based vs quiescence-based readiness detection
   - Recommendation: Keep as hint, but don't rely on it for context

2. **What if capture-pane fails?**
   - Fall back to existing context tracking
   - Log warning for debugging
   - Agent still gets `output` field with pipe-pane data

3. **How many lines should we capture?**
   - 10 lines: Usually enough, minimal tokens
   - 20 lines: More context, useful for scrolled prompts
   - Recommendation: Start with 10, increase if needed

4. **Should we capture for every tool call or just terminal.run?**
   - Every call: Most consistent, agent always has screen
   - Just terminal.run: Saves tokens when using terminal.capture
   - Recommendation: Every call for consistency

---

*Generated: 2025-12-16*
*Updated: 2025-12-16 - Added LLM-based approaches (Options 6, 7, 8)*
