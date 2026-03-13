# Design: terminal.run Output Capture Redesign

**Status:** Draft
**Created:** 2025-12-20
**Related:**
- [`debug/terminal-run-binary-output-issue.md`](../debug/terminal-run-binary-output-issue.md)
- [`design/terminal-output-capture-redesign.md`](./terminal-output-capture-redesign.md) (earlier exploration)

---

## Problem Statement

When the agent calls `terminal.run`, the returned `output` field frequently contains:
1. Lines from **before** the command was executed
2. Sometimes **misses** the actual command output entirely (race condition)

This causes the LLM to call `terminal.capture` unnecessarily, wasting tokens and degrading the user experience.

### Goal

When the agent runs `ls -ltra`, it should receive **only** the output of that command. Not previous terminal history. Not partial output. The output should be deterministic and complete.

---

## Current Architecture (Full Analysis)

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BUD DAEMON (Rust)                              │
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐          │
│  │ tmux session │───►│ pipe-pane    │───►│ terminal.log      │          │
│  │              │    │ (cat >> log) │    │ (file on disk)    │          │
│  └──────────────┘    └──────────────┘    └───────────────────┘          │
│         │                                          │                     │
│         │ send-keys                                │ watcher task        │
│         ▼                                          │ (polls every 50ms)  │
│  ┌──────────────┐                                  ▼                     │
│  │ terminal_    │                         ┌───────────────────┐         │
│  │ input frame  │                         │ terminal_output   │         │
│  │ (from svc)   │                         │ frame             │         │
│  └──────────────┘                         │ {seq, data,       │         │
│                                           │  byte_offset}     │         │
│                                           └───────────────────┘         │
│                                                    │                     │
│  ┌────────────────────────────────────┐           │                     │
│  │ Readiness Detector                  │           │                     │
│  │ - Quiescence: watches log file size │           │                     │
│  │ - Activity: compares capture-pane   │           │                     │
│  │              hashes                 │           │                     │
│  └────────────────────────────────────┘           │                     │
│         │                                          │                     │
│         ▼                                          ▼                     │
│  ┌──────────────┐                         ┌───────────────────┐         │
│  │ terminal_    │                         │   WebSocket       │         │
│  │ ready frame  │                         │   (to service)    │         │
│  └──────────────┘                         └───────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           SERVICE (Node.js)                              │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────┐         │
│  │ TerminalSessionManager                                      │         │
│  │                                                             │         │
│  │  handleTerminalOutput():                                    │         │
│  │    1. Decode base64 data                                    │         │
│  │    2. Update lastOffsets Map (in-memory)                    │         │
│  │    3. INSERT into terminal_session_output table             │         │
│  │                                                             │         │
│  │  In-memory state:                                           │         │
│  │    - lastOffsets: Map<sessionId, number>                    │         │
│  │    - readiness: Map<sessionId, ReadinessAssessment>         │         │
│  │    - pendingCommands: Map<sessionId, PendingCommand>        │         │
│  └────────────────────────────────────────────────────────────┘         │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────┐         │
│  │ AgentService.executeTerminalCall()                          │         │
│  │                                                             │         │
│  │  1. offsetBeforeInput = getLastOffset(sessionId)            │         │
│  │  2. sendInput(sessionId, command)                           │         │
│  │  3. waitForReadiness(sessionId, timeout)                    │         │
│  │  4. IF repl mode:                                           │         │
│  │       output = capturePane()  // tmux screen                │         │
│  │     ELSE:                                                   │         │
│  │       output = tailOutput(sinceOffset: offsetBeforeInput)   │         │
│  │  5. Return output to LLM                                    │         │
│  └────────────────────────────────────────────────────────────┘         │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────┐         │
│  │ PostgreSQL: terminal_session_output                         │         │
│  │                                                             │         │
│  │  session_id | seq | byte_offset | data (bytea)             │         │
│  │  ─────────────────────────────────────────────              │         │
│  │  sess_01... | 0   | 0           | <chunk1>                 │         │
│  │  sess_01... | 1   | 256         | <chunk2>                 │         │
│  │  sess_01... | 2   | 512         | <chunk3>                 │         │
│  └────────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Race Condition Problem

```
Timeline:

T=0ms    Previous command finished, log file at byte 1000
T=10ms   Watcher task: detects bytes 900-1000, sends terminal_output frame
T=20ms   Service: receives frame, updates lastOffsets to 1000
T=30ms   [AGENT] offsetBeforeInput = getLastOffset() → returns 1000 ✓

T=50ms   [AGENT] sendInput("ls -la\n")
T=60ms   Bud: receives terminal_input, runs tmux send-keys
T=70ms   tmux: echoes "ls -la\n" to pipe-pane (bytes 1000-1007)
T=80ms   Watcher task: (hasn't run yet, polls every 50ms)

T=100ms  Command produces output: bytes 1007-1500
T=120ms  Watcher task: detects bytes 1000-1500, sends terminal_output frame
T=130ms  Service: receives frame, updates lastOffsets to 1500, stores in DB

T=200ms  [AGENT] tailOutput(sinceOffset: 1000)
         → Returns bytes 1000-1500 (CORRECT!)

BUT WHAT IF...

T=0ms    Previous command STILL producing output (bytes 900-950)
T=10ms   Watcher: sends terminal_output frame for bytes 900-950
T=15ms   [AGENT] offsetBeforeInput = getLastOffset() → returns 950 ✗
         (The previous command's output isn't done!)

T=20ms   Previous command produces bytes 950-1000
T=30ms   [AGENT] sendInput("ls -la\n")
T=40ms   Bud: receives terminal_input
T=50ms   Previous output: bytes 950-1000 still streaming
T=60ms   Watcher: sends frame for bytes 950-1000
T=70ms   New command output: bytes 1000-1500

T=200ms  [AGENT] tailOutput(sinceOffset: 950)
         → Returns bytes 950-1500
         → INCLUDES 50 bytes from previous command! ✗
```

### Why `capturePane` Works Better

`capturePane` asks tmux for the rendered screen - it doesn't use byte offsets at all. This means:
- It shows "what's visible now" rather than "bytes since offset X"
- Previous output naturally scrolls off screen
- No race conditions with byte tracking

But `capturePane` has limitations:
- Limited to visible screen (typically 50-200 lines)
- Long command output is truncated
- Full screen capture every time (not incremental)

### Current Code Flow

**Bud daemon `handle_input()` (main.rs:647-759):**
```rust
1. Decode base64 input data
2. Get start_offset from handle.offset.load()
3. tmux send-keys -t session_name -l text
4. tmux send-keys -t session_name Enter (for newlines)
5. IF await_ready.enabled:
     IF activity_based:
       spawn ActivityDetector
     ELSE:
       spawn ReadinessDetector(start_offset)
```

**Bud daemon `ReadinessDetector::run()` (main.rs:1317-1373):**
```rust
1. Wait for quiescence (no new bytes for X ms) OR timeout
2. Read tail of log file (end_size - start_offset)
3. Assess readiness (prompt detection heuristics)
4. Send terminal_ready frame with assessment + output_since_input
```

**Service `executeTerminalCall()` (agent-service.ts:712-910):**
```typescript
1. offsetBeforeInput = getLastOffset(sessionId)
2. sendInput(sessionId, command)
3. waitForReadiness(sessionId, timeout)
4. IF context.mode === "repl":
     output = await capturePane()
   ELSE:
     output = await tailOutput(sinceOffset: offsetBeforeInput)
5. Return TerminalCallResult
```

**Service `tailOutput()` (terminal-session-manager.ts:686-788):**
```typescript
1. Query: SELECT * FROM terminal_session_output
          WHERE session_id = ? AND byte_offset >= sinceOffset
          ORDER BY byte_offset ASC LIMIT 200
2. Concatenate chunks into single buffer
3. Return { data, totalBytes }
```

---

## Root Causes

### 1. Offset Capture Timing

The offset is captured **before** sending input, but:
- Previous command output might still be streaming
- There's latency between bytes appearing and `lastOffsets` being updated
- The "boundary" between commands isn't well-defined

### 2. No Input Markers

The byte stream has no markers saying "user input started here". We can't distinguish between:
- Previous command output (stale)
- Command echo (the typed command)
- New command output (what we want)
- Next shell prompt

### 3. Two Divergent Paths

Shell mode uses `tailOutput()` (byte offsets) while REPL mode uses `capturePane()` (screen capture). These have fundamentally different semantics, making the behavior inconsistent.

### 4. Command Echo

When you type `ls -la\n`, tmux echoes it to the output. This echo appears at the offset we just captured, so it gets included in the "new" output.

---

## Proposed Solutions

### Approach 1: Input Acknowledgment with Offset (Recommended)

**Concept:** Capture the byte offset **after** the input is processed by bud, not before.

**Protocol Change:**

```json
// Service → Bud: terminal_input (unchanged)
{
  "type": "terminal_input",
  "session_id": "sess_01...",
  "data": "base64-encoded-input",
  "await_ready": { "enabled": true }
}

// NEW: Bud → Service: terminal_input_ack
{
  "type": "terminal_input_ack",
  "session_id": "sess_01...",
  "input_id": "msg_01...",
  "output_offset": 1007,  // Byte offset AFTER command echo
  "echoed_bytes": 7       // Optional: how many bytes were echoed
}
```

**Implementation:**

1. Bud sends `terminal_input_ack` immediately after `tmux send-keys` completes
2. Bud includes current log file size as `output_offset`
3. Service uses this offset for `tailOutput()` instead of pre-captured offset

**Pros:**
- Clean boundary: "output after my input was received"
- No race conditions with previous command output
- Works with existing byte-offset infrastructure

**Cons:**
- Protocol change required
- Still includes command echo (but could strip based on `echoed_bytes`)
- Requires bud daemon modification

**Complexity:** Medium

---

### Approach 2: Unified capturePane for All Modes

**Concept:** Use `capturePane()` for both shell and REPL modes, with intelligent handling for long output.

**Implementation:**

```typescript
async executeTerminalCall(): Promise<TerminalCallResult> {
  await sendInput(sessionId, command);
  await waitForReadiness(sessionId, timeout);

  // Always use capturePane, with fallback to tailOutput for long output
  const capture = await capturePane(sessionId, { startLine: -100 });

  // If we suspect output was truncated (e.g., command was `cat large_file.txt`)
  // or if confidence suggests more output might be off-screen:
  if (isLikelyLongOutput(command) || capture.outputBytes > THRESHOLD) {
    const tail = await tailOutput(sessionId, maxBytes, { sinceOffset: offsetBeforeInput });
    return mergeCaptures(capture, tail);
  }

  return { output: capture.output, ... };
}
```

**Pros:**
- Consistent behavior across modes
- capturePane naturally shows "current state"
- Simpler mental model

**Cons:**
- Loses output that scrolled off screen
- Breaks the incremental byte-offset model
- May miss important output for long-running commands

**Complexity:** Low (service-only change)

---

### Approach 3: Prompt-Based Output Extraction

**Concept:** Post-process the output to find prompt boundaries and extract only the current command's output.

**Implementation:**

```typescript
function extractCommandOutput(fullOutput: string, command: string): string {
  const lines = fullOutput.split('\n');

  // Find prompts using readiness heuristics
  const promptIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeShellPrompt(lines[i])) {
      promptIndices.push(i);
    }
  }

  // Find the command echo (identifies where our command started)
  const commandEchoIndex = lines.findIndex(line =>
    line.includes(command.trim())
  );

  if (commandEchoIndex >= 0) {
    // Output is everything from command echo to last prompt
    const lastPromptIndex = promptIndices[promptIndices.length - 1] ?? lines.length;
    return lines.slice(commandEchoIndex, lastPromptIndex + 1).join('\n');
  }

  // Fallback: if 2+ prompts, take from second-to-last to last
  if (promptIndices.length >= 2) {
    const start = promptIndices[promptIndices.length - 2];
    return lines.slice(start).join('\n');
  }

  return fullOutput;
}
```

**Pros:**
- No protocol changes
- Works with existing infrastructure
- Can be combined with other approaches

**Cons:**
- Heuristic-based (may fail on edge cases)
- Doesn't work if output contains prompt-like text
- Fragile for commands that produce unusual output

**Complexity:** Low (service-only change)

---

### Approach 4: Sentinel Markers

**Concept:** Inject invisible markers into the terminal stream to delimit command boundaries.

**Implementation:**

```typescript
// Wrap command with markers
const START_MARKER = '\x1b]9999;START_' + ulid() + '\x07';
const END_MARKER = '\x1b]9999;END_' + ulid() + '\x07';

// Instead of just sending the command, wrap it:
const wrappedCommand = `printf '${START_MARKER}'; ${command}; printf '${END_MARKER}'\n`;
await sendInput(sessionId, wrappedCommand);

// Later, extract between markers:
function extractBetweenMarkers(output: string): string {
  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);
  if (startIdx >= 0 && endIdx > startIdx) {
    return output.slice(startIdx + startMarker.length, endIdx);
  }
  return output;
}
```

**Pros:**
- Precise boundaries
- Works for complex commands
- No timing/race issues

**Cons:**
- Modifies the user's command
- May not work in all shells (especially REPLs)
- Pollutes the terminal with extra commands
- Changes exit code behavior (last command is `printf`)

**Complexity:** Medium

---

### Approach 5: Readiness-Driven Output Return (from Bud)

**Concept:** Have bud daemon include the relevant output in the `terminal_ready` frame, using its local knowledge of when input arrived.

**Current `terminal_ready` frame:**
```json
{
  "type": "terminal_ready",
  "assessment": {...},
  "output_since_input": "base64...",  // Already exists!
  "output_bytes": 1234,
  "last_line": "user@host:~$ "
}
```

Bud already sends `output_since_input` in the ready frame! The issue is the service doesn't use it.

**Implementation (service change only):**

```typescript
async executeTerminalCall(): Promise<TerminalCallResult> {
  const start_offset = getLastOffset(sessionId);
  await sendInput(sessionId, command);

  // waitForReadiness now returns the full assessment including output
  const readiness = await waitForReadiness(sessionId, timeout);

  // Use bud's output_since_input instead of querying DB
  if (readiness.output_since_input) {
    const output = Buffer.from(readiness.output_since_input, 'base64').toString('utf-8');
    return {
      output: stripAnsi(output),
      outputBytes: readiness.output_bytes,
      readiness: readiness.assessment,
      ...
    };
  }

  // Fallback to tailOutput if no output in ready frame
  const tail = await tailOutput(sessionId, maxBytes, { sinceOffset: start_offset });
  return { output: decodeTail(tail.data), ... };
}
```

**Pros:**
- Bud knows exactly when input arrived
- Already implemented on bud side (output_since_input)
- No protocol changes needed
- Bud's `start_offset` is more accurate (captured at input time)

**Cons:**
- Need to verify bud's offset tracking is correct
- Large output may be truncated (16KB limit in bud)
- May not work for REPL/activity-based detection

**Complexity:** Low (service-only change)

---

## Recommendation

### Short-term: Approach 5 (Use Bud's `output_since_input`)

The quickest fix with highest confidence. Bud already tracks the offset at input time and sends `output_since_input` in the ready frame. The service just needs to use it instead of querying the DB.

**Steps:**
1. Modify `handleTerminalReady()` to store `output_since_input`
2. Modify `waitForReadiness()` to return the full ready payload
3. Modify `executeTerminalCall()` to use bud's output instead of `tailOutput()`

### Medium-term: Approach 1 (Input Acknowledgment)

For a more robust solution, add `terminal_input_ack` to the protocol. This gives explicit confirmation of when input was processed and what the byte offset is at that moment.

### Long-term: Consider Approach 2 (Unified capturePane)

As we better understand usage patterns, consider whether `capturePane` should be the default for all modes. This simplifies the mental model but requires careful handling of long output.

---

## Implementation Notes

### Verifying Bud's `output_since_input`

Check `ReadinessDetector::read_tail()` (main.rs:1375-1394):

```rust
async fn read_tail(&self, end_size: u64) -> (usize, String, String) {
    const MAX_READ: usize = 16 * 1024;
    let start = self.start_offset;  // Offset at time of input
    if end_size <= start {
        return (0, String::new(), String::new());
    }
    let to_read = std::cmp::min((end_size - start) as usize, MAX_READ);
    // ... reads from (end_size - to_read) to end_size
}
```

**Issue:** This reads the tail, not from `start_offset`. It should read from `start_offset` to `end_size`.

**Fix needed in bud daemon:**
```rust
async fn read_tail(&self, end_size: u64) -> (usize, String, String) {
    let start = self.start_offset;
    if end_size <= start {
        return (0, String::new(), String::new());
    }
    let to_read = (end_size - start) as usize;
    let clamped = std::cmp::min(to_read, MAX_READ);

    // Read from start_offset, not from (end_size - to_read)
    file.seek(SeekFrom::Start(start)).await;
    // ...
}
```

### DB Query Optimization

For the short-term fix, we might still want `tailOutput()` as a fallback. Ensure the query is efficient:

```sql
-- Current query
SELECT data, byte_offset
FROM terminal_session_output
WHERE session_id = ? AND byte_offset >= sinceOffset
ORDER BY byte_offset ASC
LIMIT 200;

-- Add index if not exists
CREATE INDEX IF NOT EXISTS idx_terminal_output_offset
ON terminal_session_output(session_id, byte_offset);
```

---

## Questions to Resolve

1. **Is bud's `start_offset` accurate?** The offset is captured right before `tmux send-keys`. Does it include the command echo?

2. **What's the 16KB limit impact?** Bud's `read_tail()` limits to 16KB. Is this sufficient for typical command output?

3. **Activity-based detection?** `ActivityDetector` doesn't send `output_since_input`. Should it?

4. **REPL mode behavior?** Should REPL mode also use `output_since_input`, or continue with `capturePane`?

---

## Appendix: File Locations

| Component | File | Key Lines |
|-----------|------|-----------|
| Bud output watcher | `bud/src/main.rs` | 1230-1293 |
| Bud ReadinessDetector | `bud/src/main.rs` | 1300-1546 |
| Bud ActivityDetector | `bud/src/main.rs` | 1561-1755 |
| Bud handle_input | `bud/src/main.rs` | 647-759 |
| Service executeTerminalCall | `service/src/agent/agent-service.ts` | 712-910 |
| Service tailOutput | `service/src/runtime/terminal-session-manager.ts` | 686-788 |
| Service handleTerminalReady | `service/src/runtime/terminal-session-manager.ts` | 549-575 |
| Service capturePane | `service/src/runtime/terminal-session-manager.ts` | 793-839 |

---

*Created: 2025-12-20*
