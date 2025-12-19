# Debug: terminal.capture Returns Empty Output

## Environment

- Service: Node.js/Fastify backend
- Bud daemon: Rust CLI with tmux integration
- Terminal: tmux-backed session with pipe-pane logging

## Symptom

When the agent calls `terminal.capture` multiple times in succession, subsequent calls return empty output even though the terminal has visible content:

```json
{
  "tool": "terminal.capture",
  "input": null,
  "output": "",
  "call_id": "call_924t3iP79kWVOXslBPBE4rZo",
  "context": { "mode": "shell" },
  "last_line": "",
  "readiness": {
    "hints": {
      "looks_like_error": false,
      "looks_like_pager": false,
      "looks_like_prompt": false,
      "looks_like_password": false,
      "looks_like_confirmation": false,
      "may_still_be_processing": true
    },
    "ready": false,
    "trigger": "quiescence",
    "confidence": 0.25
  },
  "truncated": false,
  "output_bytes": 0,
  "omitted_lines": 0
}
```

Expected: Last ~50 lines of terminal content (the default `startLine: -50` in agent-service.ts:751)

## Root Cause

**Deduplication logic in the bud daemon's `handle_capture`** returns empty output when the terminal content hash hasn't changed between captures.

### Code Path

1. **Agent calls `terminal.capture`** (agent-service.ts:750-802)
   ```typescript
   const capture = await this.terminalSessionManager.capturePane(
     sessionId,
     { startLine: lines, joinLines: true },
     directive.timeoutMs ?? 5000
   );
   ```

2. **Service sends `terminal_capture` WebSocket message to bud** (terminal-session-manager.ts:793-838)

3. **Bud daemon handles `terminal_capture`** (main.rs:963-1104)
   - Executes `tmux capture-pane`
   - **Applies deduplication** - returns empty string if hash matches previous capture

4. **`deduplicate_capture` logic** (main.rs:598-620)
   ```rust
   fn deduplicate_capture(
       state: Option<&CaptureState>,
       output: &str,
       current_hash: u64,
   ) -> DedupResult {
       if let Some(prev) = state {
           if prev.content_hash == current_hash {
               return DedupResult {
                   output: String::new(),  // <-- RETURNS EMPTY
                   deduplicated: true,
                   lines_removed: line_count,
                   reason: "no_change",
               };
           }
       }
       // ...
   }
   ```

## Key Insight: Deduplication is Redundant

**The deduplication in `handle_capture` is not needed** because the only use case that requires hash comparison already handles it separately:

### ActivityDetector (TUI readiness detection)

The `ActivityDetector` (main.rs:1641-1783) is used for TUI/REPL apps to detect screen stability. It:

1. **Has its own `capture_pane()` method** (line 1785) that directly calls `tmux capture-pane`
2. **Tracks hashes internally** (lines 1679, 1726-1778)
3. **Does NOT use `handle_capture`** at all

```rust
// ActivityDetector::run() - has its own hash tracking
let mut last_hash: Option<u64> = None;
// ...
let current_hash = simple_hash(output.as_bytes());
match last_hash {
    Some(prev) if prev == current_hash => {
        stable_count += 1;
        // ...
    }
    // ...
}
last_hash = Some(current_hash);
```

### ContextSyncService (terminal state change detection)

The `ContextSyncService` (context-sync-service.ts:112-128) also handles deduplication at the service layer:

```typescript
// Computes its own hash
const hash = createHash("sha256").update(capture).digest("hex").slice(0, 16);

// Compares against stored snapshot (detectStateChange method)
if (currentHash === lastSnapshot.screenHash) {
  return { changed: false };
}
```

## The Problem

The deduplication in `handle_capture` was added thinking it would help ActivityDetector, but:

1. **ActivityDetector doesn't use it** - has separate code path
2. **ContextSyncService doesn't need it** - handles comparison at service layer
3. **Agent `terminal.capture` is broken by it** - legitimate repeated captures return empty

## Affected Files

| File | Role |
|------|------|
| `bud/src/main.rs:225-231` | `CaptureState` struct (stores hash per session) |
| `bud/src/main.rs:590-620` | `deduplicate_capture()` function |
| `bud/src/main.rs:1061-1073` | Deduplication applied in `handle_capture` |
| `bud/src/main.rs:1641-1783` | `ActivityDetector` with its own hash tracking |

## Recommended Fix

**Remove the deduplication from `handle_capture`** in the bud daemon.

The bud daemon should simply:
1. Execute `tmux capture-pane`
2. Return the raw output

Changes needed in `bud/src/main.rs`:

1. Remove `capture_states` HashMap from `TerminalState`
2. Remove `CaptureState` struct
3. Remove `deduplicate_capture()` function
4. Remove deduplication logic from `handle_capture()`
5. Remove `capture_states.remove()` calls (in resize, close handlers)

The deduplication concern should remain at the appropriate layers:
- **ActivityDetector**: Already has internal hash tracking (no changes needed)
- **ContextSyncService**: Already compares hashes at service layer (no changes needed)

## Testing Plan

After fix:
1. Start terminal session
2. Run a command (e.g., `ls -la`)
3. Call `terminal.capture` multiple times in succession
4. Verify each call returns the same non-empty output
5. Verify activity-based readiness detection still works for TUI apps
6. Verify context sync still detects state changes correctly

---

## Fix Applied

Removed deduplication from `handle_capture` in `bud/src/main.rs`:

1. Removed `capture_states` HashMap from `TerminalState`
2. Removed `CaptureState` struct
3. Removed `deduplicate_capture()` function and `DedupResult` struct
4. Simplified `handle_capture()` to return raw `tmux capture-pane` output
5. Removed `capture_states.remove()` calls from resize and close handlers
6. Removed `capture_states.clear()` from `clear_sender()`

The bud daemon now faithfully returns what `tmux capture-pane` gives it. Deduplication remains at the appropriate layers:
- **ActivityDetector**: Has its own internal hash tracking (unchanged)
- **ContextSyncService**: Compares hashes at service layer (unchanged)

---

*Created: 2024-12-18*
*Status: FIXED*
