# Design: Capture-Pane Output Deduplication

_Created: 2025-12-04_

## Problem Statement

Each `terminal.capture` call retrieves the last N lines (default: 50) from tmux capture-pane. If only 20 new lines have been added since the last capture, we're sending 30 duplicate lines to the agent, wasting tokens and context window.

**Current flow:**
```
Agent calls terminal.capture (lines: -50)
  → Bud runs: tmux capture-pane -p -S -50 -J
  → Returns 50 lines to agent
  → Agent processes all 50 lines (even if 30 are duplicates from last call)
```

**Desired flow:**
```
Agent calls terminal.capture (lines: -50)
  → System detects only 20 new lines since last capture
  → Returns only 20 new lines to agent
  → Agent processes only new content
```

## Key Observations

### tmux Variables Available

```bash
tmux display -p "history_size=#{history_size} cursor=#{cursor_x},#{cursor_y} pane_height=#{pane_height}"
# Example: history_size=140 cursor=0,69 pane_height=72
```

- `history_size`: Total lines in scrollback buffer (grows as content scrolls up)
- `cursor_y`: Current cursor row in visible pane (0 = top of visible area)
- `pane_height`: Height of visible terminal (e.g., 72 rows)

**Initial thought**: `history_size` increases as content scrolls off the top. Track it between captures to calculate new lines.

**Critical flaw**: This breaks at the history limit! See below.

### The history_size Limit Problem

tmux has a `history-limit` setting (default: 2000 lines). Once reached, `history_size` stops growing:

```
# Before limit:
history_size = 1900
User runs command → 200 lines output
history_size = 2000  ← delta = 100 ✓ (some scrolled off)

# At limit:
history_size = 2000 (at limit)
User runs command → 100 lines output
history_size = 2000 (still at limit, old lines deleted)
Calculated delta = 0  ← WRONG!
```

**Any approach relying on history_size will silently fail once the buffer fills.**

### TUI Apps Don't Use Scrollback

For TUI applications (our primary focus: Claude Code, vim, htop), the history_size approach is fundamentally wrong:

- TUI apps **redraw the visible screen** - they don't scroll content into history
- A vim keystroke might change 1 character but `history_size` stays the same
- Claude Code's entire screen redraws on each response, but no scrollback is added

**Conclusion**: We need content-based comparison, not position-based tracking.

### Edge Cases to Consider

1. **TUI idle**: Screen unchanged between captures → return empty
2. **TUI redraw**: Entire screen changed → return full capture
3. **Shell output**: Partial new content at bottom → return delta
4. **Screen clear**: `clear` or `Ctrl+L` → return full (new content)
5. **Rapid captures**: Same content twice → return empty
6. **Mixed content**: Some lines same, some different → find overlap point

---

## Approach 1: tmux History Position Tracking (Bud-side)

> **⚠️ FLAWED**: Breaks at history limit and doesn't work for TUI apps. Documented for completeness.

Store `history_size` after each capture in Bud. On next capture, compare positions.

### Implementation

```rust
// In Bud's terminal handler
struct CaptureState {
    last_history_size: usize,
    last_cursor_y: usize,
    last_capture_hash: u64,  // Hash of last capture for validation
}

fn handle_capture(frame: CaptureFrame) {
    // Get current tmux state
    let history_size = get_tmux_var("history_size");
    let cursor_y = get_tmux_var("cursor_y");

    // Calculate new lines since last capture
    let last = self.capture_state.get(&session_id);
    let new_lines = if let Some(last) = last {
        // Lines scrolled into history + cursor movement in visible area
        let history_delta = history_size.saturating_sub(last.last_history_size);
        let cursor_delta = cursor_y as i32 - last.last_cursor_y as i32;

        // Simplified: just use history delta (works for scrolling terminals)
        history_delta.max(0)
    } else {
        frame.options.lines  // First capture, return full amount
    };

    // Capture only new lines (or minimum of requested)
    let start_line = -(new_lines.min(frame.options.lines.abs()) as i32);
    let output = tmux_capture_pane(start_line);

    // Update state
    self.capture_state.insert(session_id, CaptureState {
        last_history_size: history_size,
        last_cursor_y: cursor_y,
        last_capture_hash: hash(&output),
    });

    return output;
}
```

### Pros
- Uses tmux's native line tracking
- No content comparison needed
- O(1) space (just stores integers)
- Stateful in Bud, survives service restarts

### Cons
- Doesn't work well for TUI apps (cursor moves without adding history)
- `history_size` only tracks scrollback, not visible area changes
- May miss content if screen clears and restarts

### Best For
- Shell command output (ls, git log, build output)
- Log tailing scenarios

---

## Approach 2: Content Hash Comparison (Bud-side)

Store hash of last N lines from each capture. Compare to find overlap.

### Implementation

```rust
struct CaptureState {
    // Store hashes of last capture's lines (e.g., last 10 lines)
    line_hashes: Vec<u64>,  // [hash(line1), hash(line2), ...]
}

fn handle_capture(frame: CaptureFrame) {
    let full_output = tmux_capture_pane(frame.options.start_line);
    let lines: Vec<&str> = full_output.lines().collect();

    // Compute hashes for all lines
    let current_hashes: Vec<u64> = lines.iter().map(|l| hash(l)).collect();

    // Find overlap with last capture
    let last = self.capture_state.get(&session_id);
    let new_start_idx = if let Some(last) = last {
        find_overlap_end(&last.line_hashes, &current_hashes)
    } else {
        0  // No previous capture, return everything
    };

    // Store last N line hashes for next comparison
    let trailing_hashes = current_hashes.iter()
        .rev().take(10).rev()
        .cloned().collect();
    self.capture_state.insert(session_id, CaptureState {
        line_hashes: trailing_hashes,
    });

    // Return only new lines
    let new_lines = lines[new_start_idx..].join("\n");
    return new_lines;
}

fn find_overlap_end(previous: &[u64], current: &[u64]) -> usize {
    // Find where previous lines end in current capture
    // Look for the last hash from previous in current
    for (i, hash) in current.iter().enumerate() {
        if previous.last() == Some(hash) {
            // Verify it's a true match by checking preceding hashes
            if verify_sequence(&previous, &current[..=i]) {
                return i + 1;  // Start after the overlap
            }
        }
    }
    0  // No overlap found, return everything
}
```

### Pros
- Works for any content type (shell, TUI, etc.)
- Handles partial overlaps gracefully
- Degrades gracefully (returns full capture if no overlap)

### Cons
- O(n) comparison per capture
- Hash collisions could cause issues (mitigated by sequence verification)
- More memory usage (stores line hashes)

### Best For
- General-purpose solution that handles all terminal types
- When precision is more important than efficiency

---

## Approach 3: Rolling Window with Fingerprint (Service-side)

Store a fingerprint of the last capture's trailing content in TerminalManager.

### Implementation

```typescript
// In TerminalManager
private readonly lastCaptures = new Map<string, {
  trailingLines: string[];  // Last 5-10 lines
  capturedAt: number;
}>();

async capturePane(budId: string, options: CaptureOptions): Promise<CaptureResult> {
  const fullCapture = await this.rawCapturePane(budId, options);
  const lines = fullCapture.output.split('\n');

  // Find overlap with previous capture
  const previous = this.lastCaptures.get(budId);
  let newStartIdx = 0;

  if (previous && previous.trailingLines.length > 0) {
    newStartIdx = this.findOverlapIndex(previous.trailingLines, lines);
  }

  // Store trailing lines for next comparison
  const trailingCount = Math.min(10, lines.length);
  this.lastCaptures.set(budId, {
    trailingLines: lines.slice(-trailingCount),
    capturedAt: Date.now()
  });

  // Return only new content
  const newLines = lines.slice(newStartIdx);
  return {
    output: newLines.join('\n'),
    outputBytes: Buffer.byteLength(newLines.join('\n')),
    linesCaptured: newLines.length,
    fullLinesCaptured: lines.length,  // For debugging
    deduplicatedLines: newStartIdx    // How many duplicates removed
  };
}

private findOverlapIndex(previous: string[], current: string[]): number {
  // Find where previous trailing lines appear in current capture
  const lastPrevLine = previous[previous.length - 1];

  for (let i = 0; i < current.length; i++) {
    if (current[i] === lastPrevLine) {
      // Verify preceding lines match
      let match = true;
      for (let j = 0; j < previous.length && i - j >= 0; j++) {
        if (previous[previous.length - 1 - j] !== current[i - j]) {
          match = false;
          break;
        }
      }
      if (match) {
        return i + 1;  // Start after the overlap
      }
    }
  }

  return 0;  // No overlap, return everything
}
```

### Pros
- Simple TypeScript implementation
- Works with existing TerminalManager patterns
- Easy to debug and test

### Cons
- State lost on service restart
- Memory scales with number of active terminals
- Doesn't survive across API requests if service restarts

### Best For
- Quick implementation
- When service stability is high

---

## Approach 4: Sequence Marker Injection

Inject invisible markers after each capture to establish position.

### Implementation

```rust
// After each capture, inject a marker into the terminal
fn handle_capture(frame: CaptureFrame) -> String {
    let marker_id = generate_marker_id();

    // Capture current content
    let output = tmux_capture_pane(frame.options.start_line);

    // Inject invisible marker (OSC sequence that terminals typically ignore)
    // Using OSC 777 (custom) which most terminals silently consume
    let marker = format!("\x1b]777;bud-capture;{}\x07", marker_id);
    tmux_send_keys(&marker);  // Send to terminal

    // Store marker for next capture
    self.last_marker.insert(session_id, marker_id);

    // On next capture, look for marker in output
    // Everything before marker is duplicate, everything after is new
    return output;
}

fn find_new_content(output: &str, last_marker: &str) -> &str {
    if let Some(pos) = output.find(&format!("bud-capture;{}", last_marker)) {
        // Return content after marker
        &output[pos + marker.len()..]
    } else {
        output  // Marker not found, return everything
    }
}
```

### Pros
- Precise boundary detection
- Works regardless of content changes

### Cons
- Markers might be visible in some terminals
- Could interfere with TUI applications
- Pollutes terminal buffer with invisible sequences
- Complex cleanup if markers accumulate

### Best For
- NOT recommended for production
- Interesting research direction

---

## Approach 5: tmux Buffer Comparison

Use tmux's buffer feature to store last capture and compare.

### Implementation

```rust
fn handle_capture(frame: CaptureFrame) {
    // Capture current state to a named buffer
    let current_buffer = format!("bud_capture_{}", session_id);
    tmux_command(&["capture-pane", "-b", &current_buffer, "-S", &start_line]);

    // Load current buffer content
    let current = tmux_command(&["show-buffer", "-b", &current_buffer]);

    // Compare with previous buffer (if exists)
    let prev_buffer = format!("bud_capture_prev_{}", session_id);
    let previous = tmux_command(&["show-buffer", "-b", &prev_buffer]).ok();

    // Calculate delta
    let new_content = if let Some(prev) = previous {
        find_new_lines(&prev, &current)
    } else {
        current.clone()
    };

    // Rotate buffers: current becomes previous
    tmux_command(&["delete-buffer", "-b", &prev_buffer]).ok();
    tmux_command(&["set-buffer", "-b", &prev_buffer, &current]);

    return new_content;
}
```

### Pros
- Uses tmux's native storage
- Survives Bud restarts (buffers persist in tmux)
- No custom state management

### Cons
- tmux buffers are shared across sessions
- Extra tmux commands add latency
- Limited number of buffers available

### Best For
- When leveraging tmux features is preferred
- Simple deployments with few concurrent terminals

---

## Approach 6: Hybrid History + Content Verification

> **⚠️ PARTIALLY FLAWED**: History tracking component breaks at limit. The fingerprinting part is sound.

Combine tmux history tracking with content fingerprinting for best-effort deduplication.

### Implementation

```rust
// Bud-side implementation
struct CaptureState {
    history_size: usize,
    trailing_fingerprint: u64,  // Hash of last 3 lines combined
    last_content_hash: u64,     // Hash of entire last capture
}

fn handle_capture(frame: CaptureFrame) {
    // Step 1: Get current tmux state
    let current_history = get_tmux_var::<usize>("history_size");

    // Step 2: Calculate expected new lines from history delta
    let state = self.capture_states.get(&session_id);
    let history_delta = state.map(|s| current_history.saturating_sub(s.history_size)).unwrap_or(50);

    // Step 3: Capture with generous buffer (history_delta + margin for cursor movement)
    let capture_lines = (history_delta + 10).min(frame.options.lines.abs() as usize);
    let output = tmux_capture_pane(-(capture_lines as i32));
    let lines: Vec<&str> = output.lines().collect();

    // Step 4: Verify with trailing fingerprint
    let new_start = if let Some(state) = state {
        // Look for matching fingerprint in captured content
        find_fingerprint_match(&lines, state.trailing_fingerprint)
            .map(|idx| idx + 1)  // Start after match
            .unwrap_or(0)        // No match, return all
    } else {
        0
    };

    // Step 5: Handle full-screen changes (TUI apps)
    let current_hash = hash(&output);
    let is_full_redraw = state.map(|s| s.last_content_hash != current_hash).unwrap_or(true);

    // Step 6: Update state
    let trailing = lines.iter().rev().take(3).collect::<Vec<_>>().join("");
    self.capture_states.insert(session_id, CaptureState {
        history_size: current_history,
        trailing_fingerprint: hash(&trailing),
        last_content_hash: current_hash,
    });

    // Step 7: Return appropriate content
    if is_full_redraw && new_start == 0 {
        // Full screen changed, return everything
        return CaptureResult {
            output,
            deduplicated: false,
            reason: "full_redraw",
        };
    }

    let new_content = lines[new_start..].join("\n");
    return CaptureResult {
        output: new_content,
        deduplicated: true,
        lines_removed: new_start,
        reason: "overlap_detected",
    };
}

fn find_fingerprint_match(lines: &[&str], fingerprint: u64) -> Option<usize> {
    for i in 0..lines.len().saturating_sub(2) {
        let segment = lines[i..i+3].join("");
        if hash(&segment) == fingerprint {
            return Some(i + 2);  // Return index of last matched line
        }
    }
    None
}
```

### Pros
- Best of both worlds: fast history check + accurate fingerprinting
- Handles shell, TUI, and edge cases
- Graceful degradation (returns full capture if unsure)
- Minimal state (3 numbers per terminal)
- Survives in Bud, persists across API calls

### Cons
- More complex logic
- Small chance of fingerprint collision (3 lines makes this rare)

### Best For
- Shell-heavy workloads where history tracking helps
- Not ideal for TUI-focused use cases

---

## Approach 7: Bud-Managed Content Buffer (Recommended)

Store the last capture's content directly in Bud. Compare new captures against stored content to find overlap or detect changes.

**Key insight**: Since TUI apps don't use scrollback, and history_size breaks at the limit, we should just compare content directly. This is simpler, more reliable, and works for all cases.

### Implementation

See **Approach A: Bottom-Up Sequence Scanning** below for the recommended implementation.

The key insight is that we need to:
1. Store the **full previous capture** (not just trailing lines)
2. Scan current from **bottom to top** looking for sequence matches
3. Require **multiple consecutive matching lines** (not just one)
4. Verify sequences have **diversity** (to filter out homogeneous borders/padding)

```rust
// In Bud's terminal handler
struct CaptureState {
    /// Hash of entire last capture (for quick "no change" detection)
    content_hash: u64,

    /// Full previous capture lines (for sequence matching)
    lines: Vec<String>,

    /// Timestamp of last capture (for debugging)
    captured_at: u64,
}

enum DedupResult {
    Empty { reason: &'static str },
    Delta { start_idx: usize, lines_removed: usize, reason: &'static str },
    Full { reason: &'static str },
}
```

### Memory Usage

- `content_hash`: 8 bytes
- `lines`: 50 lines × ~80 chars = ~4KB
- `captured_at`: 8 bytes
- Line index (HashMap): ~2KB
- **Total: ~6KB per terminal**

For 100 concurrent terminals: ~600KB. Acceptable.

### Behavior Matrix

| Scenario | Previous | Current | Result |
|----------|----------|---------|--------|
| First capture | None | 50 lines | Return all 50 |
| No change (TUI idle) | hash=ABC | hash=ABC | Return empty |
| Full redraw (TUI) | [old screen] | [completely new] | Return all (no sequence match) |
| Claude Code: new message | [Msgs A,B,C,Footer] | [Msgs B,C,D,Footer] | Return Msg D + Footer |
| Shell output | [lines 1-50] | [lines 41-90] | Return lines 51-90 (sequence match at 41-50) |
| Screen clear | [old content] | [just prompt] | Return [prompt] (no sequence match) |
| Homogeneous footer only | all "────" | all "────" | hash match → empty |
| Footer + new content | [content + footer] | [new + footer] | Return new + footer (footer is homogeneous, skipped) |

### Edge Cases and Failure Modes

#### Problem 1: Homogeneous Trailing Lines

If trailing lines are all identical (TUI padding, borders), false matches occur:

```
Previous trailing (10 lines): all "│                              │"

Current (50 lines):
  Lines 0-29:  [NEW header/content]   ← Actual new content!
  Lines 30-49: "│                              │" (padding)

Algorithm behavior:
  - Scan from i=0, looking for "│...│"
  - Find match at i=30
  - Verify: lines 30-39 all match trailing (all identical padding)
  - Return Some(40) → "new content" is lines 40-49

RESULT: Returns 10 padding lines, MISSES lines 0-29 (actual new content)!
```

#### Problem 2: Repeating Structural Patterns

TUI tables, menus, and borders create repeating patterns that can match at wrong positions:

```
Previous trailing:
  "├──────────────────┤"
  "│ Item 1           │"
  "├──────────────────┤"
  "│ Item 2           │"
  ...

Current:
  "├──────────────────┤"
  "│ NEW Item X       │"   ← Actually new!
  "├──────────────────┤"
  "│ Item 1           │"   ← Matches previous[1], false anchor!
  ...

RESULT: May find false match, return wrong subset as "new"
```

#### Problem 3: Content Shift Without New Lines

TUI updates middle of screen, padding remains same:

```
Previous: [Header][Content A-Z][Padding 10 lines]
Current:  [Header][Content A-Z + NEW][Padding 7 lines]

Trailing matches at end, but content in middle changed.
Algorithm might return only the reduced padding as "new".
```

### Better Approaches for TUI Deduplication

The position-anchored approach works for shell but fails for TUIs like Claude Code where:
- Footer is static (input area, hints)
- Middle contains conversation history (some already sent, some new)
- Content scrolls UP as new messages appear

**Goal**: Find the deepest (lowest line number) contiguous sequence that matches previous capture, return only content AFTER that sequence.

---

## Approach A: Bottom-Up Sequence Scanning (Recommended)

Store the full previous capture. Scan current from bottom to top, looking for contiguous sequences that exist in previous. The deepest match marks the "already sent" boundary.

```rust
struct CaptureState {
    content_hash: u64,
    lines: Vec<String>,  // Full previous capture
    captured_at: u64,
}

impl TerminalHandler {
    fn deduplicate(&self, previous: &CaptureState, current: &str) -> DedupResult {
        let current_lines: Vec<&str> = current.lines().collect();

        // Quick check: identical content
        if hash(current) == previous.content_hash {
            return DedupResult::Empty { reason: "no_change" };
        }

        // First capture
        if previous.lines.is_empty() {
            return DedupResult::Full { reason: "first_capture" };
        }

        // Build index: line_content -> positions in previous
        let prev_index: HashMap<&str, Vec<usize>> = build_line_index(&previous.lines);

        const MIN_CONTENT_MATCHES: usize = 3;

        // Scan current from bottom to top
        for i in (0..current_lines.len()).rev() {
            let line = current_lines[i];

            // Skip decoration lines - they can't anchor a match
            if !is_content_line(line) {
                continue;
            }

            // Check if this content line exists in previous
            if let Some(prev_positions) = prev_index.get(line) {
                // For each position where this line appears in previous
                for &prev_pos in prev_positions {
                    // Count matching CONTENT lines going upward
                    // (decoration lines are skipped but don't break the sequence)
                    let content_matches = count_content_matches_upward(
                        &previous.lines, prev_pos,
                        &current_lines, i
                    );

                    if content_matches >= MIN_CONTENT_MATCHES {
                        // Found valid overlap with enough content matches!
                        // Return content AFTER this matched sequence
                        return DedupResult::Delta {
                            start_idx: i + 1,
                            lines_removed: i + 1,
                            reason: "sequence_match",
                        };
                    }
                }
            }
        }

        // No sequence match found
        DedupResult::Full { reason: "no_overlap" }
    }
}

/// Check if a line contains actual text content (vs decoration/borders)
fn is_content_line(line: &str) -> bool {
    let text_chars = line.chars().filter(|c| c.is_alphanumeric()).count();
    text_chars >= 3  // At least 3 alphanumeric characters
}

/// Count matching CONTENT lines going upward from given positions.
/// Decoration lines are skipped but don't break the sequence.
fn count_content_matches_upward(
    prev: &[String], prev_end: usize,
    curr: &[&str], curr_end: usize
) -> usize {
    let mut content_matches = 0;
    let mut p = prev_end as isize;
    let mut c = curr_end as isize;

    while p >= 0 && c >= 0 {
        let prev_line = &prev[p as usize];
        let curr_line = curr[c as usize];

        // Both must match (including decoration lines for position tracking)
        if prev_line != curr_line {
            break;
        }

        // Only count content lines toward the match threshold
        if is_content_line(curr_line) {
            content_matches += 1;
        }

        p -= 1;
        c -= 1;
    }

    content_matches
}

fn build_line_index<'a>(lines: &'a [String]) -> HashMap<&'a str, Vec<usize>> {
    let mut index: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        // Only index content lines - decoration lines can't anchor matches
        if is_content_line(line) {
            index.entry(line.as_str()).or_default().push(i);
        }
    }
    index
}
```

### Simpler Alternative: Content-Line Filtering

Instead of complex diversity checks, classify lines by whether they contain actual text:

```rust
fn is_content_line(line: &str) -> bool {
    // Count alphanumeric characters
    let text_chars = line.chars().filter(|c| c.is_alphanumeric()).count();
    text_chars >= 3  // At least 3 text characters
}

// Examples:
// "│                    │"     → false (decoration)
// "├────────────────────┤"     → false (decoration)
// "│  Hello world       │"     → true  (has "Helloworld")
// "$ ls -la"                   → true  (has "lsla")
// "────────────────────"       → false (decoration)
// "Type /help for help"        → true  (has text)
```

**Simplified algorithm:**
1. Scan current from bottom to top
2. **Skip decoration lines** - they can't anchor a match
3. For content lines, look for matching content lines in previous
4. Require 3+ consecutive **content line** matches
5. Decoration lines between content lines don't break the sequence

This naturally handles:
- **TUI borders resize** → ignored (decoration)
- **Footer changes** → decoration parts ignored, text parts matched
- **Box characters anywhere** → skipped automatically
- **No memorization needed** → just check for text characters

**How it handles Claude Code:**
```
Previous (50 lines):
  0-10:  [Old messages]
  11-30: [Message B]
  31-45: [Message C]
  46-49: [Footer: borders + "Type /help"]

Current (50 lines):
  0-5:   [Message B partial]
  6-25:  [Message C - matches prev 31-45!]
  26-40: [Message D - NEW]
  41-49: [Footer: borders + "Type /help"]

Scan from bottom:
  i=49: "─────────" → decoration, skip
  i=48: "│    │" → decoration, skip
  i=47: "Type /help" → CONTENT, check previous... matches prev[47]!
        But only 1 content line match so far, need 3+
  i=46: "─────────" → decoration, skip (doesn't break sequence)
  ...
  i=40: Message D last line → CONTENT, not in previous, continue up
  ...
  i=25: Message C last line → CONTENT, matches prev[45]!
        Count upward: 20 content lines match ✓
        Return Delta { start_idx: 26 } → lines 26-49

Result: Returns Message D + Footer (lines 26-49)
```

**Pros:**
- Finds actual content overlap, not just position-based
- Handles TUI scrolling correctly
- Diversity check prevents false matches on borders/padding
- Works for any TUI layout

**Cons:**
- O(n²) worst case (but n is small, ~50 lines)
- Stores full previous capture (~4KB)

---

## Approach B: Rolling Hash Sequence Fingerprints

Instead of comparing individual lines, compute fingerprints for N-line windows. More efficient for large captures.

```rust
const WINDOW_SIZE: usize = 4;

struct CaptureState {
    content_hash: u64,
    // Map: window_fingerprint -> end_position_in_previous
    fingerprints: HashMap<u64, Vec<usize>>,
    lines: Vec<String>,
}

fn compute_fingerprints(lines: &[String]) -> HashMap<u64, Vec<usize>> {
    let mut fps: HashMap<u64, Vec<usize>> = HashMap::new();

    for i in WINDOW_SIZE - 1..lines.len() {
        let window = &lines[i + 1 - WINDOW_SIZE..=i];
        let fp = hash_window(window);
        fps.entry(fp).or_default().push(i);
    }

    fps
}

fn find_overlap(previous: &CaptureState, current_lines: &[&str]) -> Option<usize> {
    // Scan current from bottom, computing window fingerprints
    for i in (WINDOW_SIZE - 1..current_lines.len()).rev() {
        let window = &current_lines[i + 1 - WINDOW_SIZE..=i];
        let fp = hash_window(window);

        if previous.fingerprints.contains_key(&fp) {
            // Verify it's not a hash collision
            if verify_match(previous, current_lines, i) {
                // Extend match upward to find full overlap
                let match_end = extend_match_upward(previous, current_lines, i);
                return Some(match_end + 1);
            }
        }
    }

    None
}
```

**Pros:**
- O(n) average case with good hash function
- Reduces false positives (4-line window less likely to match by chance)

**Cons:**
- More complex
- Hash collisions require verification step
- Misses overlaps shorter than window size

---

## Approach C: Diff-Based (Longest Common Subsequence)

Use a proper diff algorithm to find what's new. Most accurate but most expensive.

```rust
use similar::{TextDiff, ChangeTag};

fn find_new_content(previous: &str, current: &str) -> String {
    let diff = TextDiff::from_lines(previous, current);

    let mut new_lines = Vec::new();
    let mut in_new_section = false;

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => {
                in_new_section = true;
                new_lines.push(change.value());
            }
            ChangeTag::Equal => {
                if in_new_section {
                    // We've passed the new content, include rest as context
                    new_lines.push(change.value());
                }
            }
            ChangeTag::Delete => {
                // Old content, skip
            }
        }
    }

    new_lines.join("")
}
```

**Pros:**
- Most accurate - handles insertions, deletions, modifications
- Well-tested algorithms (Myers diff, patience diff)
- Could use existing crate like `similar`

**Cons:**
- O(n*m) complexity
- May be overkill for our use case
- Returns scattered insertions, not contiguous "new section"

---

## Approach D: Hybrid with App-Type Awareness

Different apps need different strategies. Use context to choose:

```rust
fn deduplicate(&self, ctx: &TerminalContext, prev: &CaptureState, curr: &str) -> DedupResult {
    // Quick check: no change
    if hash(curr) == prev.content_hash {
        return DedupResult::Empty { reason: "no_change" };
    }

    match ctx.program.as_deref() {
        // Editors: any change means full redraw needed
        Some("vim") | Some("nvim") | Some("nano") | Some("emacs") => {
            DedupResult::Full { reason: "editor_full_refresh" }
        }

        // Chat/REPL apps: find sequence overlap
        Some("claude") | Some("python") | Some("node") | Some("irb") => {
            self.sequence_scan_bottom_up(prev, curr)
        }

        // Shell: position-anchored (new content at bottom)
        None if ctx.mode == "shell" => {
            self.position_anchored_overlap(prev, curr)
        }

        // Unknown: try sequence scan, fall back to full
        _ => {
            self.sequence_scan_bottom_up(prev, curr)
        }
    }
}
```

**Pros:**
- Optimal strategy per app type
- Can add app-specific heuristics over time
- Fallback behavior is safe

**Cons:**
- More code paths to maintain
- Need to keep app list updated

---

## Comparison

| Approach | Accuracy | Performance | Complexity | TUI Support |
|----------|----------|-------------|------------|-------------|
| A. Bottom-Up Sequence | High | O(n²) | Medium | Excellent |
| B. Rolling Hash | High | O(n) | High | Good |
| C. Diff-Based (LCS) | Highest | O(n*m) | Low (use crate) | Excellent |
| D. Hybrid | Varies | Varies | High | Excellent |

---

## Final Recommendation

**Use Approach A (Bottom-Up Sequence Scanning)** with full previous capture storage:

### Why This Approach

1. **TUI-first**: Correctly handles Claude Code's scrolling conversation model
2. **Finds real overlap**: Scans bottom-up to find where previously-sent content ends
3. **Sequence matching**: Requires 3+ consecutive lines to match (not just 1)
4. **Diversity filter**: Skips homogeneous borders/padding that could cause false matches
5. **Shell-compatible**: Works for traditional scrolling output too
6. **Safe fallback**: Returns full capture when uncertain

### Implementation Steps

1. Add `CaptureState` struct to Bud's terminal handler:
   - `content_hash: u64` - for quick "no change" detection
   - `lines: Vec<String>` - full previous capture for sequence matching
   - `captured_at: u64` - for debugging

2. On each capture:
   - Hash current content
   - If hash matches previous → return empty ("no_change")
   - If no previous state → return full ("first_capture")
   - Build line index from previous capture
   - Scan current from bottom to top, looking for sequence matches
   - If sequence found (3+ lines, 2+ distinct) → return delta (content after match)
   - If no sequence found → return full ("no_overlap")

3. Update state for next capture

### Future Enhancements

1. **Approach D (app-type awareness)**: Always return full for vim/editors
2. **Approach B (rolling hash)**: If O(n²) becomes a performance issue
3. **Approach C (diff-based)**: If more accuracy needed for complex TUIs

### API Change

```typescript
// Bud → Service response
type CaptureResponsePayload = {
  requestId: string;
  output: string;        // base64
  outputBytes: number;
  linesCaptured: number;
  // New fields:
  deduplicated: boolean;
  linesRemoved: number;
  reason: "first_capture" | "no_change" | "sequence_match" | "no_overlap";
};

// Service → Agent response (unchanged, but now may be empty)
type CaptureResult = {
  output: string;
  outputBytes: number;
  linesCaptured: number;
  // Could optionally expose:
  deduplicated?: boolean;
  reason?: string;
};
```

### Why Not the Others?

| Approach | Problem |
|----------|---------|
| 1. History Tracking | Breaks silently at history-limit (2000 lines) |
| 2. Hash Comparison | Works, but more complex than needed |
| 3. Rolling Window | State in Service, lost on restart |
| 4. Marker Injection | Pollutes terminal, breaks TUI apps |
| 5. tmux Buffers | Extra tmux commands add latency |
| 6. Hybrid | Relies on flawed history tracking |

---

## Open Questions

1. **Should we expose deduplication to the agent?**
   - Option A: Always deduplicate, agent sees only new content
   - Option B: Add `deduplicate: boolean` parameter, default true
   - **Recommendation**: Always deduplicate (simpler for agent)

2. **What if the agent explicitly wants full history?**
   - Solution: Add `force_full: boolean` option to bypass deduplication
   - This clears the capture state and returns full content
   - Use case: Agent reviewing older context after confusion

3. **How to handle "no change" case?**
   - When hash matches, we return empty output with `reason: "no_change"`
   - Should agent see this as an empty string, or should we return last capture?
   - **Recommendation**: Return empty - agent understands "no new content"

4. **What about the `lines` parameter?**
   - If agent requests `lines: -100` but dedup returns 10 lines, is that confusing?
   - **Recommendation**: `lines` is a max/hint, not a guarantee. Document this.

5. **Should we track per-session or per-terminal?**
   - Currently one Bud process = one terminal session
   - State is naturally scoped to the terminal
   - **Answer**: Per-terminal (current design is correct)

6. **Performance impact?**
   - Hash: O(n) but n ≈ 4KB, ~microseconds with xxhash/fnv
   - Overlap scan: O(10 × 50) = 500 string comparisons, ~microseconds
   - **Verdict**: Negligible overhead
