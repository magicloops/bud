# Terminal Observe vs Capture: Analysis and Consolidation

_Created: 2025-12-04_

## Problem Statement

We now have two tools that both retrieve terminal output:
- `terminal.observe` - "Wait for more terminal output without sending input"
- `terminal.capture` - "Capture the rendered terminal screen"

This creates confusion for the agent about which to use when. This document analyzes the overlap and proposes consolidation strategies.

---

## Current Implementation Comparison

| Aspect | terminal.observe | terminal.capture |
|--------|-----------------|------------------|
| **Primary purpose** | Wait for output to settle | Get accurate screen snapshot |
| **Waits for readiness?** | Yes (quiescence detection) | No (immediate) |
| **Output source** | `tailOutput()` (pipe-pane log) | `capturePane()` (tmux capture-pane) |
| **Default readiness confidence** | 0.3 (low, "may still be processing") | 1.0 (high, "it's a snapshot") |
| **Scrollback control** | No (fixed backfill bytes) | Yes (`lines` parameter) |
| **Good for TUI apps?** | No (raw byte stream) | Yes (rendered screen) |
| **Good for shell commands?** | Yes | Yes (but overkill) |
| **Timeout parameter?** | Yes | Yes |

### Code Paths

**terminal.observe** (`agent-service.ts:972-995`):
```typescript
const readiness = await this.terminalManager.waitForReadiness(budId, timeoutMs);
const tail = await this.terminalManager.tailOutput(budId, backfillBytes);
const decoded = this.decodeTail(tail.data);  // ANSI strip
return { output: decoded, readiness: { confidence: 0.3, trigger: "observe" }, ... };
```

**terminal.capture** (`agent-service.ts:997-1029`):
```typescript
const capture = await this.terminalManager.capturePane(budId, { startLine: lines });
return { output: capture.output, readiness: { confidence: 1.0, trigger: "capture" }, ... };
```

---

## Semantic Differences

### terminal.observe: "Wait and watch"
- **Intent**: Command is still running, wait for it to finish
- **Behavior**: Blocks until quiescence or timeout
- **Use case**: Long-running commands, output streaming in progress
- **Limitation**: Uses pipe-pane, so TUI output is garbled

### terminal.capture: "Snapshot now"
- **Intent**: I need to see what's on screen right now
- **Behavior**: Immediate capture, no waiting
- **Use case**: TUI apps, scrollback history, garbled output
- **Limitation**: Doesn't wait, so may capture mid-output

---

## The Confusion Problem

The agent faces these scenarios:

1. **"Output looks incomplete"** - Use observe to wait? Or capture to get better rendering?
2. **"TUI app is running"** - Observe won't help (garbled). Capture is correct.
3. **"Command is still running"** - Observe to wait. Capture would snapshot mid-stream.
4. **"Need more scrollback"** - Capture with `lines:-500`. Observe can't do this.

Current system prompt guidance:
```
- confidence < 0.5: Likely still processing, use terminal.observe to wait
- Use terminal.capture when:
  - Output appears garbled or incomplete
  - You need to see more output history
```

This creates a decision tree the agent must navigate, increasing cognitive load and error potential.

---

## Consolidation Options

### Option A: Merge into terminal.observe with `capture` flag

```typescript
// Unified tool
{
  "tool": "terminal.observe",
  "timeout_ms": 5000,
  "capture": true,     // Use capture-pane instead of tailOutput
  "lines": -200        // Only applies if capture=true
}
```

**Pros:**
- Single "get output" tool
- Preserves waiting behavior
- Backward compatible (capture defaults to false)

**Cons:**
- Overloaded semantics
- "observe" implies passive watching, but capture is active

**Implementation:**
```typescript
if (directive.tool === "terminal.observe") {
  const readiness = await this.terminalManager.waitForReadiness(...);

  let output: string;
  if (directive.capture || context.mode === "repl") {
    const capture = await this.terminalManager.capturePane(...);
    output = capture.output;
  } else {
    const tail = await this.terminalManager.tailOutput(...);
    output = this.decodeTail(tail.data);
  }

  return { output, readiness, ... };
}
```

---

### Option B: Merge into terminal.capture with `wait` flag

```typescript
// Unified tool
{
  "tool": "terminal.capture",
  "wait": true,        // Wait for readiness first
  "timeout_ms": 5000,
  "lines": -200
}
```

**Pros:**
- Single tool with clear name ("capture the screen")
- Wait is optional add-on
- capture-pane is objectively better for all cases

**Cons:**
- Breaking change (removes terminal.observe)
- "capture" with wait=true is slightly confusing naming

**Implementation:**
```typescript
if (directive.tool === "terminal.capture") {
  if (directive.wait) {
    await this.terminalManager.waitForReadiness(...);
  }
  const capture = await this.terminalManager.capturePane(...);
  return { output: capture.output, ... };
}
```

---

### Option C: Replace terminal.observe entirely

Remove `terminal.observe`. The agent uses `terminal.capture` for all "get output" needs.

**Rationale:**
- `capture-pane` returns the rendered screen, which is always accurate
- Waiting for readiness is already done by `terminal.run`
- If the agent needs to wait, it can just call `terminal.run` with empty input? No, that sends Enter.

**Problem:**
- How does the agent "wait for more output" without sending input?
- `terminal.capture` doesn't wait - it snapshots immediately

**Workaround - add wait to capture:**
```typescript
{
  "tool": "terminal.capture",
  "wait_for_readiness": true,  // Optional: wait before capturing
  "timeout_ms": 5000,
  "lines": -200
}
```

This is essentially Option B.

---

### Option D: Keep both, but auto-switch observe to capture for REPLs

Current `terminal.observe` uses `tailOutput()`. Modify it to use `capturePane()` when in REPL context (same as we did for `terminal.run`).

```typescript
if (directive.tool === "terminal.observe") {
  const readiness = await this.terminalManager.waitForReadiness(...);

  const context = getContext();
  let output: string;

  if (context.mode === "repl") {
    const capture = await this.terminalManager.capturePane(budId, { startLine: -200 });
    output = capture.output;
  } else {
    const tail = await this.terminalManager.tailOutput(...);
    output = this.decodeTail(tail.data);
  }

  return { output, readiness, context };
}
```

**Pros:**
- Minimal API change
- Agent doesn't need to think about capture vs observe
- Both tools "just work" for their intended purpose

**Cons:**
- Still two tools with overlapping purpose
- Agent might still be confused about when to use which

---

### Option E: Rename to clarify intent

Keep both tools but rename to make intent crystal clear:

| Current | Proposed | Purpose |
|---------|----------|---------|
| `terminal.observe` | `terminal.wait` | Wait for command to finish, return output |
| `terminal.capture` | `terminal.screenshot` | Snapshot screen now, with scrollback |

Or:
| Current | Proposed | Purpose |
|---------|----------|---------|
| `terminal.observe` | `terminal.wait_for_output` | Block until quiescence |
| `terminal.capture` | `terminal.get_screen` | Immediate screen capture |

**Pros:**
- Clearer semantics
- No behavior change

**Cons:**
- Still two tools
- Renaming is a breaking change

---

## Recommendation: Option D + Simplified Guidance

**Implementation**: Modify `terminal.observe` to auto-switch to capture-pane for REPL contexts.

**Simplify system prompt guidance to:**

```
Tools for getting terminal output:
- terminal.observe: Wait for command output to finish, then return it
- terminal.capture: Get more output history (use lines:-500 for more scrollback)

When to use which:
- After terminal.run shows low confidence: Use terminal.observe to wait longer
- When output is truncated or you need history: Use terminal.capture with larger lines value
- For TUI apps: Both work correctly (auto-detected)
```

**Why this is best:**
1. Minimal code change (just add REPL auto-switch to observe)
2. Preserves semantic distinction (wait vs snapshot)
3. Agent has clear decision criteria:
   - "Still running?" → observe
   - "Need more history?" → capture
4. TUI handling is automatic in both cases

---

## Alternative Recommendation: Option B (Unify into capture)

If we want maximum simplicity, merge everything into `terminal.capture`:

```typescript
const TERMINAL_CAPTURE_TOOL = {
  name: "terminal_capture",
  description: "Get terminal screen output. Optionally wait for command to finish first.",
  parameters: {
    wait: { type: "boolean", description: "Wait for readiness before capturing (default: false)" },
    timeout_ms: { type: "integer", description: "Max wait time if wait=true" },
    lines: { type: "integer", description: "Scrollback lines (default: -200, use -500/-1000 for more)" }
  }
};
```

**System prompt would be:**
```
- terminal.capture: Get terminal output
  - Add wait:true if command might still be running
  - Add lines:-500 for more scrollback history
```

**Deprecation path:**
1. Keep `terminal.observe` as alias for `terminal.capture` with `wait: true`
2. Log deprecation warning when observe is used
3. Remove observe in future version

---

## Files to Modify

For Option D (auto-switch observe):
- `service/src/agent/agent-service.ts:972-995` - Add REPL context check

For Option B (unify into capture):
- `service/src/agent/agent-service.ts` - Remove TERMINAL_OBSERVE_TOOL, add `wait` param to capture
- Update AgentDirective type
- Update extractDirective parsing
- Update system prompt

---

## Decision Needed

1. **Option D** (auto-switch observe) - Minimal change, preserves both tools
2. **Option B** (unify into capture) - Maximum simplicity, one tool to rule them all

Recommend starting with **Option D** as a quick fix, then consider **Option B** for a future cleanup if confusion persists.
