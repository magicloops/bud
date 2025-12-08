# Debug: Claude-in-Terminal Context Loss

_Created: 2025-12-05_

## Problem

When Claude Code is running in the terminal and our OpenAI-based agent interacts with it, the agent loses context of the fact that Claude is still "thinking" or processing. This causes the agent to send commands that get misinterpreted.

## Evidence

User asks the agent for a haiku summarizing a debug file. The expected flow:

```
1. Agent sends request to Claude Code
2. Claude Code reads the file and outputs a haiku
3. Agent sees haiku and responds to user
```

Actual flow:

```
1. Agent sends request to Claude Code
2. Claude Code reads file, outputs haiku
3. Readiness detection fires (quiescence)
4. Agent sees output, but also sees Claude's ">" prompt
5. Agent decides to run "ls -lt debug | head -n 2" for some reason
6. This command is sent to Claude Code (not the shell!)
7. Claude Code interprets it as a new request and runs it
8. Agent sees more output, gets confused
```

Terminal output showing the problem:
```
> Please locate the most recent file in debug/ and summarize it as a haiku.

⏺ Bash(ls -lt debug/ | head -5)
  ⎿  total 496...

⏺ Read(debug/capture-pane-dedup-failure.md)
  ⎿  Read 228 lines

> /bin/bash -lc 'ls -lt debug | head -n 2'   ← THIS WAS SENT BY OPENAI AGENT

⏺ Captures change too fast—
  timestamps shift, matching fails—
  hash alone stays true.

⏺ Bash(ls -lt debug | head -n 2)             ← CLAUDE INTERPRETED IT AS A REQUEST
```

---

## Root Cause Analysis

### Current Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   OpenAI API    │ ←── │  Bud Service    │ ←── │  Bud (Rust)     │
│ (Responses API) │     │  (TypeScript)   │     │  + tmux/Claude  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                       │
         │  Sees terminal       │  Tracks context       │  Readiness
         │  output + context    │  (shell vs repl)      │  detection
         │                      │                       │  (quiescence)
```

### Why Context Is Lost

1. **Readiness is quiescence-based**: We wait for 1.5s of no output, then declare "ready"

2. **Claude Code has natural pauses**: When Claude is thinking, running tools, or between steps, there are gaps >1.5s where no output is produced

3. **OpenAI doesn't understand "processing"**: The agent sees the terminal output and `context.mode = "repl"` + `context.program = "claude"`, but doesn't know if Claude is mid-task

4. **The ">" prompt is misleading**: Claude Code shows `>` at the bottom even while processing (it's a TUI input field, not a "ready" indicator)

### The Core Issue

**We have no reliable signal for "Claude Code is still processing".**

The quiescence detection was designed for shell commands (which have clear end states), not for AI agents that have long pauses between visible outputs.

---

## Hypotheses for Improvement

### Hypothesis 1: Secondary LLM Check for Terminal State

**Idea**: Before calling OpenAI, use a cheap/fast LLM (like GPT-4o-mini) to analyze the last ~20 lines of terminal output and determine if Claude Code is still processing.

**Implementation**:
```typescript
async function isClaudeStillProcessing(terminalOutput: string): Promise<boolean> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: `Analyze this Claude Code terminal output. Is Claude still processing a request, or is it idle waiting for new input?

Terminal output (last 20 lines):
${terminalOutput}

Respond with ONLY "processing" or "idle".`
    }],
    max_tokens: 10,
    temperature: 0
  });
  return response.choices[0].message.content?.trim() === "processing";
}
```

**Flow**:
1. After readiness fires, before calling OpenAI main model
2. Run cheap LLM check: "Is Claude still processing?"
3. If processing → wait longer, retry check (with timeout)
4. If idle → proceed with OpenAI call

**Pros**:
- Leverages LLM understanding of conversational context
- Can detect subtle "mid-conversation" states
- Cheap per-call (~$0.0001)

**Cons**:
- Adds latency (100-300ms per check)
- Could spam the LLM if we check too frequently
- Need rate limiting/caching

**Mitigation**: Cache result for 2-3 seconds, max 5 checks before timeout.

---

### Hypothesis 2: Detect Claude Code's Activity Indicators

**Idea**: Parse the terminal output for Claude Code-specific indicators that signal active processing vs idle.

**Claude Code Activity Signals**:
```
PROCESSING:
- "⏺" (filled circle) at start of line = currently executing tool
- "⎿" (tool output delimiter) appearing = tool results streaming
- Spinner animation characters
- "Thinking..." or similar status messages
- Lines being actively added (not just prompt)

IDLE:
- Clean ">" prompt on last line
- Static output (no changes in 3+ seconds)
- No pending tool indicators
```

**Implementation**:
```rust
fn is_claude_processing(output: &str) -> bool {
    let lines: Vec<&str> = output.lines().collect();
    let last_20 = lines.iter().rev().take(20).collect::<Vec<_>>();

    // Check for active tool execution
    for line in &last_20 {
        if line.starts_with("⏺") && !line.contains("⎿") {
            return true; // Tool started but not finished
        }
    }

    // Check for thinking indicators
    if output.contains("Thinking...") || output.contains("...") {
        return true;
    }

    false
}
```

**Pros**:
- No LLM call required
- Very fast (string parsing)
- Deterministic

**Cons**:
- Brittle to Claude Code UI changes
- May miss edge cases
- Requires maintenance as Claude Code evolves

---

### Hypothesis 3: Track Conversation Turn State

**Idea**: Instead of relying on terminal output, track the conversation state between our agent and Claude Code.

**Implementation**:
```typescript
interface ConversationState {
  lastRequestSentAt: number;
  lastResponseReceivedAt: number | null;
  pendingRequest: boolean;
  requestContent: string;
}

// When agent sends to Claude Code:
state.lastRequestSentAt = Date.now();
state.pendingRequest = true;
state.requestContent = request;

// When we detect Claude's response is complete:
state.lastResponseReceivedAt = Date.now();
state.pendingRequest = false;

// Before allowing next agent action:
if (state.pendingRequest) {
  // Wait for response or timeout
}
```

**Challenge**: How do we know Claude's response is "complete"?

**Response Completion Signals**:
- Claude outputs a final message (not a tool call)
- The prompt returns to ">" with no pending tool indicators
- A timeout of 60s passes (fail-safe)

**Pros**:
- State machine approach is explicit
- Doesn't rely on parsing output
- Clear ownership of "whose turn is it"

**Cons**:
- Complex state management
- Need to handle edge cases (interrupts, errors)
- Response completion detection is still hard

---

### Hypothesis 4: Use a Dedicated "Readiness" Tool

**Idea**: Instead of inferring readiness from output, have the agent explicitly check if Claude is ready.

**New Tool**:
```typescript
const TERMINAL_READY_CHECK_TOOL = {
  name: "terminal_check_ready",
  description: "Check if the REPL program (e.g., Claude Code) is ready for new input. " +
    "Use this BEFORE sending commands to Claude Code to ensure it's not mid-task.",
  parameters: {}
};
```

**Handler**:
```typescript
if (directive.tool === "terminal.check_ready") {
  const context = getTerminalContext();
  if (context.program === "claude") {
    const output = await capturePane({ lines: -30 });
    const isProcessing = await cheapLlmCheck(output); // Hypothesis 1
    return { ready: !isProcessing, program: "claude" };
  }
  return { ready: true };
}
```

**System Prompt Addition**:
```
When context.program is "claude":
- ALWAYS call terminal.check_ready BEFORE sending a new request
- If not ready, wait 2-3 seconds and check again
- After 3 failed checks, use terminal.interrupt to reset
```

**Pros**:
- Agent is explicitly responsible for checking
- Clear contract: "check before acting"
- Can combine with any detection method

**Cons**:
- Adds round-trip latency
- Agent might forget to check
- Still need to solve "is processing" detection

---

### Hypothesis 5: Output Diffing with Semantic Stability

**Idea**: Instead of quiescence (no new bytes), check for "semantic stability" - the meaning of the output hasn't changed.

**Implementation**:
1. Capture terminal at T0
2. Wait 1 second
3. Capture terminal at T1
4. Compare semantically (cheap LLM or heuristics)
5. If stable → ready
6. If changing → wait more

**Semantic Comparison**:
```typescript
function isSemanticallySame(output1: string, output2: string): boolean {
  // Strip timestamps, counters, progress indicators
  const normalize = (s: string) => s
    .replace(/\d+:\d+:\d+/g, "TIME")
    .replace(/\d+%/g, "PCT")
    .replace(/\d+ seconds?/g, "DURATION")
    .trim();

  return normalize(output1) === normalize(output2);
}
```

**Pros**:
- Tolerates cosmetic changes (timestamps, counters)
- More robust than byte-level quiescence

**Cons**:
- Still doesn't understand conversation context
- Might miss important changes
- Adds latency (multiple captures)

---

## Recommended Solution: Activity-Based Detection via Capture-Pane Diffing

**Key Insight**: The TUI "moves" while Claude is processing. We can detect activity by comparing capture-pane snapshots at intervals. No LLM needed.

### The Algorithm

```
1. After sending input to terminal, start ActivityDetector
2. Wait initial_delay (2 seconds) - let processing start
3. Capture pane → hash1
4. Wait interval (5 seconds)
5. Capture pane → hash2
6. Compare:
   - If hash1 != hash2: Activity detected
     - hash1 = hash2
     - stable_count = 0
     - Go to step 4
   - If hash1 == hash2: Screen is stable
     - stable_count++
     - If stable_count >= required_stable (2-3): READY!
     - Else: Go to step 4
7. Timeout after max_wait (60 seconds) → READY with low confidence
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `initial_delay` | 2s | Let Claude start processing before first check |
| `interval` | 5s | Balance between responsiveness and tmux load |
| `required_stable` | 2-3 | 2 stable checks = 10-15s of no change |
| `max_wait` | 60s | Timeout for hung processes |

**"Ready" = screen unchanged for 10-15 seconds** (2-3 intervals × 5 seconds)

### Why This Works

1. **Claude TUI updates frequently**: Tool calls, thinking indicators, output streaming all cause visual changes
2. **Idle Claude is static**: When Claude finishes, the screen stops changing
3. **5-second intervals avoid timestamp issues**: Timestamps like "2m ago" only update every ~60 seconds
4. **Hash comparison is fast**: We already have `simple_hash()` in Bud

### Where It Lives

**Option A: Bud-side (Recommended)**
```
┌─────────────────────────────────────────────────────────┐
│ Bud (Rust)                                              │
│                                                         │
│   terminal.run received                                 │
│         ↓                                               │
│   Send input to tmux                                    │
│         ↓                                               │
│   If await_ready.activity_based:                        │
│       Spawn ActivityDetector (new)                      │
│   Else:                                                 │
│       Spawn ReadinessDetector (existing quiescence)     │
│         ↓                                               │
│   ActivityDetector:                                     │
│     - Wait 2s                                           │
│     - Loop: capture-pane, hash, compare, wait 5s        │
│     - If stable for 2-3 checks: send terminal_ready     │
│         ↓                                               │
│   Send terminal_ready to Service                        │
└─────────────────────────────────────────────────────────┘
```

**Pros of Bud-side**:
- capture-pane is local (no network round-trip)
- Reuses existing ReadinessDetector pattern
- Service doesn't need to change much

**Option B: Service-side**
- Service polls capturePane() at intervals
- More network traffic, higher latency
- Not recommended

### Architecture Changes

#### 1. Extend `AwaitReady` struct (Bud)

```rust
#[derive(Debug, Deserialize, Clone, Default)]
struct AwaitReady {
    enabled: bool,
    quiescence_ms: Option<u64>,
    max_wait_ms: Option<u64>,
    // NEW: Activity-based detection for TUI apps
    activity_based: Option<bool>,
    activity_interval_ms: Option<u64>,      // Default: 5000
    activity_stable_count: Option<u32>,     // Default: 2
}
```

#### 2. Add `ActivityDetector` (Bud)

```rust
struct ActivityDetector {
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    interval_ms: u64,
    stable_count_required: u32,
    max_wait_ms: u64,
}

impl ActivityDetector {
    async fn run(self) -> Result<()> {
        let start = Instant::now();
        let mut last_hash: Option<u64> = None;
        let mut stable_count = 0;

        // Initial delay
        time::sleep(Duration::from_secs(2)).await;

        loop {
            // Capture pane
            let output = self.capture_pane().await?;
            let current_hash = simple_hash(output.as_bytes());

            match last_hash {
                Some(prev) if prev == current_hash => {
                    stable_count += 1;
                    if stable_count >= self.stable_count_required {
                        // Ready!
                        self.send_ready(0.9, "activity_stable").await?;
                        return Ok(());
                    }
                }
                _ => {
                    // Activity detected or first capture
                    stable_count = 0;
                }
            }

            last_hash = Some(current_hash);

            // Check timeout
            if start.elapsed() >= Duration::from_millis(self.max_wait_ms) {
                self.send_ready(0.5, "timeout").await?;
                return Ok(());
            }

            // Wait for next check
            time::sleep(Duration::from_millis(self.interval_ms)).await;
        }
    }

    async fn capture_pane(&self) -> Result<String> {
        let output = Command::new("tmux")
            .args(["capture-pane", "-p", "-t", &self.handle.session_name])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}
```

#### 3. Update Service to request activity-based detection

```typescript
// In terminal-manager.ts sendInput():
const payload = {
  // ... existing fields
  await_ready: {
    enabled: true,
    // Use activity-based detection for REPL contexts
    activity_based: context.mode === "repl",
    activity_interval_ms: 5000,
    activity_stable_count: 2,
    max_wait_ms: 60000
  }
};
```

#### 4. Update agent-service.ts to pass context

When sending `terminal.run` for a REPL, the Service should tell Bud to use activity-based detection.

### Flow Comparison

**Current (Quiescence)**:
```
Input sent → Wait for 1.5s no output → Ready
             (fails for Claude - natural pauses)
```

**Proposed (Activity)**:
```
Input sent → Wait 2s → Capture → Wait 5s → Capture → Compare
                                                        ↓
                                    Same? → stable_count++ → If ≥2: Ready!
                                    Diff? → stable_count=0 → Loop
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Claude finishes quickly (<7s) | Wait initial 2s + 5s interval = 7s minimum |
| Claude runs long task (2min) | Multiple intervals, ready when stable |
| Claude hangs forever | Timeout at 60s with low confidence |
| User interrupts mid-task | Capture changes, then stabilizes after interrupt |
| Network issues with tmux | Capture fails, retry on next interval |

### Why Not Use Quiescence for REPL?

| Aspect | Quiescence | Activity-Based |
|--------|------------|----------------|
| What it measures | Bytes added to pipe-pane log | Visual screen changes |
| Claude thinking | False positive (no output = "ready") | Correct (screen unchanged) |
| Claude tool call | Miss (output stops between tools) | Correct (screen updating) |
| Shell commands | Works well | Overkill (slower) |

**Recommendation**: Use quiescence for `mode: "shell"`, activity for `mode: "repl"`.

### Tuning Considerations

**Too aggressive (1s interval, 1 stable check)**:
- Risk: Catch Claude between tool calls
- Result: Premature "ready", same bug as now

**Too conservative (10s interval, 5 stable checks)**:
- Risk: 50+ seconds minimum wait
- Result: Slow interactions, frustrated user

**Sweet spot (5s interval, 2 stable checks)**:
- Minimum wait: 2s + 5s + 5s = 12s (if immediately stable)
- Typical wait: 2s + N×5s where N is activity checks
- Max wait: 60s timeout

---

## Testing Plan

1. **Basic Claude interaction**: Send request, verify agent waits for response
2. **Long-running Claude task**: Claude runs multiple tools, agent waits
3. **Rapid Claude response**: Claude finishes in <5s, agent waits ~12s minimum
4. **Claude hangs**: 60s timeout fires
5. **Interrupt mid-task**: Agent sends interrupt, waits for stability
6. **Shell commands**: Verify still uses quiescence (fast)

---

## Open Questions

1. **Is 5 seconds the right interval?**
   - Too fast: tmux overhead, false activity from cursor blink
   - Too slow: Long wait times
   - 5s seems reasonable, can tune based on testing

2. **Is 2 stable checks enough?**
   - 2 checks = 10s of stability (after initial 2s + first capture)
   - 3 checks = 15s of stability (more conservative)
   - Start with 2, increase if false positives

3. **Should we hash the full pane or just visible lines?**
   - Full pane: More accurate, includes scrollback
   - Visible only: Faster, but might miss important content
   - Start with full pane (what capture-pane returns by default)

4. **What about cursor blink causing hash changes?**
   - tmux capture-pane doesn't include cursor state
   - Should not be an issue

---

## Implementation Priority

1. **Phase 1**: Add `ActivityDetector` to Bud, parallel to `ReadinessDetector`
2. **Phase 2**: Update `AwaitReady` struct with activity options
3. **Phase 3**: Service passes `activity_based: true` for REPL contexts
4. **Phase 4**: Tune parameters based on testing
