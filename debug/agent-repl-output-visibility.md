# Agent REPL Output Visibility

_Created: 2025-12-04_

## Problem Statement

The agent cannot reliably see output from REPLs like Claude Code. When the agent runs `claude` and sends a request, it often receives incomplete, mangled, or empty output. This prevents the agent from:

1. Understanding Claude Code's responses
2. Making decisions based on the output
3. Knowing when Claude Code has finished processing

## Current Architecture

### Data Flow

```
User input → terminal.run → tmux send-keys
                              ↓
                         [Claude Code processes]
                              ↓
                    tmux pipe-pane → log file
                              ↓
                    Bud reads file (50ms poll)
                              ↓
              WebSocket terminal_output frames
                              ↓
               Service stores in PostgreSQL
                              ↓
          terminal_ready fires (quiescence/prompt)
                              ↓
              Agent calls tailOutput(sinceOffset)
                              ↓
              Agent receives decoded output
```

### Key Parameters

| Parameter | Value | Location |
|-----------|-------|----------|
| `terminalOutputBackfillBytes` | 4096 (4KB) | `service/src/config.ts:49` |
| Readiness tail read | 16KB max | `bud/src/main.rs:1308` |
| Quiescence timeout | 1500ms | `bud/src/main.rs:1255` |
| Max wait timeout | 30000ms | `bud/src/main.rs:1260` |
| Poll interval | 50ms | `bud/src/main.rs` output watcher |

### Readiness Detection

The `ReadinessDetector` in Bud (`main.rs:1235-1443`) determines when terminal output has "settled":

1. Monitors log file size for quiescence (no change for 1.5s)
2. Reads last 16KB of output
3. Analyzes last line for prompt patterns
4. Sends `terminal_ready` with confidence score and hints

**Prompt patterns recognized:**
- Shell: `$`, `#`, `%`, `:~$`
- Python: `>>>`, `...`, `In [`
- Node: single `>`
- Confirmation: `[y/n]`, `yes/no`, `continue?`
- Password: `password:`, `passphrase`
- Pager: `:`, `(END)`, `--More--`

**NOT recognized:**
- Claude Code's prompt (it's a TUI, not a line-based prompt)
- Other TUI applications
- Custom REPL prompts

---

## Hypotheses

### Hypothesis 1: 4KB Backfill Is Insufficient

**Evidence:**
- `terminalOutputBackfillBytes` defaults to 4096 bytes
- Claude Code responses can easily be 10-50KB
- Agent receives truncated output

**Impact:** Agent sees only the tail end of Claude Code's response, missing context.

**Diagnostic:** Check `outputBytes` vs `decodedLength` in agent logs:
```
terminal.run received output {
  tailBytes: 45000,      // Total available
  tailDataLength: 4096,  // What we requested
  decodedLength: 3800,   // After ANSI strip
  truncated: true
}
```

**Potential fix:** Increase `terminalOutputBackfillBytes` or make it configurable per-context.

---

### Hypothesis 2: Claude Code Uses TUI, Not Line-Based Output

**Evidence:**
- Claude Code is a TUI application using xterm.js-style rendering
- Output includes cursor positioning (`ESC[H`), screen clearing (`ESC[2J`), etc.
- "Last line" for prompt detection is meaningless in a TUI context

**Impact:**
- Readiness detection fails (no recognizable prompt pattern)
- ANSI stripping produces garbled text (loses screen layout)
- Output may appear as one long line or scattered fragments

**Example of what agent might see after ANSI strip:**
```
Claude Code> Please review the code[cursor moves]
Analyzing...[screen clear]
Found 3 issues:
1. Missing error handling
2. ...[cursor repositioning loses context]
```

**Potential fix:**
- Detect TUI mode and use alternate capture strategy
- Parse terminal state buffer instead of raw output stream
- Increase quiescence time for TUI apps

---

### Hypothesis 3: Quiescence Timing Doesn't Match Claude Code's Output Pattern

**Evidence:**
- Claude Code streams responses with variable delays between chunks
- 1.5s quiescence may trigger mid-response
- Multiple `terminal_ready` events may fire during one Claude response

**Impact:**
- Agent proceeds before Claude Code finishes
- Subsequent tool calls see partial output
- Agent makes decisions based on incomplete information

**Example scenario:**
```
t=0ms    Agent sends request to Claude Code
t=500ms  Claude starts responding
t=1500ms [quiescence pause in streaming]
t=1500ms Bud fires terminal_ready (PREMATURE!)
t=1700ms Agent reads partial output
t=2000ms Claude continues responding (agent missed this)
```

**Potential fix:**
- Increase quiescence for known programs (Claude Code → 5s?)
- Look for end-of-response markers instead of quiescence
- Allow agent to request "observe with longer timeout"

---

### Hypothesis 4: Screen Buffer vs Stream Mismatch

**Evidence:**
- tmux pipe-pane captures the raw byte stream, not the rendered screen
- TUI apps send control sequences that only make sense in a terminal emulator
- The "output" includes all the intermediate rendering steps

**Impact:**
- Agent gets control sequences instead of visible text
- Content is duplicated/overwritten as TUI refreshes
- ANSI strip removes essential structure

**Example raw stream for a simple Claude response:**
```
ESC[?1049h          # Switch to alternate screen buffer
ESC[H               # Cursor home
ESC[2J              # Clear screen
Claude Code         # Draw header
ESC[10;1H           # Move cursor to row 10
Analyzing...        # Draw status
ESC[10;1H           # Cursor back to same position
Found 3 issues:     # Overwrite with new content
ESC[11;1H           # Next row
1. Missing err...   # Continue drawing
```

After ANSI stripping, this might become:
```
Claude CodeAnalyzing...Found 3 issues:1. Missing err...
```

**Potential fix:**
- Implement terminal emulator parsing (like xterm.js does)
- Extract "screen state" at moment of readiness
- Use alternate screen buffer detection

---

### Hypothesis 5: Agent Needs More Output On Demand

**Evidence:**
- Agent receives 4KB, but Claude's response was 20KB
- No mechanism for agent to say "give me more"
- `terminal.observe` returns same backfill amount

**Impact:**
- Agent is limited to fixed window of output
- Can't scroll back to see full response
- Must make decisions with partial information

**Potential fix:**
- Add `terminal.scroll` or `terminal.getOutput(offset, length)` tool
- Allow `terminal.observe` to specify desired byte range
- Implement pagination in tool results

---

### Hypothesis 6: Concurrent Output and Readiness Race

**Evidence:**
- Output is stored in DB asynchronously
- Readiness is tracked in memory synchronously
- Small window where readiness fires but DB doesn't have all bytes

**Impact:**
- Agent reads output immediately after readiness
- DB might be 1-2 chunks behind
- Agent sees slightly stale output

**Current mitigation:**
- `lastOffsets` Map tracks offsets in memory (not DB)
- `tailOutput(sinceOffset)` queries by byte offset

**Remaining gap:**
- If Bud sends output + readiness back-to-back
- Output handler hasn't finished inserting when agent reads

**Potential fix:**
- Add small delay after readiness before reading (10-50ms)
- Track "bytes expected" in readiness message, wait for DB to match
- Use in-memory buffer as source of truth, not DB

---

## Recommended Solution: `tmux capture-pane`

### The Key Insight

We're currently using `pipe-pane` which captures the **raw byte stream** sent to the terminal. For TUI apps, this includes all the intermediate rendering steps (cursor moves, screen clears, overwrites).

**`tmux capture-pane`** captures the **rendered screen buffer** - exactly what a user would see. This is the correct approach for TUI applications like Claude Code.

### capture-pane Options

```bash
tmux capture-pane -p -t session_name           # Visible screen as plain text
tmux capture-pane -p -e -t session_name        # With ANSI colors preserved
tmux capture-pane -p -S -1000 -E - -t session  # Last 1000 lines + visible
tmux capture-pane -p -S - -E - -t session      # All scrollback + visible
tmux capture-pane -p -J -t session_name        # Join wrapped lines
```

Key flags:
- `-p` → Output to stdout (not paste buffer)
- `-e` → Preserve ANSI escape sequences (colors)
- `-J` → Join wrapped lines into single logical lines
- `-S <start>` → Start line (negative for scrollback, `-` for all)
- `-E <end>` → End line (`-` for visible bottom)
- `-t <target>` → Target session/pane

### Proposed Hybrid Approach

Keep `pipe-pane` for streaming output to the frontend (user sees live updates), but use `capture-pane` for **agent observation**:

```
Frontend (real-time display):
  pipe-pane → log file → SSE → xterm.js

Agent (accurate text extraction):
  capture-pane → rendered screen → agent
```

### Implementation Options

#### Option A: capture-pane on readiness (Simplest)

When readiness fires, run `capture-pane` to get current screen state:

```rust
// In ReadinessDetector::run(), after quiescence detected:
let screen = Command::new("tmux")
    .args(["capture-pane", "-p", "-J", "-S", "-500", "-t", &session_name])
    .output()
    .await?;
let visible_text = String::from_utf8_lossy(&screen.stdout);
```

**Pros:**
- Simple to implement
- Gets exactly what user sees
- Works for any TUI, not just Claude Code

**Cons:**
- Only captures at moment of readiness
- May miss content that scrolled off screen
- Additional exec per readiness event

#### Option B: capture-pane as agent tool (Most Flexible)

Add new tool `terminal.capture` that runs `capture-pane` on demand:

```typescript
// New tool: terminal.capture
if (directive.tool === "terminal.capture") {
  const lines = directive.lines ?? 500;  // How much scrollback
  const screen = await capturePane(budId, lines);
  return {
    output: screen,
    outputBytes: screen.length,
    source: "capture-pane",
    ...
  };
}
```

**Pros:**
- Agent controls when to capture
- Can request different amounts of scrollback
- Can be used alongside `terminal.observe` (stream) vs `terminal.capture` (screen)

**Cons:**
- Requires new tool and system prompt changes
- Agent must know when to use capture vs observe

#### Option C: Replace tailOutput with capture-pane for REPLs (Targeted)

When `context.mode === "repl"`, use `capture-pane` instead of reading from the log:

```typescript
// In executeTerminalCall, after readiness:
if (getContext().mode === "repl") {
  // Use capture-pane for TUI apps
  const screen = await this.capturePane(bud.budId, 500);
  decoded = screen;
} else {
  // Use pipe-pane log for shell commands
  const tail = await this.terminalManager.tailOutput(...);
  decoded = this.decodeTail(tail.data);
}
```

**Pros:**
- Automatic - no agent changes needed
- Right tool for the right context
- Preserves existing behavior for shell commands

**Cons:**
- Needs Bud-side implementation (service can't run tmux directly)
- Requires new WebSocket frame type

### Recommendation: Option C with Option B as Enhancement

1. **Immediate**: Implement Option C
   - Bud adds `terminal_capture` frame handler
   - Service requests capture via WebSocket
   - Automatic for REPL context, transparent to agent

2. **Follow-up**: Add Option B as explicit tool
   - Agent can request capture with custom scrollback
   - Useful when agent wants to re-read after scrolling

---

## Other Recommendations

### Immediate (In Addition to capture-pane)

1. **Increase backfill for shell context too**
   - 4KB is small even for shell commands
   - Consider 16KB default, 64KB for REPLs

2. **Add program-specific quiescence**
   - Claude Code: 5s quiescence (streaming responses)
   - Python/Node: 1.5s (line-based, fast)

3. **Log what agent actually sees**
   - Add diagnostic logging of raw output before/after processing
   - Compare pipe-pane vs capture-pane output

### Medium-Term

4. **Agent output pagination**
   - New tool: `terminal.getMoreOutput(fromOffset, maxBytes)`
   - Agent can request historical output on demand

5. **Enhanced readiness for Claude Code**
   - Look for Claude Code's specific "idle" indicators
   - Or: parse capture-pane output for prompt detection

### Long-Term

6. **Alternate output channel for REPLs**
   - Claude Code exposes MCP or API
   - Agent communicates directly, bypassing terminal
   - Terminal is just for user observation

---

## Diagnostic Steps

### To verify Hypothesis 1 (insufficient backfill):

```bash
# Enable agent debug logging
AGENT_DEBUG=1

# Watch for output truncation
grep "truncated.*true" service.log
grep "tailBytes.*decodedLength" service.log
```

### To verify Hypothesis 2 (TUI output mangling):

```bash
# Capture raw terminal output to file
# Then compare:
cat /tmp/bud_terminal_*.log | xxd | head -100  # Raw bytes
cat /tmp/bud_terminal_*.log | strings          # Printable only
```

### To verify Hypothesis 3 (premature readiness):

```bash
# Check readiness timing
grep "terminal_ready" service.log
# Look for multiple readiness events during single Claude response
# Check trigger: "quiescence" vs "prompt_detected"
```

### To check what agent actually receives:

Look for these log entries:
```
terminal.run received output {
  budId: "...",
  offsetBeforeInput: 12345,
  tailBytes: 45000,         # <-- Total available
  tailDataLength: 4096,     # <-- What we got
  decodedLength: 3800,      # <-- After processing
  decodedPreview: "..."     # <-- First 300 chars
}
```

---

## Related Files

- `service/src/config.ts` - `terminalOutputBackfillBytes` setting
- `service/src/runtime/terminal-manager.ts` - `tailOutput()`, readiness handling
- `service/src/agent/agent-service.ts` - `executeTerminalCall()`, `decodeTail()`
- `bud/src/main.rs` - `ReadinessDetector`, output watcher
- `service/src/terminal/known-programs.ts` - REPL program registry

## Next Steps

1. Add diagnostic logging to capture actual output sizes
2. Experiment with increased backfill for Claude Code context
3. Capture sample Claude Code output to analyze TUI sequences
4. Consider adding `terminal.getMoreOutput` tool for agent pagination
