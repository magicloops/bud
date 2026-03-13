# Design: Terminal Output Capture for Agent Tool Calls

**Status:** Draft
**Created:** 2025-12-20
**Related:**
- [`debug/terminal-run-binary-output-issue.md`](../debug/terminal-run-binary-output-issue.md)
- [`plan/agent-tool-output-documentation.md`](../plan/agent-tool-output-documentation.md)

---

## Problem Statement

When the agent calls `terminal.run`, the returned `output` field often contains lines from **before** the command was executed, not just the output of the command itself. This pollutes the LLM's context with irrelevant historical output.

### Observed Behavior

```json
{
  "tool": "terminal.run",
  "input": "echo hello\n",
  "output": "... 50 lines of old output ...\necho hello\nhello\nuser@host:~$ ",
  "output_bytes": 9808
}
```

### Expected Behavior

```json
{
  "tool": "terminal.run",
  "input": "echo hello\n",
  "output": "echo hello\nhello\nuser@host:~$ ",
  "output_bytes": 25
}
```

---

## Current Architecture

### Data Flow

```
Bud Daemon                    Service                         Database
    │                            │                                │
    │  terminal_output frame     │                                │
    │  {seq, data, byte_offset}  │                                │
    ├───────────────────────────►│                                │
    │                            │                                │
    │                            │  1. Decode base64              │
    │                            │  2. Update in-memory offset    │
    │                            │  3. INSERT chunk               │
    │                            ├───────────────────────────────►│
    │                            │                                │
```

### Offset Tracking

Three layers of offset tracking:

| Layer | Storage | Purpose |
|-------|---------|---------|
| In-memory `lastOffsets` Map | `Map<sessionId, number>` | Synchronously updated as output arrives |
| `terminal_session.outputLogBytes` | PostgreSQL | Cumulative bytes stored |
| `terminal_session_output` rows | PostgreSQL | Individual chunks by `byteOffset` |

### Current terminal.run Flow

```typescript
// agent-service.ts executeTerminalCall()

1. offsetBeforeInput = getLastOffset(sessionId)  // Read in-memory offset
2. sendInput(sessionId, command)                  // Send to bud daemon
3. waitForReadiness(sessionId, timeout)           // Wait for ready signal
4. tailOutput(sessionId, { sinceOffset: offsetBeforeInput })  // Query DB
```

### The Problem

The offset is captured BEFORE input is sent, representing the end of ALL previous output. But this creates an ambiguous boundary:

```
Timeline:
T=0ms   Previous command output ends at byte 1000
T=50ms  offsetBeforeInput = getLastOffset() → returns 1000
T=51ms  New command sent to bud
T=100ms Bud echoes command (bytes 1000-1015)
T=150ms Command output arrives (bytes 1015-1050)
T=200ms Query: WHERE byteOffset >= 1000
        └─ Returns bytes 1000-1050 (includes echo and everything after)
```

**The fundamental issue**: We're capturing the offset of where previous output ENDED, not where new output BEGINS. These are the same only if there's no gap or overlap.

---

## Root Causes

### Cause 1: Offset Represents End of Previous Output

`getLastOffset()` returns the byte position after the LAST output chunk was received. If the previous command's output is still "fresh" in the buffer, the new command's output starts at or near this same position.

### Cause 2: Command Echo Included

When you type `echo hello`, the terminal echoes the characters back. This echo is part of the output stream and appears AFTER we capture `offsetBeforeInput`.

### Cause 3: No Input Markers

There's no marker in the output stream that says "user input started here." The raw byte stream doesn't distinguish between:
- Previous command output
- Command echo
- New command output
- Next prompt

### Cause 4: Shell Mode vs REPL Mode Divergence

| Mode | Method | Behavior |
|------|--------|----------|
| Shell | `tailOutput(sinceOffset)` | Gets raw byte stream from DB |
| REPL | `capturePane()` | Gets rendered screen from tmux |

REPL mode using `capturePane()` sidesteps the offset problem entirely by capturing what's visually on screen. Shell mode using `tailOutput()` has no such protection.

---

## Analysis: What the Agent Actually Needs

### For Shell Commands

When the agent runs `ls -la`, it needs:
1. The output of `ls -la` (file listing)
2. Readiness assessment (is the prompt back?)
3. Context (still in shell mode)

It does NOT need:
- Previous command output
- The command echo (it already knows what it sent)
- Historical terminal content

### For REPL Commands

When the agent sends input to Python/Claude Code, it needs:
1. The response from the REPL
2. Whether the REPL is ready for more input
3. Context (which program is running)

The current `capturePane()` approach works better here because it shows "what's on screen" rather than "what bytes were output."

---

## Potential Solutions

### Option 1: Strip Command Echo

**Approach**: After getting output, remove lines that match the input command.

```typescript
const output = await tailOutput(...);
const lines = output.split('\n');
const firstNonEchoLine = lines.findIndex(line => !line.includes(inputCommand.trim()));
const cleanOutput = lines.slice(firstNonEchoLine).join('\n');
```

**Pros:**
- Simple to implement
- Handles command echo problem

**Cons:**
- Fragile: what if command output contains the command text?
- Doesn't solve the "old output" problem
- Doesn't handle multi-line commands well

### Option 2: Use capturePane for All Modes

**Approach**: Always use `capturePane()` instead of `tailOutput()`, even for shell mode.

```typescript
// For ALL tools:
const capture = await terminalSessionManager.capturePane(sessionId, {
  startLine: -50,  // Last 50 lines
  joinLines: true
});
return { output: capture.output, ... };
```

**Pros:**
- Unified code path
- Shows "what's on screen" - more intuitive
- No offset tracking complexity

**Cons:**
- Loses output that scrolled off screen
- Long command output (1000+ lines) would be truncated to visible portion
- Can't get "just the new output" - always get screen context

### Option 3: Capture Offset AFTER Input Sent

**Approach**: Send input first, THEN capture the offset from the input acknowledgment.

```typescript
1. const inputAck = await sendInput(sessionId, command);  // Returns byte position
2. const offsetAfterInput = inputAck.outputOffset;        // New field
3. await waitForReadiness(sessionId, timeout);
4. const output = await tailOutput(sessionId, { sinceOffset: offsetAfterInput });
```

**Pros:**
- Clean boundary: "output after my input was received"
- No previous command pollution
- Works with existing byte-offset infrastructure

**Cons:**
- Requires protocol change (bud must report offset in input ack)
- Still includes command echo
- More complex round-trip

### Option 4: Use Sentinel Markers

**Approach**: Inject invisible markers into the output stream to delimit command boundaries.

```typescript
1. const marker = `\x1b]9999;${ulid()}\x07`;  // OSC sequence as marker
2. await sendInput(sessionId, `echo -ne '${marker}' && ${command}`);
3. const output = await tailOutput(...);
4. const markerIndex = output.indexOf(marker);
5. const cleanOutput = output.slice(markerIndex + marker.length);
```

**Pros:**
- Precise boundary marking
- Works even with complex commands

**Cons:**
- Modifies the user's command
- Markers might not work in all shells/programs
- Complex to implement correctly
- Changes command semantics

### Option 5: Hybrid Approach (Recommended)

**Approach**: Use `capturePane()` as primary, with `tailOutput()` as supplementary for long output.

```typescript
// 1. Always capture screen state for context
const screenCapture = await capturePane(sessionId, { startLine: -30 });

// 2. Get incremental output for completeness (if screen might have scrolled)
const tail = await tailOutput(sessionId, { sinceOffset: offsetBeforeInput });

// 3. Smart merge: if tail is significantly longer, include more context
if (tail.totalBytes > 5000) {
  // Long output - use tail but strip first N lines (likely old output)
  const lines = decoded.split('\n');
  const trimmedLines = lines.slice(Math.max(0, lines.length - 200));
  return trimmedLines.join('\n');
} else {
  // Short output - screen capture is sufficient
  return screenCapture.output;
}
```

**Pros:**
- Best of both worlds
- Screen capture for typical commands
- Tail output for long-running commands
- Heuristic can be tuned

**Cons:**
- More complex logic
- Heuristics can be wrong
- Two capture methods in one path

### Option 6: Post-Process with Prompt Detection

**Approach**: Use the readiness hints to intelligently trim output.

```typescript
const output = await tailOutput(...);
const lines = output.split('\n');

// Find the LAST prompt before the current one (marks previous command end)
let lastPromptBeforeNew = -1;
for (let i = 0; i < lines.length - 1; i++) {
  if (looksLikePrompt(lines[i]) && !looksLikePrompt(lines[i + 1])) {
    lastPromptBeforeNew = i;
  }
}

// Trim everything before that prompt
if (lastPromptBeforeNew >= 0) {
  const cleanOutput = lines.slice(lastPromptBeforeNew).join('\n');
  return cleanOutput;
}
```

**Pros:**
- Uses existing readiness detection logic
- No protocol changes needed
- Works with current infrastructure

**Cons:**
- Prompt detection is heuristic-based
- False positives could trim valid output
- Doesn't work well if output contains prompt-like text

---

## Recommendation

### Short-term: Option 6 (Post-Process with Prompt Detection)

1. After getting `tailOutput`, find the last prompt-like line before the final prompt
2. Trim everything before it
3. This removes previous command output while keeping the current command's full output

**Implementation sketch:**

```typescript
private trimToCurrentCommand(output: string): string {
  const lines = output.split('\n');
  if (lines.length < 3) return output;

  // Find prompts using existing hint logic
  const promptIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (this.looksLikeShellPrompt(lines[i])) {
      promptIndices.push(i);
    }
  }

  // If we have at least 2 prompts, trim to the second-to-last one
  // (That's where the current command started)
  if (promptIndices.length >= 2) {
    const startIndex = promptIndices[promptIndices.length - 2];
    return lines.slice(startIndex).join('\n');
  }

  return output;
}
```

### Medium-term: Option 3 (Offset After Input)

1. Modify the bud protocol to return the current output offset in the `terminal_input` acknowledgment
2. Use that offset instead of pre-captured offset
3. This gives a clean "output after my input" boundary

**Protocol addition:**

```typescript
// Bud → Service response to terminal_input
{
  "type": "terminal_input_ack",
  "output_offset": 12345,  // Byte position when input was processed
  "ts": ...
}
```

### Long-term: Consider Unified capturePane

For most use cases, `capturePane()` provides cleaner output. Consider making it the default and only using `tailOutput()` when:
- Output is expected to exceed screen buffer
- Historical byte-accurate logging is needed

---

## Questions to Resolve

1. **Prompt detection reliability**: How accurate is `looksLikeShellPrompt()`? What edge cases fail?

2. **REPL prompt patterns**: Should we have program-specific prompt detection (Python `>>>`, Node `>`, etc.)?

3. **Protocol versioning**: If we add `output_offset` to input acks, how do we handle old bud versions?

4. **Performance**: Does running prompt detection on every command output add noticeable latency?

5. **Command echo stripping**: Should we explicitly strip the first line if it matches the input? Is this safe?

---

## Appendix: Code Locations

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Offset capture | `agent-service.ts` | 812 | `getLastOffset()` call |
| tailOutput query | `terminal-session-manager.ts` | 686-788 | DB query with sinceOffset |
| capturePane | `terminal-session-manager.ts` | 793-839 | tmux capture request |
| Output storage | `terminal-session-manager.ts` | 478-547 | `handleTerminalOutput()` |
| Offset update | `terminal-session-manager.ts` | 483 | In-memory offset set |

---

*Created: 2025-12-20*
