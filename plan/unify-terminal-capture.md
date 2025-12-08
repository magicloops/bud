# Plan: Unify terminal.observe into terminal.capture

_Created: 2025-12-04_

## Overview

Remove `terminal.observe` and consolidate its "wait for readiness" behavior into `terminal.capture` with an optional `wait` parameter. This reduces agent confusion and tool count while preserving all functionality.

## Current State

### terminal.observe
```typescript
// Tool definition
{
  name: "terminal_observe",
  description: "Wait for more terminal output without sending input.",
  parameters: { timeout_ms: { type: "integer" } }
}

// Handler
const readiness = await waitForReadiness(budId, timeoutMs);  // Polls for new readiness
const tail = await tailOutput(budId, backfillBytes);         // Gets pipe-pane output
return { output, readiness: { confidence: 0.3, ... } };
```

### terminal.capture
```typescript
// Tool definition
{
  name: "terminal_capture",
  description: "Capture the rendered terminal screen...",
  parameters: { lines: { type: "integer" }, timeout_ms: { type: "integer" } }
}

// Handler
const capture = await capturePane(budId, { startLine: lines });  // Immediate capture
return { output, readiness: { confidence: 1.0, trigger: "capture" } };
```

### Key Difference
- **observe**: Waits for readiness, then returns output (pipe-pane)
- **capture**: Immediate capture, no waiting (capture-pane)

## Readiness System Deep Dive

### How readiness detection works:

1. **Trigger**: `sendInput()` or `sendInterrupt()` sends frame to Bud with `await_ready: { enabled: true }`
2. **Bud spawns ReadinessDetector**: Monitors terminal for quiescence (1.5s no output) or prompt patterns
3. **Bud sends terminal_ready**: Contains assessment with confidence, trigger, hints
4. **Service stores readiness**: `handleTerminalReady()` updates `readiness` Map with timestamp
5. **waitForReadiness()**: Polls the Map for updates newer than when it started

### Critical insight for wait behavior:

`waitForReadiness()` works by polling for NEW updates:
```typescript
async waitForReadiness(budId: string, timeoutMs = 5000): Promise<unknown | null> {
  const initialUpdated = this.readiness.get(budId)?.updatedAt ?? 0;
  while (Date.now() - start < timeoutMs) {
    const latest = this.readiness.get(budId);
    if (latest && latest.updatedAt > initialUpdated) {
      return latest.assessment;  // Got new readiness!
    }
    await sleep(100);
  }
  return this.readiness.get(budId)?.assessment ?? null;  // Timeout - return cached
}
```

This means:
- If Bud's ReadinessDetector is still running → We'll get fresh readiness
- If no detector is running (no recent input) → We timeout and get cached readiness

**This is acceptable behavior** - if the agent calls `wait` without having sent input, the timeout is expected. The cached readiness provides useful context.

---

## Design: Unified terminal.capture

### New Tool Definition

```typescript
const TERMINAL_CAPTURE_TOOL = {
  type: "function",
  name: "terminal_capture",
  description:
    "Get terminal screen output. Use to see TUI app content, scroll through history, " +
    "or wait for a command to finish. Returns the rendered screen (what you'd see visually).",
  parameters: {
    type: "object",
    properties: {
      wait: {
        type: "boolean",
        description: "Wait for terminal to become ready before capturing. " +
          "Use after terminal.run returns low confidence. Default: false.",
        nullable: true
      },
      lines: {
        type: "integer",
        description: "Lines of scrollback history. Negative = from current position. " +
          "Default: -200. Use -500 or -1000 for more history.",
        nullable: true
      },
      timeout_ms: {
        type: "integer",
        description: "Max wait time in ms (only applies if wait=true). Default: 5000.",
        nullable: true
      }
    },
    required: [],
    additionalProperties: false
  },
  strict: true
};
```

### Behavior Matrix

| wait | Behavior |
|------|----------|
| `false` (default) | Immediate capture-pane, return snapshot readiness |
| `true` | Wait for readiness, then capture-pane, return Bud's readiness |

### Handler Logic

```typescript
if (directive.tool === "terminal.capture") {
  const lines = directive.lines ?? -200;
  const shouldWait = directive.wait === true;

  let readiness: Record<string, unknown>;

  if (shouldWait) {
    // Wait for terminal to settle
    const budReadiness = await this.terminalManager.waitForReadiness(
      bud.budId,
      directive.timeoutMs ?? 5000
    );
    readiness = this.normalizeReadiness(budReadiness, {
      ready: false,
      confidence: 0.3,
      trigger: "wait_timeout",
      hints: { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true }
    });
  } else {
    // Immediate capture
    readiness = { ready: true, confidence: 1.0, trigger: "capture" };
  }

  const capture = await this.terminalManager.capturePane(bud.budId, {
    startLine: lines,
    joinLines: true
  }, directive.timeoutMs ?? 5000);

  if (capture.error) {
    throw new Error(capture.error);
  }

  return {
    output: capture.output,
    outputBytes: capture.outputBytes,
    readiness,
    lastLine: capture.output.trim().split(/\r?\n/).pop() ?? "",
    truncated: false,
    omittedLines: 0,
    context: getContext()
  };
}
```

---

## Updated System Prompt

### Before (confusing)
```
Tools:
- terminal.run - send input
- terminal.observe - wait for output
- terminal.interrupt - send Ctrl+C
- terminal.capture - get screen snapshot

Guidelines:
- confidence < 0.5: use terminal.observe to wait
- Use terminal.capture when output is garbled or truncated
```

### After (clear)
```
Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\n"}
- {"type":"tool_call","tool":"terminal.capture"}
- {"type":"tool_call","tool":"terminal.capture","wait":true}
- {"type":"tool_call","tool":"terminal.interrupt"}

Guidelines:
- After terminal.run, check readiness confidence:
  - confidence >= 0.8: Ready, proceed with next command
  - confidence < 0.8: Use terminal.capture with wait:true to wait longer
- Use terminal.capture (without wait) to:
  - See more scrollback history (add lines:-500)
  - Get cleaner output for TUI apps
```

---

## Implementation Steps

### Phase 1: Update tool definition and types

**Files:** `service/src/agent/agent-service.ts`

1. Remove `TERMINAL_OBSERVE_TOOL` constant
2. Update `TERMINAL_CAPTURE_TOOL` with `wait` parameter
3. Update `AgentDirective` type:
   - Remove `"terminal.observe"` from tool union
   - Add `wait?: boolean` field
4. Update `toolNameForConversation()`:
   - Remove `terminal.observe` case

### Phase 2: Update directive parsing

**Files:** `service/src/agent/agent-service.ts`

1. Remove `case "terminal_observe":` from `extractDirective()`
2. Update `case "terminal_capture":` to parse `wait` parameter

### Phase 3: Update tool execution

**Files:** `service/src/agent/agent-service.ts`

1. Remove `terminal.observe` handler block
2. Update `terminal.capture` handler to:
   - Check `directive.wait`
   - If true, call `waitForReadiness()` first
   - Return appropriate readiness based on wait behavior

### Phase 4: Update system prompt

**Files:** `service/src/agent/agent-service.ts`

1. Remove `terminal.observe` from tools list
2. Update guidelines to use `terminal.capture` with `wait:true`

### Phase 5: Remove observe from tools array

**Files:** `service/src/agent/agent-service.ts`

1. Remove `TERMINAL_OBSERVE_TOOL` from `tools` array passed to OpenAI

### Phase 6: Cleanup

1. Remove any remaining references to `terminal.observe`
2. Update plan/status documents

---

## Open Questions

### Q1: Should `wait` default to `true` or `false`?

**Recommendation: `false`**

Rationale:
- Explicit is better than implicit
- `terminal.run` already waits for readiness
- Most capture use cases are "show me the screen now"
- Agent can add `wait:true` when needed

### Q2: What if agent calls `wait:true` with no pending command?

**Answer: Timeout with cached readiness**

The `waitForReadiness()` function will poll for 5s, find no new updates, and return cached readiness. This is fine - the agent gets whatever readiness info we have, and can proceed.

### Q3: Should we log a deprecation warning for terminal.observe?

**Recommendation: No**

Since we control the system prompt and tools array, agents can't call `terminal.observe` after this change. No deprecation period needed.

### Q4: Do we need to update terminal.run?

**Answer: No**

`terminal.run` already:
- Sends input with `await_ready`
- Waits for readiness
- Uses capture-pane for REPL contexts
- Returns readiness assessment

The agent flow is:
1. `terminal.run` → returns output with readiness
2. If low confidence → `terminal.capture` with `wait:true`
3. If need more history → `terminal.capture` with larger `lines`

---

## Testing Plan

1. **Basic capture** - `terminal.capture` returns screen immediately
2. **Wait then capture** - `terminal.capture` with `wait:true` waits for readiness
3. **Scrollback** - `terminal.capture` with `lines:-500` returns more history
4. **REPL context** - Capture works correctly for TUI apps
5. **Timeout behavior** - `wait:true` with no pending command times out gracefully
6. **System prompt** - Verify agent uses new tool format correctly

---

## Summary

| Before | After |
|--------|-------|
| 4 tools (run, observe, interrupt, capture) | 3 tools (run, capture, interrupt) |
| Confusing observe vs capture | Single capture with optional wait |
| observe uses pipe-pane (bad for TUI) | capture always uses capture-pane |
| Two mental models | One unified model |

**Changes:**
- Remove `TERMINAL_OBSERVE_TOOL`
- Add `wait` parameter to `TERMINAL_CAPTURE_TOOL`
- Update handler, types, parsing, system prompt
- ~50 lines removed, ~20 lines modified
