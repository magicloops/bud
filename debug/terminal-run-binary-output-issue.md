# Debug: terminal.run Output Showing as "binary output omitted"

**Status:** Fixed (2025-12-20)
**Created:** 2025-12-20
**Related:**
- [`debug/agent-terminal-run-output-flow.md`](./agent-terminal-run-output-flow.md)
- [`design/terminal-output-capture-redesign.md`](../design/terminal-output-capture-redesign.md) - Design doc for Issue A

---

## Environment

- Service: `service/src/agent/agent-service.ts`
- Terminal Manager: `service/src/runtime/terminal-session-manager.ts`
- Mode: Shell mode (not REPL)

## Observed Behavior

After implementing the system prompt changes to document that `terminal.run` returns output, we discovered the output is showing as `[binary output omitted]` instead of actual terminal text:

```json
{
  "tool": "terminal.run",
  "input": "cat ~/code/bud/plan/agent-tool-output-documentation.md\n",
  "output": "[binary output omitted]",
  "last_line": "[binary output omitted]",
  "output_bytes": 9808,
  "truncated": true
}
```

The `output_bytes: 9808` indicates data WAS captured, but it's being rejected as binary.

## Expected Behavior

The output should contain the actual text content of the file, with ANSI codes stripped.

---

## Root Cause Analysis

### The Bug Location

In `agent-service.ts:1017-1031`, the `decodeTail()` function:

```typescript
private decodeTail(data: Buffer): string {
  // If looks binary, return notice instead of raw binary.
  const text = data.toString("utf-8");
  const nonPrintable = [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x09 || (code > 0x0d && code < 0x20);
  }).length;
  if (nonPrintable > 8) {
    return "[binary output omitted]";  // <-- Binary check BEFORE ANSI stripping!
  }
  // Strip ANSI escape codes for agent consumption (UI gets raw via SSE)
  const stripped = this.stripAnsi(text);
  return this.normalizeCRLF(stripped);
}
```

**The Problem:** Binary detection happens BEFORE `stripAnsi()` is called.

### Why This Fails

1. **ESC character counts as "non-printable"**: The ESC character (`\x1b` = 27 = 0x1b) falls in the range `> 0x0d && < 0x20` (since 13 < 27 < 32)

2. **ANSI sequences are everywhere**: Terminal output contains ANSI escape codes for:
   - Colors (e.g., `\x1b[32m` for green)
   - Cursor movement
   - Bold/italic/underline
   - Shell prompts with colors
   - Syntax-highlighted output (like `cat` with bat, or colored ls output)

3. **Threshold is too low**: With just 8 ESC characters triggering binary detection, any reasonably colorful terminal output will fail

4. **REPL mode works because it uses a different path**: `capturePane()` calls tmux with `escape_sequences: false`, so the bud daemon strips ANSI codes before returning. Shell mode uses `tailOutput()` which returns raw bytes from the database.

### Code Flow Comparison

**Shell Mode (broken):**
```
tailOutput() → raw bytes from DB → decodeTail() → binary check (FAILS) → "[binary output omitted]"
                                                         ↓
                                              (stripAnsi never reached)
```

**REPL Mode (works):**
```
capturePane() → bud daemon strips ANSI → clean text returned → used directly
```

---

## Hypotheses and Proposed Fixes

### Hypothesis 1: Strip ANSI Before Binary Check (Recommended)

**Theory:** The binary detection should run on ANSI-stripped content, not raw terminal output.

**Fix:**

```typescript
private decodeTail(data: Buffer): string {
  const text = data.toString("utf-8");

  // Strip ANSI escape codes FIRST
  const stripped = this.stripAnsi(text);

  // THEN check for binary content on the cleaned text
  const nonPrintable = [...stripped].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x09 || (code > 0x0d && code < 0x20);
  }).length;

  if (nonPrintable > 8) {
    return "[binary output omitted]";
  }

  return this.normalizeCRLF(stripped);
}
```

**Pros:**
- Simple, minimal change
- Fixes the root cause
- Preserves binary detection for actual binary content

**Cons:**
- Still has a fixed threshold (8 characters)
- ANSI stripping regex must be robust

**Confidence:** High - this directly addresses the bug.

---

### Hypothesis 2: Use Percentage-Based Binary Detection

**Theory:** A fixed threshold of 8 characters is too sensitive. Use a percentage of total content instead.

**Fix:**

```typescript
private decodeTail(data: Buffer): string {
  const text = data.toString("utf-8");
  const stripped = this.stripAnsi(text);

  // Check for binary: if more than 1% of characters are non-printable
  const nonPrintable = [...stripped].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x09 || (code > 0x0d && code < 0x20);
  }).length;

  const binaryThreshold = Math.max(8, stripped.length * 0.01); // At least 8, or 1%
  if (nonPrintable > binaryThreshold) {
    return "[binary output omitted]";
  }

  return this.normalizeCRLF(stripped);
}
```

**Pros:**
- More robust for varying content sizes
- Still catches actual binary files
- Handles edge cases better

**Cons:**
- Slightly more complex
- May need tuning of the percentage

**Confidence:** Medium - good improvement, but Hypothesis 1 is the core fix.

---

### Hypothesis 3: Use capturePane for Shell Mode Too

**Theory:** Instead of using `tailOutput()` for shell mode, use `capturePane()` for both modes. This would give consistent, pre-cleaned output.

**Fix:** In `executeTerminalCall()`, change the shell mode branch to use `capturePane()`:

```typescript
// Get output using capturePane for BOTH modes
const capture = await this.terminalSessionManager.capturePane(sessionId, {
  startLine: -50,
  joinLines: true
});
decoded = capture.output;
outputBytes = capture.outputBytes;
truncated = false;
```

**Pros:**
- Consistent output handling for all modes
- Leverages existing working code path
- Output is pre-cleaned by tmux/bud

**Cons:**
- Different semantics: capture-pane shows "what's on screen", not "what was output since command"
- May lose output that scrolled off screen for long-running commands
- Loses the incremental byte-offset benefit for shell commands
- Changes behavior, not just fixes a bug

**Confidence:** Low - this is a behavioral change, not a bug fix. The current architecture (tailOutput for shell, capturePane for REPL) has merit.

---

## Fix Implemented

**Hypothesis 1 was implemented** - strip ANSI codes before binary detection.

Also added a TODO comment noting the divergent code paths between `tailOutput` (shell mode) and `capturePane` (REPL mode).

## Recommended Fix (Reference)

### Minimal Fix (Hypothesis 1 only):

```typescript
private decodeTail(data: Buffer): string {
  const text = data.toString("utf-8");

  // Strip ANSI escape codes FIRST, before binary detection
  const stripped = this.stripAnsi(text);

  // Check for binary content on cleaned text
  const nonPrintable = [...stripped].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x09 || (code > 0x0d && code < 0x20);
  }).length;

  if (nonPrintable > 8) {
    return "[binary output omitted]";
  }

  return this.normalizeCRLF(stripped);
}
```

### Enhanced Fix (Hypothesis 1 + 2):

```typescript
private decodeTail(data: Buffer): string {
  const text = data.toString("utf-8");

  // Strip ANSI escape codes FIRST
  const stripped = this.stripAnsi(text);

  // Check for binary: use percentage-based threshold
  const nonPrintable = [...stripped].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x09 || (code > 0x0d && code < 0x20);
  }).length;

  // At least 8 non-printable chars, or more than 1% of content
  const threshold = Math.max(8, Math.floor(stripped.length * 0.01));
  if (nonPrintable > threshold) {
    return "[binary output omitted]";
  }

  return this.normalizeCRLF(stripped);
}
```

---

## Testing Plan

1. **Basic shell command**: `ls -la` with colored output
2. **File with ANSI codes**: `cat` a file that has color (or use `bat`)
3. **Long output**: `cat` a large markdown file (like the reproduction case)
4. **Actual binary file**: `cat /bin/ls` should still return "[binary output omitted]"
5. **REPL mode regression**: Verify Python/Claude Code still work correctly

---

## Related Files

| File | Purpose |
|------|---------|
| `service/src/agent/agent-service.ts:1017-1031` | `decodeTail()` function with the bug |
| `service/src/agent/agent-service.ts:1040-1048` | `stripAnsi()` function |
| `service/src/runtime/terminal-session-manager.ts:686-788` | `tailOutput()` - returns raw bytes |
| `service/src/runtime/terminal-session-manager.ts:793-839` | `capturePane()` - returns clean text |

---

## Additional Issues Observed (2025-12-20)

After fixing the binary detection issue, additional problems were observed:

### Issue A: Output Contains Lines From Before Command

**Observed:** The `output` field includes many lines that appear to be from before the most recent command was executed, not just the output of that command.

**Expected:** Only the diff/delta since the command was sent should be returned.

**Current Implementation:** In `executeTerminalCall()` (agent-service.ts:815-886):
```typescript
const offsetBeforeInput = this.terminalSessionManager.getLastOffset(sessionId);
// ... send input ...
const tail = await this.terminalSessionManager.tailOutput(
  sessionId,
  config.terminalOutputBackfillBytes,
  { sinceOffset: offsetBeforeInput }
);
```

**Hypotheses:**
1. **Timing issue:** The offset is captured before `sendInput()`, but there may be buffered output that hasn't been written to the DB yet when we capture the offset
2. **Echo included:** The command itself gets echoed to the terminal and is included in the output
3. **Offset tracking bug:** `getLastOffset()` might not reflect the true current position
4. **Race condition:** Output from a previous command might still be streaming in when we capture the offset

**Investigation needed:**
- Add debug logging to compare `offsetBeforeInput` vs `offsetAfterReadiness`
- Check if the extra lines are from command echo or actual stale output
- Verify the byte offset tracking in `terminal-session-manager.ts`

### Issue B: `last_line` Shows Empty Shell Prompt

**Observed:** The `last_line` field frequently shows just the shell prompt:
```
user@machine ~/some/path$
```

**Current Implementation:** (agent-service.ts:910)
```typescript
lastLine: decoded.trim().split(/\r?\n/).pop() ?? ""
```

**Why this happens:** After a command completes, the terminal shows the next prompt. So the literal "last line" of output IS the prompt. This is technically correct but not useful.

**The problem:** `last_line` was likely intended to help with readiness detection (seeing if a prompt appeared), but as a field returned to the LLM, it's redundant with the readiness hints (`looks_like_prompt`) and not informative about what the command actually produced.

**Possible fixes:**
1. **Remove `last_line` entirely** - it's redundant with `output` and readiness hints
2. **Change to `last_output_line`** - skip lines that look like prompts and return the last "real" output line
3. **Keep as-is but document** - the LLM should use `output` and `readiness.hints.looks_like_prompt` instead

### Questions to Resolve

1. Is the offset tracking (`getLastOffset`, `sinceOffset`) working correctly?
2. Should command echo be stripped from output?
3. Is `last_line` actually useful, or should we remove/redesign it?
4. Should we add more specific logging to diagnose the timing/offset issues?

---

*Created: 2025-12-20*
