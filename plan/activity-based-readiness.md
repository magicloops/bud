# Implementation Plan: Activity-Based Readiness Detection

_Created: 2025-12-05_
_Updated: 2025-12-05 (code review findings)_

## Overview

Replace quiescence-based readiness detection with activity-based detection for REPL/TUI contexts. Instead of "no new bytes for 1.5s", we check if the visual screen content (via capture-pane) is stable across multiple intervals.

**Design doc**: `debug/claude-in-terminal-context-loss.md`

## Goals

1. Detect when Claude Code (and other TUI programs) are truly idle
2. Avoid false "ready" signals during natural pauses in AI processing
3. Keep quiescence detection for shell commands (fast, works well)
4. Minimal changes to Service - most logic lives in Bud

---

## Key Concepts

**Two detection modes:**

| Mode | Used For | How It Works | Readiness Signal |
|------|----------|--------------|------------------|
| Quiescence | Shell commands | Watch pipe-pane log for new bytes | No new bytes for 1.5s |
| Activity | REPL/TUI apps | Compare capture-pane hashes at intervals | Screen unchanged for 2-3 checks (10-15s) |

**Why "activity-based"?** We're detecting *activity* (screen changes), then declaring ready when activity *stops*. The quiescence approach fails for TUI apps because they have natural output pauses during processing.

---

## Part 1: Bud Changes (Rust)

**File**: `bud/src/main.rs`

### 1.1 Extend AwaitReady struct

Add new fields for activity-based detection:

```rust
#[derive(Debug, Deserialize, Clone, Default)]
struct AwaitReady {
    enabled: bool,
    quiescence_ms: Option<u64>,
    max_wait_ms: Option<u64>,
    // NEW: Activity-based detection for TUI apps
    #[serde(default)]
    activity_based: bool,
    activity_interval_ms: Option<u64>,      // Default: 5000
    activity_stable_count: Option<u32>,     // Default: 2
    activity_initial_delay_ms: Option<u64>, // Default: 2000
}
```

### 1.2 Add ActivityDetector struct

```rust
struct ActivityDetector {
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    initial_delay_ms: u64,
    interval_ms: u64,
    stable_count_required: u32,
    max_wait_ms: u64,
}
```

### 1.3 Implement ActivityDetector

```rust
impl ActivityDetector {
    fn new(
        handle: Arc<TerminalHandle>,
        sender: OutboundSender,
        await_ready: &AwaitReady,
    ) -> Self {
        Self {
            handle,
            sender,
            initial_delay_ms: await_ready.activity_initial_delay_ms.unwrap_or(2000),
            interval_ms: await_ready.activity_interval_ms.unwrap_or(5000),
            stable_count_required: await_ready.activity_stable_count.unwrap_or(2),
            max_wait_ms: await_ready.max_wait_ms.unwrap_or(60_000),
        }
    }

    async fn run(self) -> Result<()> {
        let start = Instant::now();
        let mut last_hash: Option<u64> = None;
        let mut stable_count: u32 = 0;
        let mut check_count: u32 = 0;

        // Initial delay - let the program start processing
        time::sleep(Duration::from_millis(self.initial_delay_ms)).await;

        loop {
            // Check timeout first
            if start.elapsed() >= Duration::from_millis(self.max_wait_ms) {
                info!(
                    session = %self.handle.session_name,
                    check_count,
                    stable_count,
                    elapsed_ms = start.elapsed().as_millis(),
                    "activity detection timeout"
                );
                self.send_ready(0.5, "timeout", stable_count, check_count).await?;
                return Ok(());
            }

            // Capture pane and hash
            let output = self.capture_pane().await?;
            let current_hash = simple_hash(output.as_bytes());
            check_count += 1;

            match last_hash {
                Some(prev) if prev == current_hash => {
                    stable_count += 1;
                    info!(
                        session = %self.handle.session_name,
                        check_count,
                        stable_count,
                        required = self.stable_count_required,
                        "activity check: stable"
                    );

                    if stable_count >= self.stable_count_required {
                        // Ready!
                        self.send_ready(0.9, "activity_stable", stable_count, check_count).await?;
                        return Ok(());
                    }
                }
                Some(_) => {
                    // Content changed - activity detected
                    info!(
                        session = %self.handle.session_name,
                        check_count,
                        prev_stable_count = stable_count,
                        "activity check: content changed"
                    );
                    stable_count = 0;
                }
                None => {
                    // First capture
                    info!(
                        session = %self.handle.session_name,
                        check_count,
                        "activity check: first capture"
                    );
                }
            }

            last_hash = Some(current_hash);

            // Wait for next check
            time::sleep(Duration::from_millis(self.interval_ms)).await;
        }
    }

    async fn capture_pane(&self) -> Result<String> {
        let output = Command::new("tmux")
            .args(["capture-pane", "-p", "-t", &self.handle.session_name])
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane for activity detection")?;

        if !output.status.success() {
            bail!("tmux capture-pane failed: {}", String::from_utf8_lossy(&output.stderr));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn send_ready(
        &self,
        confidence: f64,
        trigger: &str,
        stable_count: u32,
        check_count: u32,
    ) -> Result<()> {
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "assessment": {
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
            }
        });
        send_ws_frame(&self.sender, payload)?;
        Ok(())
    }
}
```

### 1.4 Update handle_input to use ActivityDetector

In `handle_input()`, after sending keys to tmux:

```rust
if frame.await_ready.as_ref().map(|a| a.enabled).unwrap_or(false) {
    if let Some(sender) = self.inner.lock().await.sender.clone() {
        let await_ready = frame.await_ready.clone().unwrap_or_default();

        if await_ready.activity_based {
            // Use activity-based detection for TUI/REPL
            let detector = ActivityDetector::new(
                handle.clone(),
                sender,
                &await_ready,
            );
            tokio::spawn(async move {
                if let Err(err) = detector.run().await {
                    warn!(error = %err, "activity detection failed");
                }
            });
        } else {
            // Use existing quiescence-based detection for shell
            let detector = ReadinessDetector::new(
                handle.clone(),
                sender,
                start_offset,
                frame.await_ready.clone(),
            );
            tokio::spawn(async move {
                if let Err(err) = detector.run().await {
                    warn!(error = %err, "readiness detection failed");
                }
            });
        }
    }
}
```

### 1.5 Update handle_interrupt similarly

Same pattern - if `activity_based` is set, use `ActivityDetector`.

---

## Part 2: Service Changes (TypeScript)

**File**: `service/src/terminal/types.ts`

### 2.1 Update TerminalInputMessage type

```typescript
export interface TerminalInputMessage extends TerminalEnvelope {
  type: "terminal_input";
  data: string; // base64
  await_ready: {
    enabled: boolean;
    quiescence_ms?: number;
    max_wait_ms?: number;
    // NEW: Activity-based detection
    activity_based?: boolean;
    activity_interval_ms?: number;
    activity_stable_count?: number;
    activity_initial_delay_ms?: number;
  };
}
```

### 2.2 Update TerminalInterruptMessage type

```typescript
export interface TerminalInterruptMessage extends TerminalEnvelope {
  type: "terminal_interrupt";
  await_ready?: {
    enabled: boolean;
    max_wait_ms?: number;
    // NEW
    activity_based?: boolean;
    activity_interval_ms?: number;
    activity_stable_count?: number;
  };
}
```

**File**: `service/src/runtime/terminal-manager.ts`

### 2.3 Update sendInput to pass activity_based

```typescript
async sendInput(
  budId: string,
  data: Buffer,
  options?: { source?: string }
): Promise<{ ok: boolean; error?: string }> {
  // Get current context to determine detection mode
  const context = this.getTerminalContext(budId);
  const useActivityBased = context.mode === "repl";

  const payload: TerminalInputMessage = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_input",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    data: data.toString("base64"),
    await_ready: {
      enabled: true,
      // Use activity-based for REPL/TUI, quiescence for shell
      activity_based: useActivityBased,
      activity_interval_ms: useActivityBased ? 5000 : undefined,
      activity_stable_count: useActivityBased ? 2 : undefined,
      activity_initial_delay_ms: useActivityBased ? 2000 : undefined,
      max_wait_ms: useActivityBased ? 60000 : 30000
    }
  };

  // ... rest of method
}
```

### 2.4 Update sendInterrupt similarly

```typescript
async sendInterrupt(budId: string): Promise<void> {
  const context = this.getTerminalContext(budId);
  const useActivityBased = context.mode === "repl";

  const payload: TerminalInterruptMessage = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_interrupt",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    await_ready: {
      enabled: true,
      activity_based: useActivityBased,
      max_wait_ms: useActivityBased ? 60000 : 5000
    }
  };

  // ... rest of method
}
```

---

## Part 3: Configuration Constants

**File**: `bud/src/main.rs`

Add constants at the top of the file:

```rust
// Activity-based readiness detection defaults
const ACTIVITY_DEFAULT_INITIAL_DELAY_MS: u64 = 2000;
const ACTIVITY_DEFAULT_INTERVAL_MS: u64 = 5000;
const ACTIVITY_DEFAULT_STABLE_COUNT: u32 = 2;
const ACTIVITY_DEFAULT_MAX_WAIT_MS: u64 = 60_000;
```

---

## Implementation Checklist

### Bud (Rust) - `bud/src/main.rs`

- [x] Add activity fields to `AwaitReady` struct
- [x] Add `ActivityDetector` struct
- [x] Implement `ActivityDetector::new()`
- [x] Implement `ActivityDetector::run()` with capture-pane loop
- [x] Implement `ActivityDetector::capture_pane()`
- [x] Implement `ActivityDetector::send_ready()`
- [x] Update `handle_input()` to dispatch to ActivityDetector when `activity_based`
- [x] Update `handle_interrupt()` similarly
- [x] Add logging for activity detection flow
- [x] Add constants for default values

### Service (TypeScript)

- [x] Update `TerminalInputMessage` type with activity fields
- [x] Update `TerminalInterruptMessage` type with activity fields
- [x] Update `sendInput()` to pass `activity_based: true` for REPL context
- [x] Update `sendInterrupt()` similarly

**Status: ✅ IMPLEMENTED (2025-12-07)**

---

## Testing Plan

### Unit Tests

1. **ActivityDetector timing**: Verify initial delay and intervals
2. **Stable count logic**: Verify ready fires after N stable checks
3. **Timeout behavior**: Verify timeout fires with low confidence

### Integration Tests

1. **Shell command**: Verify quiescence still works (fast)
2. **Claude Code interaction**:
   - Send request, verify agent waits 10-15s minimum
   - Long task (Claude runs multiple tools), verify agent waits
   - Quick response, verify ~12s wait (2s + 5s + 5s)
3. **Interrupt**: Send interrupt to Claude, verify stability detected
4. **Timeout**: Simulate hung process, verify 60s timeout

### Manual Tests

1. Run Bud agent, interact with Claude Code
2. Verify no premature "ready" signals
3. Verify reasonable wait times (not too long)
4. Check logs for activity detection flow

---

## Tuning Parameters

If false positives occur (premature ready):
- Increase `activity_stable_count` from 2 to 3
- Increase `activity_interval_ms` from 5000 to 7000

If wait times are too long:
- Decrease `activity_stable_count` from 2 to 1 (risky)
- Decrease `activity_interval_ms` from 5000 to 3000

---

## Rollback

To disable activity-based detection:
1. Service: Set `activity_based: false` in `sendInput()`
2. Falls back to existing quiescence detection

---

## Code Review Findings (2025-12-05)

### Existing Infrastructure We Can Reuse

1. **`getTerminalContext(budId)`** (terminal-manager.ts:156-182)
   - Already correctly identifies `mode: "repl"` vs `mode: "shell"`
   - Tracks `pendingCommand` state for REPL programs
   - Uses `isKnownReplProgram()` to detect Claude, Python, Node, etc.

2. **`simple_hash()`** (main.rs:802-808)
   - Already implemented for capture-pane deduplication
   - Can reuse for activity detection

3. **`ReadinessDetector`** (main.rs:1465-1708)
   - Existing quiescence-based detector
   - New `ActivityDetector` follows same pattern

### Required Type Updates

1. **`TerminalReadyTrigger`** (types.ts:17)
   - Current: `"prompt_detected" | "quiescence" | "timeout"`
   - Add: `"activity_stable"`

2. **`ReadinessAssessment`** (types.ts:99-106)
   - Add optional fields: `activity_checks?: number`, `stable_checks?: number`

### Current Code Locations

| Component | File | Lines | Notes |
|-----------|------|-------|-------|
| `AwaitReady` struct | main.rs | 381-386 | Extend with activity fields |
| `ReadinessDetector` | main.rs | 1465-1708 | Reference for `ActivityDetector` pattern |
| `handle_input()` | main.rs | 914-991 | Dispatch to `ActivityDetector` when `activity_based` |
| `handle_interrupt()` | main.rs | 1027-1060 | Same pattern |
| `TerminalInputMessage` | types.ts | 38-46 | Extend `await_ready` |
| `TerminalInterruptMessage` | types.ts | 48-54 | Extend `await_ready` |
| `sendInput()` | terminal-manager.ts | 258-306 | Add context-aware `await_ready` |
| `sendInterrupt()` | terminal-manager.ts | 308-331 | Same pattern |

### Interrupt Behavior

When interrupt is sent while in REPL mode:
1. Current behavior: `pendingCommands.set(budId, null)` clears the command
2. The interrupt readiness check should still use activity-based (we're in REPL until proven otherwise)
3. After interrupt completes and shell prompt detected, context returns to "shell" mode

This is correct - keep this behavior.

---

## Future Enhancements

1. **Adaptive intervals**: Start with shorter intervals, increase if activity persists
2. **Content-aware hashing**: Normalize timestamps before hashing to avoid false changes
3. **Program-specific configs**: Different parameters for Claude vs Python REPL vs others
