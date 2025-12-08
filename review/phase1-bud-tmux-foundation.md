# Phase 1 Review: Bud tmux Foundation

**Reviewed:** 2025-11-30
**Status:** ✅ COMPLETE
**Design Doc:** `plan/persistent-terminal.md` Section 12, Phase 1

---

## Scope

Phase 1 deliverables from design doc:
- [ ] Bud: tmux session management (create, detect existing, cleanup)
- [ ] Bud: Output capture via pipe-pane + file watching
- [ ] Protocol: terminal_ensure, terminal_input, terminal_output, terminal_status
- [ ] Hello message advertising terminal capabilities

---

## Implementation Review

### 1. tmux Session Management ✅

**File:** `bud/src/main.rs` (lines 1020-1072)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Session name | "bud_terminal" (configurable) | `--terminal_session` flag, default "bud_terminal" | ✅ |
| Create session | `tmux new-session -d -s {name}` | Lines 1051-1064: `new-session -d -s {name} -x {cols} -y {rows} -c {cwd} {shell}` | ✅ |
| Detect existing | `tmux has-session -t {name}` | Lines 1029-1035 | ✅ |
| Adopt existing | Resume output watcher from current offset | Lines 1165-1175: seeks to current file size | ✅ |
| Get PID | `tmux display-message -p "#{pane_pid}"` | Lines 1455-1479 | ✅ |
| Get CWD | `tmux display-message -p "#{pane_current_path}"` | Lines 1455-1479 | ✅ |

**CLI Flags:**
```
--terminal_enabled    Feature flag (default false)
--terminal_session    tmux session name (default "bud_terminal")
--terminal_log        Log file path (default "/tmp/bud_terminal.log")
--terminal_cols       Terminal width (default 200)
--terminal_rows       Terminal height (default 50)
```

### 2. Output Capture via pipe-pane ✅

**File:** `bud/src/main.rs` (lines 1074-1096)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Log file | `/tmp/bud_terminal.log` | Configurable via `--terminal_log` | ✅ |
| pipe-pane setup | `tmux pipe-pane -t {session} "cat >> {log}"` | Lines 1083-1091 | ✅ |
| Reconnect handling | Re-establish pipe after disconnect | **Fixed**: First stops existing pipe, then starts fresh (removed `-o` flag) | ✅ |

**Key Implementation Detail:**
```rust
// Lines 1074-1096: Setup pipe-pane
// 1. Stop any existing pipe: tmux pipe-pane -t {session}  (no command)
// 2. Start new pipe: tmux pipe-pane -t {session} "cat >> {log_path}"
// Note: No -o flag - ensures fresh pipe after reconnect
```

### 3. Output Watcher ✅

**File:** `bud/src/main.rs` (lines 1142-1203)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Poll interval | ~50ms | 50ms (line 1184) | ✅ |
| Sequence numbers | Monotonic seq per chunk | AtomicU64 counter (line 1170) | ✅ |
| Byte offset tracking | Track position in stream | `byte_offset` field (line 1179) | ✅ |
| Base64 encoding | Encode output data | Line 1178 | ✅ |

**Output Watcher Flow:**
1. Polls log file size every 50ms
2. When size > current_offset: read new bytes
3. Send `terminal_output` frame with seq, data (base64), byte_offset
4. Update offset to new file size

### 4. Input Handling (send-keys) ✅

**File:** `bud/src/main.rs` (lines 833-884)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Literal input | `tmux send-keys -t {session} -l "{input}"` | Lines 854-858 | ✅ |
| Base64 decode | Decode input from message | Line 848 | ✅ |
| Readiness request | `await_ready` flag triggers detector | Lines 869-879 | ✅ |

### 5. Interrupt Handling (Ctrl+C) ✅

**File:** `bud/src/main.rs` (lines 915-948)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Send Ctrl+C | `tmux send-keys -t {session} C-c` | Lines 925-927 | ✅ |
| Readiness after | Optional readiness detection | Lines 935-946 | ✅ |

### 6. WSS Frame Types ✅

**Bud → Backend:**

| Frame | Fields | Implemented | Status |
|-------|--------|-------------|--------|
| `terminal_status` | state, info (tmux_session, pid, shell, cwd, cols, rows, output_log_bytes, timestamps) | Lines 767-830 | ✅ |
| `terminal_output` | seq, data (base64), byte_offset | Lines 1171-1180 | ✅ |
| `terminal_ready` | assessment (ready, confidence, trigger, prompt_type, hints) | Lines 1359-1452 | ✅ |

**Backend → Bud:**

| Frame | Fields | Implemented | Status |
|-------|--------|-------------|--------|
| `terminal_ensure` | config (shell, cwd, cols, rows) | Lines 382-410 | ✅ |
| `terminal_input` | data (base64), await_ready | Lines 833-884 | ✅ |
| `terminal_interrupt` | await_ready | Lines 915-948 | ✅ |
| `terminal_resize` | cols, rows | Lines 885-913 | ✅ |
| `terminal_close` | reason | Lines 949-978 | ✅ |

**Envelope Format:**
```json
{
  "proto": "0.2",
  "type": "terminal_*",
  "id": "<ulid>",
  "ts": <milliseconds>,
  ...
}
```

### 7. Hello Message Capabilities ✅

**File:** `bud/src/main.rs` (lines 2107-2147)

| Capability | Expected | Implemented | Status |
|------------|----------|-------------|--------|
| `terminal` | boolean flag | `true` if enabled && tmux available | ✅ |
| `terminal_proto` | protocol version | `"0.2"` | ✅ |
| `terminal_backends` | list of backends | `["tmux"]` | ✅ |
| `tmux_version` | version string | Output of `tmux -V` | ✅ |

**Hello Capabilities Snippet:**
```json
{
  "capabilities": {
    "terminal": true,
    "terminal_proto": "0.2",
    "terminal_backends": ["tmux"],
    "tmux_version": "tmux 3.4"
  }
}
```

### 8. Readiness Detection ✅

**File:** `bud/src/main.rs` (lines 1210-1452)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Prompt patterns | shell, python, node, ruby, confirmation, password, pager, database | Lines 1359-1420 | ✅ |
| Quiescence detection | Output quiet for N ms | Default 1500ms (line 1230) | ✅ |
| Heuristic scoring | Base 0.5 with adjustments | Lines 1315-1341 | ✅ |
| Timeout | Max wait time | Default 30s (line 1235) | ✅ |

**Prompt Detection Patterns:**
- Shell: ends with `$`, `#`, `%`, contains `:~$` → conf 0.95
- Python: starts with `>>>`, `...`, `In [` → conf 0.95
- Node: `>` → conf 0.85
- Confirmation: contains `[y/n]`, `yes/no` → conf 0.95
- Password: ends with `password:` → conf 0.95
- Pager: `:`, `(END)`, `--More--` → conf 0.90
- Database: ends with `mysql>`, `postgres=#` → conf 0.95

---

## Gaps & Notes

### Minor Gaps (Not Blocking)

1. **ANSI/Binary Guards**: Not yet implemented (Phase 4 scope)
   - Output is stored raw; agent receives raw bytes
   - Plan: Strip ANSI for agent, detect binary output

2. **Hello Terminal State**: Advertises capabilities but not current session state
   - Design mentioned optional terminal state in hello
   - Current: Only capabilities, no active session info

3. **Idle State**: "idle" state defined but never transitioned to
   - States: none, creating, ready, active, idle, closed
   - No timer to mark terminal idle after inactivity

### Implementation Notes

- **Pipe-pane fix**: Recent fix removed `-o` flag to ensure fresh pipe after reconnect
- **Protocol version**: Uses `0.2` for terminal frames, `0.1` for main WSS
- **Output watcher**: Runs in dedicated tokio task, survives reconnects

---

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Backend can request terminal, Bud creates it | ✅ |
| Can send input, see output in real-time | ✅ |
| Terminal survives Bud restart | ✅ (tmux session persists) |
| Output captured via pipe-pane | ✅ |
| Readiness detection works | ✅ |

---

## File References

| File | Lines | Purpose |
|------|-------|---------|
| `bud/src/main.rs` | 767-1208 | TerminalManager impl |
| `bud/src/main.rs` | 1210-1452 | ReadinessDetector impl |
| `bud/src/main.rs` | 2107-2147 | Hello frame with caps |
| `bud/src/main.rs` | 80-101 | CLI flags |

---

## Verdict

**Phase 1: ✅ COMPLETE**

All core deliverables implemented and working. Minor gaps (ANSI guards, idle state) are deferred to Phase 4 per plan.
