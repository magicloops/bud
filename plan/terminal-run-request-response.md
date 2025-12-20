# Plan: terminal_run Request-Response Implementation

**Status:** Draft
**Created:** 2025-12-20
**Related:**
- [`design/terminal-run-refactor-v2.md`](../design/terminal-run-refactor-v2.md) - Design document
- [`docs/proto.md`](../docs/proto.md) - Protocol specification

---

## Objective

Replace the current convoluted `terminal.run` flow (offset tracking → PostgreSQL storage → database query) with a clean request-response pattern where Bud returns command output directly.

### Success Criteria

1. Agent receives correct command output (no stale/previous output)
2. TUI applications continue to work (activity-based detection)
3. Latency is equal or better than current implementation
4. Code is simpler and easier to debug

---

## Protocol Changes

### New Message: `terminal_run` (Service → Bud)

```json
{
  "proto": "0.2",
  "type": "terminal_run",
  "id": "msg_01ABC...",
  "ts": 1734700000000,
  "ext": {},
  "session_id": "sess_01XYZ...",
  "request_id": "run_01DEF...",
  "input": "base64-encoded-input",
  "mode": "shell",
  "timeout_ms": 30000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | Yes | Target terminal session |
| `request_id` | string | Yes | Unique ID for response correlation |
| `input` | string | Yes | Base64-encoded input to send |
| `mode` | `"shell"` \| `"repl"` | No | Output retrieval mode (default: `"shell"`) |
| `timeout_ms` | number | No | Max wait for readiness (default: 30000) |

### New Message: `terminal_run_result` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_run_result",
  "id": "msg_01GHI...",
  "ts": 1734700001000,
  "ext": {},
  "session_id": "sess_01XYZ...",
  "request_id": "run_01DEF...",
  "output": "base64-encoded-output",
  "output_bytes": 1234,
  "truncated": false,
  "readiness": {
    "ready": true,
    "confidence": 0.95,
    "trigger": "prompt_detected",
    "prompt_type": "shell",
    "hints": {
      "looks_like_prompt": true,
      "looks_like_confirmation": false,
      "looks_like_password": false,
      "looks_like_pager": false,
      "looks_like_error": false,
      "may_still_be_processing": false
    },
    "quiet_for_ms": 1500
  },
  "error": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | Yes | Terminal session ID |
| `request_id` | string | Yes | Matches the request |
| `output` | string | Yes | Base64-encoded command output |
| `output_bytes` | number | Yes | Size of output in bytes |
| `truncated` | boolean | Yes | True if output exceeded max size |
| `readiness` | object | Yes | Readiness assessment (same as `terminal_ready`) |
| `error` | string \| null | Yes | Error message if failed, null otherwise |

---

## Bud Daemon Changes

### File: `bud/src/main.rs`

#### 1. Add Frame Type for `terminal_run`

```rust
// Add to frame structs section (around line 200)
#[derive(Debug, Deserialize)]
struct TerminalRunFrame {
    #[serde(flatten)]
    envelope: FrameEnvelope,
    session_id: String,
    request_id: String,
    #[serde(rename = "input")]
    data: String,  // base64
    mode: Option<String>,  // "shell" | "repl"
    timeout_ms: Option<u64>,
}
```

#### 2. Add Message Routing

```rust
// Add to handle_frame() match statement (around line 580)
"terminal_run" => {
    let frame: TerminalRunFrame = serde_json::from_value(raw.clone())?;
    self.handle_run(frame).await?;
}
```

#### 3. Implement `handle_run()`

```rust
// Add new method to TerminalManager impl (after handle_input, around line 760)
async fn handle_run(&self, frame: TerminalRunFrame) -> Result<()> {
    if !self.config.enabled {
        return self.send_run_error(&frame, "terminal_disabled").await;
    }

    let session_id = &frame.session_id;
    let request_id = &frame.request_id;
    let mode = frame.mode.as_deref().unwrap_or("shell");
    let timeout_ms = frame.timeout_ms.unwrap_or(30_000);

    // Decode input
    let data = BASE64_STANDARD
        .decode(frame.data.as_bytes())
        .map_err(|err| anyhow!("invalid terminal run input: {}", err))?;

    // Get session handle
    let handle = self.ensure_handle_for_session(session_id, None).await?;
    let Some(handle) = handle else {
        return self.send_run_error(&frame, "session_not_found").await;
    };

    // Record starting offset (for shell mode output retrieval)
    let start_offset = handle.offset.load(Ordering::SeqCst);

    info!(
        request_id = request_id,
        session_id = session_id,
        mode = mode,
        input_bytes = data.len(),
        start_offset = start_offset,
        "terminal_run received"
    );

    // Send input to tmux (same logic as handle_input)
    let input = String::from_utf8_lossy(&data).to_string();
    let trimmed_end = input.trim_end_matches(|c| c == '\n' || c == '\r');
    let newline_count = input.len() - trimmed_end.len();

    if !trimmed_end.is_empty() {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", &handle.session_name, "-l", trimmed_end])
            .status()
            .await
            .with_context(|| "failed to dispatch tmux send-keys")?;
        if !status.success() {
            return self.send_run_error(&frame, "send_keys_failed").await;
        }
    }

    for _ in 0..newline_count {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", &handle.session_name, "Enter"])
            .status()
            .await?;
        if !status.success() {
            warn!(request_id = request_id, "tmux send-keys Enter failed");
        }
    }

    // Get sender for response
    let sender = self.inner.lock().await.sender.clone()
        .ok_or_else(|| anyhow!("no websocket sender"))?;

    // Wait for readiness and collect output
    let (assessment, output, output_bytes, truncated) = if mode == "repl" {
        // Activity-based: compare capture-pane hashes
        self.wait_activity_and_capture(&handle, &sender, timeout_ms).await?
    } else {
        // Quiescence-based: watch log file
        self.wait_quiescence_and_read(&handle, start_offset, timeout_ms).await?
    };

    // Send response
    let payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_run_result",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": session_id,
        "request_id": request_id,
        "output": BASE64_STANDARD.encode(&output),
        "output_bytes": output_bytes,
        "truncated": truncated,
        "readiness": assessment,
        "error": null::<String>,
    });
    send_ws_frame(&sender, payload)?;

    info!(
        request_id = request_id,
        session_id = session_id,
        output_bytes = output_bytes,
        truncated = truncated,
        "terminal_run_result sent"
    );

    Ok(())
}

async fn send_run_error(&self, frame: &TerminalRunFrame, error: &str) -> Result<()> {
    let sender = self.inner.lock().await.sender.clone()
        .ok_or_else(|| anyhow!("no websocket sender"))?;

    let payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_run_result",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": frame.session_id,
        "request_id": frame.request_id,
        "output": "",
        "output_bytes": 0,
        "truncated": false,
        "readiness": {
            "ready": false,
            "confidence": 0.0,
            "trigger": "error",
            "hints": {}
        },
        "error": error,
    });
    send_ws_frame(&sender, payload)?;
    Ok(())
}
```

#### 4. Add Helper Methods for Readiness + Output

```rust
// Add to TerminalManager impl

/// Wait for quiescence (shell mode) and read output from log file
async fn wait_quiescence_and_read(
    &self,
    handle: &Arc<TerminalHandle>,
    start_offset: u64,
    timeout_ms: u64,
) -> Result<(serde_json::Value, Vec<u8>, usize, bool)> {
    const MAX_OUTPUT: usize = 64 * 1024;  // 64KB max output
    let quiescence_ms = 1500;
    let start = Instant::now();
    let mut last_change = Instant::now();
    let mut last_size = handle.offset.load(Ordering::SeqCst);

    // Wait for quiescence or timeout
    loop {
        let size = match fs::metadata(&handle.log_path).await {
            Ok(meta) => meta.len(),
            Err(_) => {
                time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        if size != last_size {
            last_change = Instant::now();
            last_size = size;
        }
        if last_change.elapsed() >= Duration::from_millis(quiescence_ms)
            || start.elapsed() >= Duration::from_millis(timeout_ms)
        {
            break;
        }
        time::sleep(Duration::from_millis(50)).await;
    }

    // Read output from start_offset to current end
    let end_size = fs::metadata(&handle.log_path).await
        .map(|m| m.len())
        .unwrap_or(last_size);

    let (output, truncated) = self.read_log_range(
        &handle.log_path,
        start_offset,
        end_size,
        MAX_OUTPUT,
    ).await;

    let output_bytes = output.len();
    let text = String::from_utf8_lossy(&output).to_string();
    let last_line = text.lines().last().unwrap_or("").to_string();
    let quiet_for_ms = last_change.elapsed().as_millis() as u64;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    let assessment = ReadinessDetector::assess(&text, &last_line, quiet_for_ms, elapsed_ms);

    Ok((assessment, output, output_bytes, truncated))
}

/// Read log file from start to end, limiting to max_bytes
async fn read_log_range(
    &self,
    log_path: &Path,
    start: u64,
    end: u64,
    max_bytes: usize,
) -> (Vec<u8>, bool) {
    if end <= start {
        return (Vec::new(), false);
    }

    let total_bytes = (end - start) as usize;
    let truncated = total_bytes > max_bytes;
    let to_read = total_bytes.min(max_bytes);

    // Read from start_offset (not from end like read_tail does)
    let mut buf = vec![0u8; to_read];
    if let Ok(mut file) = fs::File::open(log_path).await {
        // If truncating, read last N bytes; otherwise read from start
        let seek_pos = if truncated {
            end - to_read as u64
        } else {
            start
        };
        let _ = file.seek(SeekFrom::Start(seek_pos)).await;
        let _ = file.read_exact(&mut buf).await;
    }

    (buf, truncated)
}

/// Wait for activity stability (REPL mode) and capture screen
async fn wait_activity_and_capture(
    &self,
    handle: &Arc<TerminalHandle>,
    _sender: &OutboundSender,
    timeout_ms: u64,
) -> Result<(serde_json::Value, Vec<u8>, usize, bool)> {
    let interval_ms = 5000;
    let stable_count_target = 2;
    let initial_delay_ms = 2000;

    // Initial delay
    time::sleep(Duration::from_millis(initial_delay_ms)).await;

    let start = Instant::now();
    let mut last_hash: Option<u64> = None;
    let mut stable_count = 0;
    let mut check_count = 0;

    loop {
        // Check timeout
        if start.elapsed() >= Duration::from_millis(timeout_ms) {
            break;
        }

        // Capture pane and hash
        let capture = self.capture_pane_content(&handle.session_name).await?;
        let hash = self.hash_content(&capture);
        check_count += 1;

        if Some(hash) == last_hash {
            stable_count += 1;
            if stable_count >= stable_count_target {
                // Screen is stable
                break;
            }
        } else {
            stable_count = 0;
        }
        last_hash = Some(hash);

        time::sleep(Duration::from_millis(interval_ms)).await;
    }

    // Final capture for output
    let capture = self.capture_pane_content(&handle.session_name).await?;
    let output = capture.into_bytes();
    let output_bytes = output.len();

    let confidence = if stable_count >= stable_count_target { 0.85 } else { 0.5 };
    let trigger = if stable_count >= stable_count_target { "activity_stable" } else { "timeout" };

    let assessment = json!({
        "ready": confidence >= 0.5,
        "confidence": confidence,
        "trigger": trigger,
        "hints": {
            "looks_like_prompt": false,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": confidence < 0.7
        },
        "activity_checks": check_count,
        "stable_checks": stable_count
    });

    Ok((assessment, output, output_bytes, false))  // capture-pane doesn't truncate
}

async fn capture_pane_content(&self, session_name: &str) -> Result<String> {
    let output = Command::new("tmux")
        .args(["capture-pane", "-p", "-t", session_name])
        .output()
        .await
        .with_context(|| "failed to execute tmux capture-pane")?;

    if !output.status.success() {
        bail!("tmux capture-pane failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn hash_content(&self, content: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}
```

---

## Service Changes

### File: `service/src/terminal/types.ts`

Add new types:

```typescript
// Add after TerminalReadyMessage (around line 127)

export interface TerminalRunResultMessage extends TerminalEnvelope {
  type: "terminal_run_result";
  session_id: string;
  request_id: string;
  output: string;       // base64
  output_bytes: number;
  truncated: boolean;
  readiness: ReadinessAssessment;
  error: string | null;
}
```

### File: `service/src/ws/gateway.ts`

#### 1. Add Schema

```typescript
// Add after TerminalCaptureResponseSchema (around line 130)

const TerminalRunResultSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_run_result"),
  session_id: z.string(),
  request_id: z.string(),
  output: z.string(),
  output_bytes: z.number(),
  truncated: z.boolean(),
  readiness: z.object({
    ready: z.boolean(),
    confidence: z.number(),
    trigger: z.string(),
    prompt_type: z.string().optional(),
    hints: z.record(z.boolean()).optional(),
    quiet_for_ms: z.number().optional(),
    activity_checks: z.number().optional(),
    stable_checks: z.number().optional(),
  }),
  error: z.string().nullable(),
});
```

#### 2. Add Message Routing

```typescript
// Add to handleBudFrame() switch statement (around line 310)

case "terminal_run_result":
  await this.handleTerminalRunResult(parsed);
  break;
```

#### 3. Add Handler

```typescript
// Add after handleTerminalCaptureResponse (around line 450)

private async handleTerminalRunResult(raw: unknown): Promise<void> {
  const result = TerminalRunResultSchema.safeParse(raw);
  if (!result.success) {
    logDebug({ error: result.error.message }, "Invalid terminal_run_result frame");
    return;
  }

  const sessionId = result.data.session_id;
  this.terminalSessionManager.handleRunResult(sessionId, {
    requestId: result.data.request_id,
    output: result.data.output,
    outputBytes: result.data.output_bytes,
    truncated: result.data.truncated,
    readiness: result.data.readiness,
    error: result.data.error,
  });
}
```

### File: `service/src/runtime/terminal-session-manager.ts`

#### 1. Add Types and State

```typescript
// Add to type definitions (around line 90)

export type RunResult = {
  output: string;           // Decoded UTF-8 string
  outputBytes: number;
  truncated: boolean;
  readiness: ReadinessAssessment;
  error?: string;
};

type RunResultPayload = {
  requestId: string;
  output: string;           // Base64
  outputBytes: number;
  truncated: boolean;
  readiness: ReadinessAssessment;
  error: string | null;
};
```

```typescript
// Add to class properties (around line 110)

private readonly pendingRuns = new Map<
  string,
  {
    resolve: (result: RunResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
```

#### 2. Add `runCommand()` Method

```typescript
// Add after capturePane method (around line 840)

/**
 * Run a command and get output directly from Bud.
 * This is the new request-response pattern that replaces
 * sendInput + waitForReadiness + tailOutput.
 */
async runCommand(
  sessionId: string,
  input: Buffer,
  options: {
    mode?: "shell" | "repl";
    timeoutMs?: number;
  } = {}
): Promise<RunResult> {
  const session = await this.getSession(sessionId);
  if (!session) {
    throw new Error("session_not_found");
  }

  const requestId = `run_${ulid()}`;
  const timeoutMs = options.timeoutMs ?? 30000;
  const mode = options.mode ?? "shell";

  const payload = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_run",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    session_id: sessionId,
    request_id: requestId,
    input: input.toString("base64"),
    mode,
    timeout_ms: timeoutMs,
  };

  const sent = sendFrameToBud(session.budId, payload);
  if (!sent) {
    throw new Error("bud_offline");
  }

  this.logger.info(
    { sessionId, requestId, mode, inputBytes: input.length, component: "terminal_session_manager" },
    "Sending terminal_run request"
  );

  return new Promise((resolve, reject) => {
    // Add buffer to timeout (network + processing overhead)
    const timeout = setTimeout(() => {
      this.pendingRuns.delete(requestId);
      reject(new Error("run_timeout"));
    }, timeoutMs + 10000);

    this.pendingRuns.set(requestId, { resolve, reject, timeout });
  });
}

/**
 * Handle terminal_run_result from Bud.
 */
handleRunResult(sessionId: string, payload: RunResultPayload): void {
  const pending = this.pendingRuns.get(payload.requestId);
  if (!pending) {
    this.logger.warn(
      { sessionId, requestId: payload.requestId, component: "terminal_session_manager" },
      "Orphaned run result"
    );
    return;
  }

  clearTimeout(pending.timeout);
  this.pendingRuns.delete(payload.requestId);

  if (payload.error) {
    pending.reject(new Error(payload.error));
    return;
  }

  // Decode base64 output
  const buffer = Buffer.from(payload.output, "base64");
  const output = buffer.toString("utf-8");

  this.logger.info(
    {
      sessionId,
      requestId: payload.requestId,
      outputBytes: payload.outputBytes,
      truncated: payload.truncated,
      readiness: payload.readiness,
      component: "terminal_session_manager"
    },
    "Run result received"
  );

  pending.resolve({
    output,
    outputBytes: payload.outputBytes,
    truncated: payload.truncated,
    readiness: payload.readiness,
  });
}
```

### File: `service/src/agent/agent-service.ts`

#### Update `executeTerminalCall()` for terminal.run

Replace the current terminal.run handling (lines 811-910) with:

```typescript
// terminal.run - use new request-response pattern
if (directive.tool === "terminal.run") {
  const input = directive.input ?? "";

  // Track command if launching a known REPL
  // (Keep existing pendingCommand logic for context detection)
  if (input.includes("\n")) {
    const command = this.parseCommandFromInput(input);
    if (command && isKnownReplProgram(command)) {
      this.terminalSessionManager.setPendingCommand(sessionId, {
        input,
        command,
        sentAt: Date.now(),
        source: "agent"
      });
    }
  }

  // Determine mode based on current context
  const context = getContext();
  const mode = context.mode === "repl" ? "repl" : "shell";

  this.debug("terminal.run using request-response", {
    sessionId,
    mode,
    inputLength: input.length,
    program: context.program
  });

  try {
    // Single request-response call - output comes directly from Bud
    const result = await this.terminalSessionManager.runCommand(
      sessionId,
      Buffer.from(input, "utf-8"),
      { mode, timeoutMs: directive.timeoutMs ?? 30000 }
    );

    // Strip ANSI and normalize
    const cleanOutput = this.stripAnsi(result.output);
    const normalizedOutput = this.normalizeCRLF(cleanOutput);

    this.logTerminalOutput("terminal.run", normalizedOutput);

    return {
      output: normalizedOutput,
      outputBytes: result.outputBytes,
      readiness: this.normalizeReadiness(result.readiness, {
        ready: true,
        confidence: 0.5,
        trigger: "quiescence",
        hints: DEFAULT_READINESS_HINTS
      }),
      truncated: result.truncated,
      omittedLines: 0,
      context: getContext()  // Refresh context after command
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(
      { sessionId, error: message, component: "agent_terminal" },
      "terminal.run failed"
    );
    throw err;
  }
}
```

---

## Protocol Documentation Update

### File: `docs/proto.md`

Add to Terminal Protocol section:

```markdown
### Terminal Run (Request-Response)

* `terminal_run` — run command and get output (service → bud)
  ```json
  { "proto": "0.2", "type": "terminal_run", "id": "...", "ts": 1731,
    "session_id": "sess_01...",
    "request_id": "run_01...",
    "input": "base64-input",
    "mode": "shell",
    "timeout_ms": 30000,
    "ext": {} }
  ```

* `terminal_run_result` — command output and readiness (bud → service)
  ```json
  { "proto": "0.2", "type": "terminal_run_result", "id": "...", "ts": 1731,
    "session_id": "sess_01...",
    "request_id": "run_01...",
    "output": "base64-output",
    "output_bytes": 1234,
    "truncated": false,
    "readiness": { "ready": true, "confidence": 0.95, ... },
    "error": null,
    "ext": {} }
  ```

The `mode` field determines output retrieval:
- `"shell"`: Read from pipe-pane log file (quiescence-based readiness)
- `"repl"`: Capture screen via tmux capture-pane (activity-based readiness)
```

---

## Spec File Updates

### Files to Update

| File | Changes |
|------|---------|
| `bud/src/src.spec.md` | Add `handle_run()`, `wait_quiescence_and_read()`, `wait_activity_and_capture()` |
| `service/src/ws/ws.spec.md` | Add `terminal_run_result` routing |
| `service/src/runtime/runtime.spec.md` | Add `runCommand()`, `handleRunResult()` |
| `service/src/agent/agent.spec.md` | Update `executeTerminalCall()` description |
| `docs/proto.md` | Add `terminal_run` and `terminal_run_result` |

---

## Testing Plan

### Unit Tests

1. **Bud: `handle_run()` basic flow**
   - Input is sent to tmux correctly
   - Output is read from log file (shell mode)
   - Output is captured via capture-pane (REPL mode)
   - Response includes correct fields

2. **Service: `runCommand()` request-response**
   - Request is sent with correct payload
   - Response resolves the promise
   - Timeout is handled correctly
   - Error responses are handled

3. **Agent: `executeTerminalCall()` integration**
   - Shell commands get output from Bud
   - REPL commands use activity-based mode
   - Context detection works
   - ANSI stripping works

### Integration Tests

1. **Shell command: `ls -la`**
   - Output contains directory listing
   - Readiness is high confidence
   - No stale output from previous commands

2. **Long output: `cat large_file.txt`**
   - Output is truncated correctly
   - `truncated: true` is set
   - Readiness still works

3. **REPL command: `python3`**
   - REPL prompt is captured
   - Activity-based detection works
   - Context switches to REPL mode

4. **TUI app: `vim file.txt`**
   - Screen is captured correctly
   - User can interact
   - Exit returns to shell

5. **Timeout scenario**
   - Long-running command exceeds timeout
   - Partial output is returned
   - Error handling works

---

## Migration Strategy

### Phase 1: Add New Path (Non-Breaking)

1. Implement `terminal_run` handler in Bud
2. Implement `runCommand()` in Service
3. Add feature flag to switch between paths
4. Deploy and test with flag disabled

### Phase 2: Validate

1. Enable feature flag for specific sessions
2. Compare outputs between old and new paths
3. Monitor latency and error rates
4. Fix any issues discovered

### Phase 3: Roll Out

1. Enable feature flag by default
2. Monitor for regressions
3. Remove feature flag after 1 week

### Phase 4: Clean Up

1. Remove old `tailOutput()` usage in agent
2. Remove `lastOffsets` Map (or keep for UI backfill)
3. Make output storage optional
4. Update documentation

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Bud crashes mid-request | Low | Medium | Service-side timeout + cleanup |
| Output exceeds max size | Medium | Low | Truncate + indicate `truncated: true` |
| REPL detection fails | Low | Medium | Fallback to shell mode |
| Backward compatibility | Low | High | Keep `terminal_input` for UI |
| Performance regression | Low | Medium | Benchmark before/after |

---

## Implementation Order

1. **Bud changes** (Rust)
   - [ ] Add `TerminalRunFrame` struct
   - [ ] Add message routing
   - [ ] Implement `handle_run()`
   - [ ] Implement `wait_quiescence_and_read()`
   - [ ] Implement `wait_activity_and_capture()`
   - [ ] Add helper methods
   - [ ] Test locally

2. **Service changes** (TypeScript)
   - [ ] Add types to `terminal/types.ts`
   - [ ] Add schema to `ws/gateway.ts`
   - [ ] Add routing to gateway
   - [ ] Implement `runCommand()` in terminal-session-manager
   - [ ] Implement `handleRunResult()`
   - [ ] Update `executeTerminalCall()` in agent-service
   - [ ] Test locally

3. **Documentation**
   - [ ] Update `docs/proto.md`
   - [ ] Update spec files
   - [ ] Update design docs

4. **Testing & Validation**
   - [ ] Integration tests
   - [ ] Manual testing with real terminal
   - [ ] Performance comparison

---

## Questions to Resolve Before Implementation

1. **Max output size?**
   - Current: 16KB in Bud's read_tail
   - Proposed: 64KB
   - Need to confirm this is reasonable

2. **Timeout buffer?**
   - Service timeout should be longer than Bud's to avoid race
   - Proposed: Bud timeout + 10s for service

3. **Keep `terminal_input`?**
   - Yes, for UI keyboard input (fire-and-forget)
   - `terminal_run` is for agent (request-response)

4. **Output storage optional?**
   - Can be added as phase 4 cleanup
   - Default to disabled, enable for audit

---

*Created: 2025-12-20*
