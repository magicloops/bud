# Debug: Capture-Pane Deduplication Failure

_Created: 2025-12-05_

## Problem

The deduplication algorithm is returning full output when it should detect overlap. Two consecutive captures of Claude Code TUI returned nearly identical content, but the algorithm reported `reason: "no_overlap"`.

## Evidence

**Capture 1** (95 lines):
```
╭─── Claude Code v2.0.59 ────────────────...
│                           │ Recent activity
│     Welcome back Adam!    │ 2m ago  This session...
│                           │ 5h ago  This session...
...
```

**Capture 2** (~95 lines, ~2 seconds later):
```
╭─── Claude Code v2.0.59 ────────────────...
│                           │ Recent activity
│     Welcome back Adam!    │ 2m ago  This session...
...
```

The algorithm should have found the overlap and returned only new content (likely just a few lines or empty).

---

## Root Cause Analysis

### Issue 1: Timestamp changes in "Recent activity"

The lines contain relative timestamps like "2m ago" that change over time:
```
│     Welcome back Adam!    │ 2m ago  This session...
```

After 1 minute, this becomes:
```
│     Welcome back Adam!    │ 3m ago  This session...
```

This breaks exact line matching even though the content is semantically identical.

### Issue 2: Content line threshold may be wrong

Our `is_content_line()` function counts alphanumeric characters:
```rust
fn is_content_line(line: &str) -> bool {
    line.chars().filter(|c| c.is_alphanumeric()).count() >= 3
}
```

TUI lines like this pass the check:
```
│                           │ 2m ago  This session...
```

But they contain volatile data (timestamps). We're treating them as stable content lines when they're actually volatile.

### Issue 3: Box-drawing characters create unique lines

Every TUI line starts with `│` and may contain unique spacing. If the content within varies even slightly (cursor position, truncation), the lines won't match.

---

## Solution Options

### Option A: Normalize timestamps before comparison

Strip or normalize time patterns before hashing/comparison:
```rust
fn normalize_line(line: &str) -> String {
    // Remove relative timestamps like "2m ago", "5h ago", "1d ago"
    let re = Regex::new(r"\d+[smhd] ago").unwrap();
    re.replace_all(line, "TIME_AGO").to_string()
}
```

**Pros**: Handles the specific Claude Code case
**Cons**: Regex overhead, might not cover all volatile patterns

### Option B: Use fuzzy line matching

Instead of exact string match, use similarity threshold (e.g., 90% similar = match):
```rust
fn lines_similar(a: &str, b: &str) -> bool {
    let similarity = strsim::jaro_winkler(a, b);
    similarity > 0.9
}
```

**Pros**: Handles many volatile patterns
**Cons**: False positives, more complex, slower

### Option C: Hash only stable portions of lines

Strip box-drawing characters and leading/trailing whitespace before hashing:
```rust
fn stable_content(line: &str) -> String {
    line.chars()
        .filter(|c| !is_box_drawing(*c))
        .collect::<String>()
        .trim()
        .to_string()
}
```

**Pros**: Focuses on actual content
**Cons**: May still miss volatile timestamps

### Option D: Increase MIN_CONTENT_MATCHES threshold

Current: 3 consecutive content lines must match
Proposed: Increase to 5 or use a ratio (e.g., 20% of lines)

**Pros**: More robust against false negatives
**Cons**: Might miss legitimate short overlaps

### Option E: Add "structural" matching

Instead of line-by-line, detect TUI structure:
1. Find header line (e.g., `╭─── Claude Code`)
2. Find footer line (e.g., `╰───`)
3. Compare content between them, ignoring volatile fields

**Pros**: TUI-aware
**Cons**: Complex, app-specific

### Option F: Content hash with volatile field stripping

Combine approaches:
1. Identify volatile patterns: timestamps, cursor positions, counters
2. Replace with placeholders before hashing
3. Use normalized hash for comparison

```rust
fn normalize_for_hash(line: &str) -> String {
    let s = line.to_string();
    // Strip relative timestamps
    let s = regex_replace(&s, r"\d+[smhd] ago", "T_AGO");
    // Strip absolute times
    let s = regex_replace(&s, r"\d{1,2}:\d{2}(:\d{2})?", "T_TIME");
    // Strip line numbers
    let s = regex_replace(&s, r"line \d+", "LINE_N");
    s
}
```

---

## Recommended Solution

**Option F (Content hash with volatile field stripping)** seems most robust:

1. **Minimal overhead**: Regex is fast, only applied to lines being compared
2. **Extensible**: Easy to add more patterns as we discover them
3. **Preserves algorithm**: The core bottom-up scanning logic stays the same
4. **Graceful fallback**: If normalization fails, return full output (safe default)

### Implementation Steps

1. Add `normalize_line()` function that strips volatile patterns
2. Modify `build_content_index()` to use normalized lines for indexing
3. Modify `count_content_matches_upward()` to compare normalized lines
4. Keep storing original lines in `CaptureState` (for accurate output)
5. Add tests for timestamp patterns

### Volatile Patterns to Handle

| Pattern | Example | Replacement |
|---------|---------|-------------|
| Relative time | `2m ago`, `5h ago` | `T_AGO` |
| Absolute time | `16:24:35` | `T_TIME` |
| Line numbers | `line 325` | `LINE_N` |
| Byte counts | `4468499 bytes` | `N_BYTES` |
| Percentage | `45%` | `N_PCT` |

---

## Testing Plan

1. Capture Claude Code TUI twice with 5-second gap
2. Verify deduplication finds overlap
3. Capture during active output (agent responding)
4. Verify new content is correctly identified

---

## Alternative: Simpler Hash-Only Approach

If the above is too complex, consider a simpler approach:

**Only use hash for "no change" detection, skip overlap detection entirely.**

```rust
fn deduplicate_capture(state: &Option<CaptureState>, output: &str, hash: u64) -> DedupResult {
    if let Some(prev) = state {
        if prev.content_hash == hash {
            return DedupResult { output: "", reason: "no_change", ... };
        }
    }
    // Always return full output if content changed
    DedupResult { output: output.to_string(), reason: "changed", ... }
}
```

This is less optimal for token usage but much simpler and never returns wrong results.

**Trade-off**: More tokens sent, but 100% accuracy.

---

## Decision

**Implemented: Simple hash-only approach**

We chose the simple solution because:
1. The overlap detection was failing due to volatile TUI content
2. Hash-only is 100% accurate (no false positives/negatives)
3. Simpler code, easier to maintain
4. Can add normalization later if token savings become critical

The trade-off is sending full 50-line captures when content changes, but this is acceptable for now.
