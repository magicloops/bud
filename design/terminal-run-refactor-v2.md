# Design: terminal.run Refactor (V2 - Ownership-First)

**Status:** Draft
**Created:** 2025-12-20
**Supersedes:** [`design/terminal-run-output-redesign.md`](./terminal-run-output-redesign.md)

---

## Design Principles

Before diving into solutions, let's establish the ownership boundaries that should guide this design:

### Ownership Boundaries

| Component | Owns | Should NOT Own |
|-----------|------|----------------|
| **Bud Daemon** | Terminal state, tmux session, output capture, readiness detection, log file | Conversation history, user sessions, thread management |
| **Service** | Request routing, LLM coordination, conversation history, thread/session management, SSE streaming | Terminal output storage (for agent use), byte offset tracking |
| **PostgreSQL** | Message persistence, thread metadata, session metadata | Real-time terminal output (for agent consumption) |

### Design Goals

1. **Simple**: Minimize moving parts, eliminate redundant state
2. **Robust**: Works reliably, easy to debug, predictable behavior
3. **Clean API contracts**: Each component has well-defined responsibilities
4. **TUI support**: Don't break existing TUI/REPL functionality

---

## Current Architecture Problems

### Problem 1: Duplicated State

The service maintains terminal state that Bud already has:

```
Service:
├── lastOffsets Map (in-memory)      ← Duplicates Bud's log file offset
├── terminal_session_output table    ← Duplicates Bud's log file content
└── readiness Map (in-memory)        ← Already comes from Bud
```

### Problem 2: Wrong Source of Truth

When the agent needs command output, it queries PostgreSQL:

```
Agent calls terminal.run("ls -la\n")
  ↓
Service: captures offset from memory
Service: sends terminal_input to Bud
Bud: executes command, streams output, sends terminal_ready with output_since_input
Service: IGNORES output_since_input ← !!!
Service: queries PostgreSQL for output ← Wrong source!
  ↓
Agent receives stale/incorrect output
```

The irony: **Bud already sends `output_since_input` in the `terminal_ready` frame**, but the service ignores it.

### Problem 3: Race Conditions

```
T=0ms   offsetBeforeInput = 1000 (stale - previous output still streaming)
T=10ms  sendInput("ls -la\n")
T=50ms  terminal_output frames arrive (bytes 950-1000 from PREVIOUS command)
T=100ms New command output (bytes 1000-1500)
T=200ms Query: WHERE byte_offset >= 1000
        └─ May include bytes 950-1000 from previous command
```

### Problem 4: Complex Code Path

```
                    ┌─────────────────────────────────────────────┐
                    │           Current Flow (Convoluted)          │
                    └─────────────────────────────────────────────┘

Agent ──terminal.run──> Service
                          │
         ┌────────────────┴────────────────┐
         ↓                                 ↓
   getLastOffset()              sendInput()────────────> Bud
   (in-memory map)                                        │
         │                                                │
         │              ┌──────────────────────────────┬──┘
         │              ↓                              ↓
         │    terminal_output frames         terminal_ready frame
         │              │                      (with output_since_input!)
         │              ↓                              │
         │    handleTerminalOutput()                   │
         │    └─> INSERT PostgreSQL ←───(IGNORED!)─────┘
         │    └─> update lastOffsets                   ↓
         │                                    handleTerminalReady()
         │                                    └─> store assessment only
         │                                             │
         ↓                                             ↓
   waitForReadiness() <────polling 100ms────────(completes)
         │
         ↓
   tailOutput(sinceOffset)
   └─> SELECT FROM PostgreSQL  ← Wrong source! Should use Bud's output_since_input
         │
         ↓
   Return to Agent (possibly stale/wrong output)
```

---

## Proposed Architecture

### Core Insight

**Bud is the source of truth for terminal state. The service should ask Bud for output, not PostgreSQL.**

The existing `terminal_capture` pattern is the right model:
- Service sends request with `request_id`
- Bud responds with `terminal_capture_response` containing output
- Service resolves pending promise

We should apply the same pattern to `terminal.run`.

### The Clean Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │           Proposed Flow (Clean)              │
                    └─────────────────────────────────────────────┘

Agent ──terminal.run──> Service
                          │
                          ↓
              Send terminal_run { input, request_id, mode }
                          │
                          └──────────────────────────> Bud
                                                        │
                                        ┌───────────────┴──────────────┐
                                        ↓                              ↓
                              tmux send-keys                   (continues)
                                        │                              │
                                        ↓                              │
                              Wait for readiness                       │
                              (quiescence or activity-based)           │
                                        │                              │
                                        ↓                              │
                              Read output:                             │
                              - Shell: log file (offset → current)     │
                              - REPL: capture-pane                     │
                                        │                              │
                                        ↓                              │
                              Send terminal_run_result                 │
                              { output, readiness, request_id }        │
                                        │                              │
              ┌─────────────────────────┘                              │
              ↓                                                        │
   Service: resolve pending request                                    │
              ↓                                                        │
   Return to Agent (correct output!)                                   │
                                                                       │
                                              (Meanwhile, streaming continues)
                                                        ↓
                                              terminal_output frames
                                                        ↓
                                              Forward to SSE (UI display only)
```

### What Changes

| Component | Current | Proposed |
|-----------|---------|----------|
| **Bud** | Streams output + sends terminal_ready | Adds terminal_run_result response |
| **Service** | Stores output in Postgres, queries back | Uses Bud's response directly |
| **PostgreSQL** | Stores terminal_session_output | Optional (audit/debug only) |

### What Stays

| Component | Behavior | Reason |
|-----------|----------|--------|
| `terminal_output` streaming | Unchanged | UI needs real-time display |
| `terminal_capture` | Unchanged | TUI apps need screen capture |
| `terminal_interrupt` | Unchanged | Ctrl+C for interrupting |
| `terminal_ready` | Unchanged | Can still be used for "fire and forget" input |

---

## Detailed Design

### Protocol: New Messages

```typescript
// Service → Bud: terminal_run (request)
interface TerminalRunRequest {
  proto: "0.2";
  type: "terminal_run";
  id: string;
  ts: number;
  ext: {};
  session_id: string;
  request_id: string;           // For response correlation
  input: string;                // Base64 encoded
  mode?: "shell" | "repl";      // Hint for output retrieval
  timeout_ms?: number;          // Max wait (default 30000)
}

// Bud → Service: terminal_run_result (response)
interface TerminalRunResult {
  proto: "0.2";
  type: "terminal_run_result";
  id: string;
  ts: number;
  ext: {};
  session_id: string;
  request_id: string;           // Matches request
  output: string;               // Base64 encoded output
  output_bytes: number;
  truncated: boolean;           // If output exceeded max size
  readiness: {
    ready: boolean;
    confidence: number;
    trigger: string;
    hints: ReadinessHints;
  };
  error?: string;               // If something went wrong
}
```

### Bud Implementation

```rust
async fn handle_run(&mut self, msg: &Value) -> Result<()> {
    let request_id = msg["request_id"].as_str().unwrap_or("");
    let input_b64 = msg["input"].as_str().unwrap_or("");
    let mode = msg["mode"].as_str().unwrap_or("shell");
    let timeout_ms = msg["timeout_ms"].as_u64().unwrap_or(30000);

    // 1. Record current log offset (for shell mode)
    let start_offset = self.log_handle.offset.load(Ordering::SeqCst);

    // 2. Send input to tmux
    self.send_keys(&input_data)?;

    // 3. Wait for readiness (same logic as current)
    let (assessment, output) = if mode == "repl" {
        // Activity-based: use capture-pane for output
        let assessment = self.wait_activity_based(timeout_ms).await?;
        let output = self.capture_pane().await?;
        (assessment, output)
    } else {
        // Quiescence-based: read from log file
        let (assessment, log_end) = self.wait_quiescence(timeout_ms).await?;
        let output = self.read_log(start_offset, log_end)?;
        (assessment, output)
    };

    // 4. Send response
    let payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_run_result",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": self.session_id,
        "request_id": request_id,
        "output": BASE64_STANDARD.encode(&output),
        "output_bytes": output.len(),
        "truncated": output.len() > MAX_OUTPUT,
        "readiness": assessment,
    });
    send_ws_frame(&self.sender, payload)?;
    Ok(())
}
```

### Service Implementation

```typescript
// terminal-session-manager.ts

// Add pending requests map (like pendingCaptures)
private readonly pendingRuns = new Map<
  string,
  {
    resolve: (result: TerminalRunResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// New method: runCommand (request-response)
async runCommand(
  sessionId: string,
  input: Buffer,
  options: { mode?: "shell" | "repl"; timeoutMs?: number } = {}
): Promise<TerminalRunResult> {
  const session = await this.getSession(sessionId);
  if (!session) throw new Error("session_not_found");

  const requestId = `run_${ulid()}`;
  const timeoutMs = options.timeoutMs ?? 30000;

  const payload = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_run",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    session_id: sessionId,
    request_id: requestId,
    input: input.toString("base64"),
    mode: options.mode ?? "shell",
    timeout_ms: timeoutMs,
  };

  const sent = sendFrameToBud(session.budId, payload);
  if (!sent) throw new Error("bud_offline");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingRuns.delete(requestId);
      reject(new Error("run_timeout"));
    }, timeoutMs + 5000); // Extra buffer for network

    this.pendingRuns.set(requestId, { resolve, reject, timeout });
  });
}

// Handler for terminal_run_result (called by gateway)
handleRunResult(sessionId: string, payload: TerminalRunResultPayload): void {
  const pending = this.pendingRuns.get(payload.requestId);
  if (!pending) {
    this.logger.warn({ sessionId, requestId: payload.requestId }, "Orphaned run result");
    return;
  }

  clearTimeout(pending.timeout);
  this.pendingRuns.delete(payload.requestId);

  if (payload.error) {
    pending.reject(new Error(payload.error));
    return;
  }

  pending.resolve({
    output: Buffer.from(payload.output, "base64").toString("utf-8"),
    outputBytes: payload.outputBytes,
    truncated: payload.truncated,
    readiness: payload.readiness,
  });
}
```

### Agent Service Changes

```typescript
// agent-service.ts - executeTerminalCall becomes much simpler

if (directive.tool === "terminal.run") {
  const context = getContext();
  const mode = context.mode === "repl" ? "repl" : "shell";

  // One call - gets output directly from Bud
  const result = await this.terminalSessionManager.runCommand(
    sessionId,
    Buffer.from(directive.input ?? "", "utf-8"),
    { mode, timeoutMs: directive.timeoutMs ?? 30000 }
  );

  return {
    output: this.stripAnsi(result.output),
    outputBytes: result.outputBytes,
    readiness: result.readiness,
    truncated: result.truncated,
    omittedLines: 0,
    context,
  };
}
```

---

## What Gets Removed/Simplified

### Service Simplifications

1. **Remove `lastOffsets` Map** - Bud tracks offsets, service doesn't need to
2. **Remove `tailOutput()` for agent use** - Output comes from Bud's response
3. **Simplify `handleTerminalOutput()`** - Forward to SSE, optional DB storage
4. **Simplify `waitForReadiness()`** - Not needed for agent path (response includes readiness)

### Optional: Output Storage

Terminal output storage in PostgreSQL becomes **optional** and serves different purposes:

| Purpose | Needed? | Notes |
|---------|---------|-------|
| Agent tool output | No | Comes from Bud's response |
| UI real-time display | No | Comes from SSE streaming |
| Session backfill | Maybe | Use `terminal_capture` instead |
| Audit/debugging | Optional | Keep for compliance if needed |

**Recommendation**: Make output storage configurable. Default to disabled, enable for debugging/audit.

---

## TUI Support Analysis

This design preserves TUI functionality:

### Scenario: Agent runs `vim file.txt`

```
1. Agent: terminal.run("vim file.txt\n", mode="repl")
2. Service: sends terminal_run to Bud
3. Bud:
   - Sends keys to tmux
   - Uses ActivityDetector (screen comparison)
   - When stable: captures screen via capture-pane
   - Sends terminal_run_result with screen content
4. Agent: receives vim screen, can interact
```

### Scenario: Agent interacts with Claude Code

```
1. Agent: terminal.run("claude\n", mode="repl")
2. Bud: waits for activity-stable, returns initial screen
3. Agent: terminal.run("Review this file\n", mode="repl")
4. Bud: waits for Claude's response to stabilize, returns screen
5. Agent: sees Claude's response
```

### Scenario: Agent needs more scrollback

```
1. Agent: terminal.capture(lines=-500)
2. Service: sends terminal_capture to Bud
3. Bud: returns capture-pane output
4. Agent: sees more history
```

---

## Migration Path

### Phase 1: Add terminal_run/result (Non-Breaking)

1. Add `terminal_run` handler to Bud
2. Add `terminal_run_result` handler to Service
3. Add `runCommand()` method to TerminalSessionManager
4. Update `executeTerminalCall()` to use new path
5. Keep existing `terminal_input` + `tailOutput()` as fallback

### Phase 2: Validate & Test

1. Compare outputs from both paths
2. Measure latency difference
3. Test TUI scenarios thoroughly
4. Test long-running commands
5. Test network interruption recovery

### Phase 3: Clean Up

1. Remove `lastOffsets` Map
2. Make output storage optional
3. Remove `tailOutput()` agent path
4. Update documentation

---

## Comparison: Current vs Proposed

| Aspect | Current | Proposed |
|--------|---------|----------|
| **State tracking** | Service duplicates Bud's state | Service asks Bud |
| **Output source** | PostgreSQL (stale) | Bud (fresh) |
| **Race conditions** | Many | None |
| **Code complexity** | High | Low |
| **Debugging** | Hard (multiple sources) | Easy (single source) |
| **Latency** | Higher (DB round-trip) | Lower (direct) |
| **TUI support** | Works | Works (unchanged) |

---

## Questions to Resolve

1. **Max output size?** What's the right limit for `output` in the response? (Current: 16KB in Bud's read_tail)

2. **Timeout handling?** What happens if Bud crashes mid-request? (Need service-side timeout + cleanup)

3. **Concurrent requests?** Should we allow multiple pending `terminal_run` requests per session? (Probably not - serialize)

4. **Backward compatibility?** Should we keep `terminal_input` for UI keyboard input? (Yes - it's fire-and-forget, no response needed)

5. **Output streaming?** For very long output, should we stream chunks? (Probably not for MVP - truncate + let agent use capture for more)

---

## Appendix: Alternative Approaches Considered

### Alternative 1: Just Use output_since_input

The simplest fix - use the `output_since_input` field that Bud already sends in `terminal_ready`.

**Pros:**
- No protocol changes
- Minimal code changes

**Cons:**
- `terminal_ready` is fire-and-forget (event, not request-response)
- ActivityDetector doesn't include `output_since_input`
- Still need request-response correlation for reliability

**Verdict:** Good for quick fix, but doesn't solve the fundamental architecture issue.

### Alternative 2: Keep PostgreSQL, Fix Timing

Fix the race conditions by synchronizing the offset capture with database writes.

**Pros:**
- No protocol changes
- Keeps existing architecture

**Cons:**
- Doesn't address ownership boundary violation
- Adds complexity (sync primitives)
- PostgreSQL remains unnecessary middleman

**Verdict:** Treats symptoms, not cause.

### Alternative 3: Stream Output in Response

Instead of returning complete output, stream chunks as they arrive.

**Pros:**
- Better for long-running commands
- More responsive

**Cons:**
- Complex implementation
- May not be needed (agent can use capture for long output)
- Doesn't fit tool_result model well

**Verdict:** Over-engineered for current needs. Consider for future if needed.

---

## Summary

The core insight: **Bud already knows the command output. The service should ask Bud, not reconstruct it from stored fragments.**

The proposed `terminal_run` / `terminal_run_result` request-response pattern:
- Follows the established `terminal_capture` pattern
- Respects ownership boundaries (Bud owns terminal state)
- Eliminates race conditions (single source of truth)
- Simplifies the codebase (removes redundant state)
- Preserves TUI functionality (uses capture-pane for REPL mode)

---

*Created: 2025-12-20*
