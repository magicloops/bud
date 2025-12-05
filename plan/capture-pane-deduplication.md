# Implementation Plan: Capture-Pane Deduplication

_Created: 2025-12-04_
_Updated: 2025-12-04_

## Overview

Two parts:
1. **Bud (Rust)**: Implement content-aware deduplication for capture-pane output
2. **Service (TypeScript)**: Add pretty logging of terminal output for debugging

**Design doc**: `design/capture-pane-deduplication.md`

## Goals

1. Reduce token waste by not re-sending content the agent has already seen
2. Deduplication lives in Bud (persists across service restarts/scaling)
3. Pretty debug logging of terminal output for debugging
4. Graceful fallback - when uncertain, return full capture

---

## Part 1: Bud-side Deduplication (Rust)

**File**: `bud/src/main.rs`

### Core Algorithm

```
1. Hash current capture
2. If hash matches previous → return empty ("no_change")
3. If no previous state → return full ("first_capture")
4. Scan current from bottom to top:
   - Skip decoration lines (< 3 alphanumeric chars)
   - For content lines, look for matches in previous
   - If 3+ content lines match consecutively → found overlap
   - Return everything AFTER the overlap point
5. If no overlap found → return full ("no_overlap")
```

### 1.1 Add CaptureState and helpers

```rust
use std::collections::HashMap;

/// State for capture-pane deduplication
struct CaptureState {
    content_hash: u64,
    lines: Vec<String>,
    captured_at: u64,
}

/// Check if a line contains actual text content (vs decoration/borders)
fn is_content_line(line: &str) -> bool {
    line.chars().filter(|c| c.is_alphanumeric()).count() >= 3
}

/// Build index of content lines: line_content -> positions
fn build_content_index(lines: &[String]) -> HashMap<&str, Vec<usize>> {
    let mut index: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        if is_content_line(line) {
            index.entry(line.as_str()).or_default().push(i);
        }
    }
    index
}

/// Count matching content lines going upward from given positions
fn count_content_matches_upward(
    prev: &[String], prev_end: usize,
    curr: &[&str], curr_end: usize
) -> usize {
    let mut content_matches = 0;
    let mut p = prev_end as isize;
    let mut c = curr_end as isize;

    while p >= 0 && c >= 0 {
        if prev[p as usize] != curr[c as usize] {
            break;
        }
        if is_content_line(curr[c as usize]) {
            content_matches += 1;
        }
        p -= 1;
        c -= 1;
    }

    content_matches
}

/// Simple hash for change detection
fn simple_hash(data: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}
```

### 1.2 Add CaptureState to TerminalState

The deduplication state must be stored in `TerminalState` (not `TerminalHandle`) because:
- `TerminalHandle` is wrapped in `Arc` and shared immutably
- `TerminalState` is already behind a `Mutex` for safe mutation
- State naturally belongs with the terminal session lifecycle

```rust
struct TerminalState {
    sender: Option<OutboundSender>,
    handle: Option<Arc<TerminalHandle>>,
    capture_state: Option<CaptureState>,  // NEW: deduplication state
}
```

### 1.3 Deduplication logic

```rust
struct DedupResult {
    output: String,
    deduplicated: bool,
    lines_removed: usize,
    reason: &'static str,
}

fn deduplicate_capture(
    state: &Option<CaptureState>,
    output: &str,
    current_hash: u64,
) -> DedupResult {
    const MIN_CONTENT_MATCHES: usize = 3;
    let current_lines: Vec<&str> = output.lines().collect();

    // Check for no change
    if let Some(prev) = state {
        if prev.content_hash == current_hash {
            return DedupResult {
                output: String::new(),
                deduplicated: true,
                lines_removed: current_lines.len(),
                reason: "no_change",
            };
        }
    }

    // First capture
    let Some(prev) = state else {
        return DedupResult {
            output: output.to_string(),
            deduplicated: false,
            lines_removed: 0,
            reason: "first_capture",
        };
    };

    // Build index of previous content lines
    let prev_index = build_content_index(&prev.lines);

    // Scan current from bottom to top
    for i in (0..current_lines.len()).rev() {
        let line = current_lines[i];

        // Skip decoration lines
        if !is_content_line(line) {
            continue;
        }

        // Check if this content line exists in previous
        if let Some(prev_positions) = prev_index.get(line) {
            for &prev_pos in prev_positions {
                let content_matches = count_content_matches_upward(
                    &prev.lines, prev_pos,
                    &current_lines, i
                );

                if content_matches >= MIN_CONTENT_MATCHES {
                    // Found overlap! Return content after this point
                    let new_content = current_lines[i + 1..].join("\n");
                    return DedupResult {
                        output: new_content,
                        deduplicated: true,
                        lines_removed: i + 1,
                        reason: "sequence_match",
                    };
                }
            }
        }
    }

    // No overlap found
    DedupResult {
        output: output.to_string(),
        deduplicated: false,
        lines_removed: 0,
        reason: "no_overlap",
    }
}
```

### 1.4 Update handle_capture

The `handle_capture` method needs to:
1. Execute capture-pane (existing)
2. Apply deduplication
3. Update state in `TerminalState`
4. Log dedup metrics (for debugging)
5. Return only the deduplicated output (no dedup metadata to service)

```rust
async fn handle_capture(&self, frame: TerminalCaptureFrame) -> Result<()> {
    if !self.config.enabled {
        return Ok(());
    }

    // Get handle and sender
    let (handle, sender) = {
        let inner = self.inner.lock().await;
        (inner.handle.clone(), inner.sender.clone())
    };
    let Some(sender) = sender else {
        warn!(request_id = %frame.request_id, "terminal_capture dropped; no sender");
        return Ok(());
    };
    let Some(handle) = handle else {
        // Send error response (existing logic)
        let response = json!({ /* ... existing error response ... */ });
        send_ws_frame(&sender, response)?;
        return Ok(());
    };

    // Execute capture-pane (existing logic)
    let mut args = vec!["capture-pane", "-p", "-t", &handle.session_name];
    // ... existing args setup ...

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .await
        .with_context(|| "failed to execute tmux capture-pane")?;

    if !output.status.success() {
        // Send error response (existing logic)
        return Ok(());
    }

    let output_str = String::from_utf8_lossy(&output.stdout);
    let current_hash = simple_hash(&output.stdout);

    // Apply deduplication
    let dedup = {
        let inner = self.inner.lock().await;
        deduplicate_capture(&inner.capture_state, &output_str, current_hash)
    };

    // Update state
    {
        let mut inner = self.inner.lock().await;
        inner.capture_state = Some(CaptureState {
            content_hash: current_hash,
            lines: output_str.lines().map(|s| s.to_string()).collect(),
            captured_at: now_millis(),
        });
    }

    // Log dedup metrics (Bud-side only, for debugging)
    info!(
        request_id = %frame.request_id,
        deduplicated = dedup.deduplicated,
        lines_removed = dedup.lines_removed,
        reason = dedup.reason,
        output_lines = dedup.output.lines().count(),
        "capture-pane deduplication"
    );

    // Send response - NO dedup metadata (would confuse agent)
    let response = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_capture_response",
        "id": new_message_id(),
        "ts": now_millis(),
        "request_id": frame.request_id,
        "output": BASE64_STANDARD.encode(dedup.output.as_bytes()),
        "output_bytes": dedup.output.len(),
        "lines_captured": dedup.output.lines().count(),
        "error": Value::Null
    });

    send_ws_frame(&sender, response)?;
    Ok(())
}
```

### 1.5 State Reset Conditions

The `capture_state` should be reset to `None` when:

1. **Terminal close** - in `handle_close()`:
```rust
async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
    // ... existing logic ...
    let mut inner = self.inner.lock().await;
    if let Some(handle) = inner.handle.take() {
        handle.watcher.abort();
        // ... tmux kill-session ...
    }
    inner.capture_state = None;  // Reset dedup state
    // ...
}
```

2. **Terminal resize** - in `handle_resize()`:
```rust
async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
    // ... existing resize logic ...

    // Reset dedup state - screen layout changed
    {
        let mut inner = self.inner.lock().await;
        inner.capture_state = None;
    }
    Ok(())
}
```

3. **Bud reconnect** - state is naturally reset when `TerminalManager` is recreated

### 1.6 Error Handling

Deduplication failures should silently fall back to full output:

```rust
fn deduplicate_capture(
    state: &Option<CaptureState>,
    output: &str,
    current_hash: u64,
) -> DedupResult {
    // Wrap in catch_unwind or use Result internally
    // On any error, return full output with reason "fallback"

    // Example: if content index is too large, skip dedup
    if output.lines().count() > 10_000 {
        return DedupResult {
            output: output.to_string(),
            deduplicated: false,
            lines_removed: 0,
            reason: "too_large",
        };
    }

    // ... rest of dedup logic ...
}
```

### 1.7 Service Types (No Changes Needed)

The Service types (`CaptureResponsePayload`, `CaptureResult`) do NOT need dedup fields.
Bud sends only the deduplicated output - the Service and agent are unaware deduplication happened.

This keeps the agent interface simple and avoids confusion.

---

## Part 2: Pretty Terminal Output Logging (TypeScript)

**File**: `service/src/agent/agent-service.ts`

The `openaiDebugEnabled` flag already exists (line 212) and is passed via constructor.

### 2.1 Add terminal output logging method

```typescript
private logTerminalOutput(tool: string, output: string): void {
  if (!this.openaiDebugEnabled) return;

  const lines = output.split("\n");
  const maxLines = 30;

  console.log(`\n┌─ ${tool} output (${lines.length} lines) ─────────────────────`);

  for (const line of lines.slice(0, maxLines)) {
    console.log(`│ ${line}`);
  }

  if (lines.length > maxLines) {
    console.log(`│ ... (${lines.length - maxLines} more lines)`);
  }

  console.log(`└${"─".repeat(50)}\n`);
}
```

### 2.2 Log in terminal.capture handler (line ~983)

```typescript
if (directive.tool === "terminal.capture") {
  // ... existing capture logic ...

  try {
    const capture = await this.terminalManager.capturePane(
      bud.budId,
      { startLine: lines, joinLines: true },
      directive.timeoutMs ?? 5000
    );

    // Pretty print terminal output for debugging
    this.logTerminalOutput("terminal.capture", capture.output);

    if (capture.error) {
      throw new Error(capture.error);
    }
    return {
      output: capture.output,
      // ...
    };
  } catch (err) {
    // ...
  }
}
```

### 2.3 Log in terminal.run handler - REPL path (line ~1056)

```typescript
if (context.mode === "repl") {
  this.debug("terminal.run using capture-pane for REPL context", {
    budId: bud.budId,
    program: context.program
  });

  try {
    const capture = await this.terminalManager.capturePane(bud.budId, {
      startLine: -50,
      joinLines: true
    });

    // Pretty print terminal output for debugging
    this.logTerminalOutput("terminal.run (REPL)", capture.output);

    decoded = capture.output;
    outputBytes = capture.outputBytes;
    truncated = false;
  } catch (err) {
    // ... fallback logic ...
  }
}
```

### 2.4 Example output

```
┌─ terminal.capture output (24 lines) ─────────────────────
│ $ ls -la
│ total 48
│ drwxr-xr-x  12 user  staff   384 Dec  4 10:30 .
│ drwxr-xr-x   5 user  staff   160 Dec  4 09:15 ..
│ -rw-r--r--   1 user  staff  1234 Dec  4 10:28 README.md
│ drwxr-xr-x   8 user  staff   256 Dec  4 10:30 src
│ $
└──────────────────────────────────────────────────────────
```

---

## Implementation Checklist

### Bud (Rust) - `bud/src/main.rs`

- [ ] Add `CaptureState` struct
- [ ] Add helper functions: `is_content_line`, `build_content_index`, `count_content_matches_upward`, `simple_hash`
- [ ] Add `DedupResult` struct and `deduplicate_capture` function
- [ ] Add `capture_state: Option<CaptureState>` to `TerminalState` struct
- [ ] Update `handle_capture` to apply deduplication
- [ ] Reset `capture_state` in `handle_close`
- [ ] Reset `capture_state` in `handle_resize`
- [ ] Add info logging for dedup metrics

### Service (TypeScript) - `service/src/agent/agent-service.ts`

- [ ] Add `logTerminalOutput` method
- [ ] Call `logTerminalOutput` in `terminal.capture` handler
- [ ] Call `logTerminalOutput` in `terminal.run` REPL path

---

## Testing Plan

1. **Deduplication**: Test with Claude Code - verify repeated captures only return new messages
2. **Logging**: Enable `OPENAI_DEBUG=true`, verify terminal output appears in logs
3. **Edge cases**:
   - Screen resize resets state
   - Terminal close resets state
   - No change returns empty
   - Full redraw returns full output
   - Very large output falls back to full

---

## Rollback

- **Bud**: Skip deduplication by always returning `reason: "disabled"` with full output
- **Service**: Logging is gated by `openaiDebugEnabled`, no impact on agent behavior
