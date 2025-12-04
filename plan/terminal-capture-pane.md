# Terminal Capture-Pane Implementation Plan

_Created: 2025-12-04_

## Overview

This plan adds `tmux capture-pane` support to improve agent visibility into TUI-based REPLs like Claude Code. The current `pipe-pane` approach captures raw byte streams which produce garbled output for TUI applications. `capture-pane` captures the rendered screen buffer - exactly what the user sees.

## Requirements

1. **Auto-switch for REPL context**: When `context.mode === "repl"`, automatically use `capture-pane` instead of reading from the pipe-pane log file.

2. **New `terminal.capture` tool**: Allow the agent to explicitly request a screen capture with configurable scrollback, enabling "scroll up" functionality for TUI contexts.

## Current Architecture

### Data Flow (Status Quo)

```
Agent sends terminal.run
         ↓
Service: capture offset → sendInput → waitForReadiness → tailOutput(sinceOffset)
         ↓
Bud: send-keys → spawn ReadinessDetector → monitor quiescence → terminal_ready
         ↓
Output: pipe-pane log file → terminal_output frames → DB → tailOutput query
```

### Key Files

| Component | File | Purpose |
|-----------|------|---------|
| Frame dispatch | `bud/src/main.rs:2029-2043` | Routes incoming frames to handlers |
| Input handler | `bud/src/main.rs:833-910` | Processes `terminal_input`, spawns readiness |
| Readiness | `bud/src/main.rs:1235-1443` | Quiescence detection, prompt analysis |
| Gateway | `service/src/ws/gateway.ts:452-495` | Receives terminal frames from Bud |
| Manager | `service/src/runtime/terminal-manager.ts` | State, output storage, readiness tracking |
| Agent | `service/src/agent/agent-service.ts:882-1015` | Tool execution, output retrieval |

### Current Output Retrieval

```typescript
// terminal.run flow (agent-service.ts:950-1014)
const offsetBeforeInput = this.terminalManager.getLastOffset(budId);
await this.terminalManager.sendInput(budId, Buffer.from(input));
const readiness = await this.terminalManager.waitForReadiness(budId, timeoutMs);
const tail = await this.terminalManager.tailOutput(budId, maxBytes, { sinceOffset });
const decoded = this.decodeTail(tail.data);  // ANSI strip, CRLF normalize
```

### Problem with TUI Apps

`tailOutput` reads from the pipe-pane log which contains:
- Raw byte stream with all cursor movements
- Screen clears, overwrites, partial redraws
- ANSI sequences that only make sense in a terminal emulator

After ANSI stripping, TUI output becomes garbled text.

---

## Design

### Approach: Hybrid pipe-pane + capture-pane

| Use Case | Method | Rationale |
|----------|--------|-----------|
| Frontend streaming | `pipe-pane` → SSE | Real-time display in xterm.js |
| Shell command output | `pipe-pane` → tailOutput | Works well for line-based output |
| REPL/TUI output | `capture-pane` | Rendered screen buffer |
| Agent scroll-up | `capture-pane` with offset | Historical screen content |

### New Frame Types

#### Request: `terminal_capture` (Service → Bud)

```json
{
  "proto": "0.2",
  "type": "terminal_capture",
  "id": "msg_01ABC...",
  "ts": 1733300000000,
  "ext": {},
  "request_id": "cap_01XYZ...",
  "options": {
    "start_line": -500,
    "end_line": null,
    "escape_sequences": false,
    "join_lines": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `request_id` | string | Correlation ID for response matching |
| `options.start_line` | int? | Start line (`-N` for scrollback, `0` for visible top, `null` for all) |
| `options.end_line` | int? | End line (`null` or `-` for visible bottom) |
| `options.escape_sequences` | bool | Include ANSI colors (`-e` flag) |
| `options.join_lines` | bool | Join wrapped lines (`-J` flag) |

#### Response: `terminal_capture_response` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_capture_response",
  "id": "msg_02DEF...",
  "ts": 1733300000100,
  "ext": {},
  "request_id": "cap_01XYZ...",
  "output": "base64-encoded-screen-content",
  "output_bytes": 4500,
  "lines_captured": 45,
  "error": null
}
```

### New Tool: `terminal.capture`

```typescript
const TERMINAL_CAPTURE_TOOL = {
  type: "function",
  name: "terminal_capture",
  description: "Capture the current terminal screen. Use this to see rendered TUI output or scroll up in history.",
  parameters: {
    type: "object",
    properties: {
      lines: {
        type: "integer",
        description: "Number of lines of scrollback to include (default: 100, max: 1000)",
        nullable: true
      },
      timeout_ms: {
        type: "integer",
        description: "Max wait time in milliseconds (default: 5000)",
        nullable: true
      }
    },
    required: [],
    additionalProperties: false
  },
  strict: true
};
```

### Auto-Switch Logic

In `executeTerminalCall`, after readiness:

```typescript
// Determine output retrieval method based on context
const context = this.terminalManager.getTerminalContext(bud.budId);

let output: string;
let outputBytes: number;

if (context.mode === "repl") {
  // TUI/REPL: use capture-pane for accurate rendered output
  const capture = await this.terminalManager.capturePane(bud.budId, {
    startLine: -200,  // Last 200 lines
    joinLines: true
  });
  output = capture.output;
  outputBytes = capture.outputBytes;
} else {
  // Shell: use pipe-pane log (works well for line-based output)
  const tail = await this.terminalManager.tailOutput(budId, maxBytes, { sinceOffset });
  output = this.decodeTail(tail.data);
  outputBytes = tail.totalBytes;
}
```

---

## Implementation Phases

### Phase 1: Bud-side capture-pane support

**Files:** `bud/src/main.rs`

#### 1.0 Increase tmux history-limit

When creating a new tmux session (around line 1078), add history-limit option:

```rust
// After session creation, set history limit for scrollback
Command::new("tmux")
    .args(["set-option", "-t", &session_name, "history-limit", "5000"])
    .status()
    .await?;
```

This ensures the agent can request up to 1000 lines of scrollback with headroom.

#### 1.1 Add frame types

```rust
#[derive(Debug, Deserialize)]
struct TerminalCaptureFrame {
    #[serde(flatten)]
    envelope: TerminalEnvelope,
    request_id: String,
    #[serde(default)]
    options: CaptureOptions,
}

#[derive(Debug, Deserialize, Default)]
struct CaptureOptions {
    start_line: Option<i32>,    // -N for scrollback, 0 for top, None for all
    end_line: Option<i32>,      // None for bottom
    escape_sequences: bool,     // -e flag
    join_lines: bool,           // -J flag
}
```

#### 1.2 Add handler

```rust
async fn handle_capture(&self, frame: TerminalCaptureFrame) -> Result<()> {
    let handle = self.get_handle()?;

    let mut args = vec!["capture-pane", "-p", "-t", &handle.session_name];

    if frame.options.join_lines {
        args.push("-J");
    }
    if frame.options.escape_sequences {
        args.push("-e");
    }
    if let Some(start) = frame.options.start_line {
        args.extend(["-S", &start.to_string()]);
    }
    if let Some(end) = frame.options.end_line {
        args.extend(["-E", &end.to_string()]);
    }

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .await?;

    let response = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_capture_response",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "request_id": frame.request_id,
        "output": BASE64_STANDARD.encode(&output.stdout),
        "output_bytes": output.stdout.len(),
        "lines_captured": output.stdout.iter().filter(|&&b| b == b'\n').count(),
        "error": if output.status.success() { Value::Null } else {
            Value::String(String::from_utf8_lossy(&output.stderr).to_string())
        }
    });

    send_ws_frame(&self.sender, response)?;
    Ok(())
}
```

#### 1.3 Add to frame dispatcher

```rust
"terminal_capture" => {
    let frame: TerminalCaptureFrame = serde_json::from_str(text)?;
    self.terminal_manager.handle_capture(frame).await?;
}
```

### Phase 2: Service-side capture support

**Files:** `service/src/ws/gateway.ts`, `service/src/runtime/terminal-manager.ts`

#### 2.1 Add Zod schema for response

```typescript
// gateway.ts
const TerminalCaptureResponseSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_capture_response"),
  request_id: z.string(),
  output: z.string(),  // base64
  output_bytes: z.number().int().nonnegative(),
  lines_captured: z.number().int().nonnegative(),
  error: z.string().nullable()
});
```

#### 2.2 Add response handler in gateway

```typescript
// In frame dispatcher
case "terminal_capture_response": {
  const parsed = TerminalCaptureResponseSchema.safeParse(json);
  if (!parsed.success) {
    logDebug({ error: parsed.error }, "Invalid terminal_capture_response");
    break;
  }
  const { data: payload } = parsed;
  await terminalManager.handleCaptureResponse(state.budId, payload);
  break;
}
```

#### 2.3 Add capture methods to TerminalManager

```typescript
// terminal-manager.ts

// Pending capture requests (for async correlation)
private readonly pendingCaptures = new Map<string, {
  resolve: (result: CaptureResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

interface CaptureOptions {
  startLine?: number;
  endLine?: number;
  escapeSequences?: boolean;
  joinLines?: boolean;
}

interface CaptureResult {
  output: string;
  outputBytes: number;
  linesCaptured: number;
  error?: string;
}

async capturePane(
  budId: string,
  options: CaptureOptions = {},
  timeoutMs = 5000
): Promise<CaptureResult> {
  const requestId = `cap_${ulid()}`;

  const payload = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_capture",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    request_id: requestId,
    options: {
      start_line: options.startLine ?? -200,
      end_line: options.endLine ?? null,
      escape_sequences: options.escapeSequences ?? false,
      join_lines: options.joinLines ?? true
    }
  };

  const sent = sendFrameToBud(budId, payload);
  if (!sent) {
    throw new Error("bud_offline");
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingCaptures.delete(requestId);
      reject(new Error("capture_timeout"));
    }, timeoutMs);

    this.pendingCaptures.set(requestId, { resolve, reject, timeout });
  });
}

handleCaptureResponse(budId: string, payload: {
  request_id: string;
  output: string;
  output_bytes: number;
  lines_captured: number;
  error: string | null;
}): void {
  const pending = this.pendingCaptures.get(payload.request_id);
  if (!pending) {
    this.logger.warn({ budId, requestId: payload.request_id }, "Orphaned capture response");
    return;
  }

  clearTimeout(pending.timeout);
  this.pendingCaptures.delete(payload.request_id);

  if (payload.error) {
    pending.reject(new Error(payload.error));
    return;
  }

  const buffer = Buffer.from(payload.output, "base64");
  pending.resolve({
    output: buffer.toString("utf-8"),
    outputBytes: payload.output_bytes,
    linesCaptured: payload.lines_captured
  });
}
```

### Phase 3: Agent tool integration

**Files:** `service/src/agent/agent-service.ts`

#### 3.1 Add tool definition

```typescript
const TERMINAL_CAPTURE_TOOL = {
  type: "function" as const,
  name: "terminal_capture",
  description:
    "Capture the rendered terminal screen. Use for TUI apps (Claude Code, vim, etc.) " +
    "or to scroll up and see more output history. Returns what's visually displayed, " +
    "not raw byte stream.",
  parameters: {
    type: "object",
    properties: {
      lines: {
        type: "integer",
        description:
          "Lines of scrollback history to include. Negative = scrollback from current. " +
          "Default: -200 (last 200 lines). Use -500 or -1000 for more history.",
        nullable: true
      },
      timeout_ms: {
        type: "integer",
        description: "Max wait time in ms (default: 5000)",
        nullable: true
      }
    },
    required: [],
    additionalProperties: false
  },
  strict: true
};
```

#### 3.2 Update AgentDirective type

```typescript
type AgentDirective =
  | { type: "done"; message: string }
  | {
      type: "tool_call";
      tool: "shell.run" | "terminal.run" | "terminal.observe" | "terminal.interrupt" | "terminal.capture";
      // ... existing fields ...
      lines?: number;  // For terminal.capture
    };
```

#### 3.3 Add tool to getTools()

```typescript
private getTools() {
  return [
    TERMINAL_RUN_TOOL,
    TERMINAL_OBSERVE_TOOL,
    TERMINAL_INTERRUPT_TOOL,
    TERMINAL_CAPTURE_TOOL  // Add this
  ];
}
```

#### 3.4 Add tool name mapping

```typescript
private toolNameForConversation(tool: AgentDirective["tool"]) {
  switch (tool) {
    case "terminal.run": return "terminal_run";
    case "terminal.observe": return "terminal_observe";
    case "terminal.interrupt": return "terminal_interrupt";
    case "terminal.capture": return "terminal_capture";  // Add this
    case "shell.run":
    default: return "shell_run";
  }
}
```

#### 3.5 Add directive parsing

```typescript
// In extractDirective, add case:
case "terminal_capture":
  return {
    type: "tool_call",
    tool: "terminal.capture",
    lines: typeof args.lines === "number" ? args.lines : undefined,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
    callId
  };
```

#### 3.6 Add execution handler

```typescript
// In executeTerminalCall, add handler:
if (directive.tool === "terminal.capture") {
  const lines = directive.lines ?? -200;
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
    readiness: { ready: true, confidence: 1.0, trigger: "capture" },
    lastLine: capture.output.trim().split(/\r?\n/).pop() ?? "",
    truncated: false,
    omittedLines: 0,
    context: getContext()
  };
}
```

### Phase 4: Auto-switch for REPL context

**Files:** `service/src/agent/agent-service.ts`

#### 4.1 Modify terminal.run to use capture-pane for REPLs

```typescript
// In executeTerminalCall, after readiness is received (around line 980):

// Determine output source based on context
const context = getContext();
let decoded: string;
let outputBytes: number;
let truncated: boolean;

if (context.mode === "repl") {
  // REPL/TUI: use capture-pane for accurate rendered output
  this.debug("terminal.run using capture-pane for REPL context", {
    budId: bud.budId,
    program: context.program
  });

  try {
    const capture = await this.terminalManager.capturePane(bud.budId, {
      startLine: -200,
      joinLines: true
    });
    decoded = capture.output;
    outputBytes = capture.outputBytes;
    truncated = false;  // capture-pane returns complete screen
  } catch (err) {
    // Fallback to pipe-pane if capture fails
    this.logger.warn({ budId: bud.budId, err }, "capture-pane failed, falling back to pipe-pane");
    const tail = await this.terminalManager.tailOutput(
      bud.budId,
      config.terminalOutputBackfillBytes,
      { sinceOffset: offsetBeforeInput }
    );
    decoded = this.decodeTail(tail.data);
    outputBytes = tail.totalBytes;
    truncated = tail.data.length < tail.totalBytes;
  }
} else {
  // Shell: use pipe-pane (works well for line-based output)
  const tail = await this.terminalManager.tailOutput(
    bud.budId,
    config.terminalOutputBackfillBytes,
    { sinceOffset: offsetBeforeInput }
  );
  decoded = this.decodeTail(tail.data);
  outputBytes = tail.totalBytes;
  truncated = tail.data.length < tail.totalBytes;
}
```

### Phase 5: System prompt updates

#### 5.1 Add guidance for terminal.capture

```typescript
// Add to AGENT_SYSTEM_PROMPT:
`
- When output is truncated or you need to see more history, use terminal.capture:
  - {"type":"tool_call","tool":"terminal.capture","lines":-500}
  - This captures the rendered screen, useful for TUI apps like Claude Code
  - The "lines" parameter controls scrollback: -200 (default), -500, -1000 for more
- For TUI programs (Claude Code, vim, etc.):
  - Output from terminal.run automatically uses screen capture
  - If you need to see more context, use terminal.capture with larger "lines" value
`
```

---

## Testing Plan

### Unit Tests

1. **Bud: capture-pane execution**
   - Test `handle_capture` with various options
   - Test error handling (session not found, tmux error)
   - Test response frame structure

2. **Service: capture correlation**
   - Test `capturePane` request/response matching
   - Test timeout handling
   - Test concurrent captures (different request_ids)

3. **Agent: tool execution**
   - Test `terminal.capture` directive parsing
   - Test REPL auto-switch logic
   - Test fallback when capture fails

### Integration Tests

1. **End-to-end capture flow**
   - Send capture request, verify response
   - Test with actual tmux session

2. **REPL context detection**
   - Start Python REPL, verify capture-pane used
   - Run shell command, verify pipe-pane used

### Manual Testing

1. **Claude Code scenario**
   - Start Claude Code in terminal
   - Send request via agent
   - Verify agent sees readable output

2. **Scroll-up scenario**
   - Generate lots of output
   - Use `terminal.capture` with -500 lines
   - Verify historical content captured

---

## Migration & Rollout

### Backward Compatibility

- Existing `terminal.run`, `terminal.observe`, `terminal.interrupt` unchanged
- Auto-switch only affects REPL contexts (opt-in via context detection)
- Falls back to pipe-pane if capture-pane fails

### Rollout Steps

1. Deploy Bud changes first (capture frame handler)
2. Deploy Service changes (schema, manager, gateway)
3. Deploy Agent changes (tool, auto-switch)
4. Monitor logs for capture errors/fallbacks


---

## Design Decisions

1. **Scrollback buffer size**: Increase tmux `history-limit` to support agent requesting up to 1000 lines. Set via `set-option -g history-limit 5000` when creating session (gives headroom).

2. **Escape sequences**: No ANSI colors (`-e` flag not used). Cleaner text is better for LLM processing.

3. **Performance**: 10-50ms for capture-pane exec is acceptable.

4. **Concurrent captures**: No limit. Request/response correlation via `request_id` handles concurrency naturally.

5. **Caching**: No caching. Screen changes frequently; optimize only if needed later.

---

## Summary

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 1 | Bud capture handler | ~1 hour |
| Phase 2 | Service capture support | ~1 hour |
| Phase 3 | Agent tool integration | ~1 hour |
| Phase 4 | REPL auto-switch | ~30 min |
| Phase 5 | System prompt | ~15 min |
| Testing | Unit + integration | ~2 hours |

**Total: ~6 hours**

This plan provides:
- Accurate TUI output for REPLs like Claude Code
- Agent "scroll up" capability via `terminal.capture` tool
- Backward compatibility with existing shell workflow
- Graceful fallback if capture-pane fails
