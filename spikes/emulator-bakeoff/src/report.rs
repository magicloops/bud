//! Common report shape produced by each emulator adapter.

pub const COLS: usize = 80;
pub const ROWS: usize = 24;
pub const CHUNK: usize = 4096;
pub const SCROLLBACK: usize = 10_000;

pub struct FeedReport {
    /// Visible grid as text, one string per row, trailing whitespace trimmed.
    pub grid: Vec<String>,
    /// Cursor position (row, col), 0-based, viewport-relative.
    pub cursor: (usize, usize),
    /// Whether the alternate screen is active after the full feed.
    pub alt_screen: bool,
    /// Number of scrollback lines available (excluding the visible rows).
    pub scrollback_lines: usize,
    /// One human-readable damage summary per fed chunk.
    pub damage_log: Vec<String>,
    /// Chunks after which the damage query reported no change.
    pub quiet_chunks: usize,
    /// Emulator-specific observations (semantic zones, listener events, ...).
    pub extra: Vec<String>,
}

/// Trim trailing empty lines for compact display.
pub fn trim_trailing_empty(mut lines: Vec<String>) -> Vec<String> {
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines
}

pub fn chunks(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    data.chunks(CHUNK)
}
