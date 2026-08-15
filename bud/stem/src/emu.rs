//! VT emulator wrapper around `alacritty_terminal` (daemon-side).
//!
//! ALL alacritty API usage is confined to this module (design D5: pinned minor,
//! known churn). Includes the cursor-filtered damage logic from the bake-off:
//! alacritty's `damage()` always reports the cursor cell and goes `Full` on
//! viewport scroll — [`FeedReport::meaningful_damage`] must be `false` for
//! cursor-only updates (dedicated regression test:
//! `spikes/emulator-bakeoff/results/damage-probe.txt` documents the behavior).
//!
//! Cursor-artifact filter: after a feed, a partial damage entry is a cursor
//! artifact iff it is a single cell (`left == right`) sitting at the cursor
//! position either before or after the feed (a cursor move damages the old
//! AND the new cell; a zero-byte feed damages the current one). One case the
//! bake-off probe did not cover: when a cursor move stays on ONE line,
//! alacritty merges old+new cells into a single span (`left..right` = the
//! travel), which is indistinguishable by bounds from a print of that span —
//! for exactly that signature the filter snapshots the cursor row before the
//! feed and compares cell content (unchanged cells ⇒ artifact). Damage is
//! meaningful when it is `Full` (alacritty collapses to `Full` on any
//! viewport scroll — real content) or when any non-artifact entry remains.

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::Processor;

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorPos {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

/// What one `feed()` call changed — the inputs to DamageQuiet and delta logic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedReport {
    /// Damage beyond the cursor-cell-only artifact (see module docs).
    pub meaningful_damage: bool,
    /// Viewport rows touched (empty when a Full damage event occurred —
    /// then `full_repaint` is set instead). Cursor-artifact-only rows are
    /// excluded, consistent with `meaningful_damage`.
    pub damaged_rows: Vec<u16>,
    pub full_repaint: bool,
    /// Alt-screen state after this feed differs from before it.
    pub alt_screen_changed: bool,
    /// Lines pushed into scrollback by this feed.
    pub scrolled_lines: usize,
}

/// alacritty requires an event listener; stem derives everything it needs from
/// the grid/damage/mode queries, so events are dropped.
struct EventProxy;

impl EventListener for EventProxy {
    fn send_event(&self, _event: Event) {}
}

pub struct Emu {
    term: Term<EventProxy>,
    processor: Processor,
    cols: u16,
    rows: u16,
}

impl Emu {
    pub fn new(cols: u16, rows: u16, scrollback_lines: usize) -> Result<Self> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let config = Config {
            scrolling_history: scrollback_lines,
            ..Config::default()
        };
        let size = TermSize::new(cols as usize, rows as usize);
        let term = Term::new(config, &size, EventProxy);
        Ok(Self {
            term,
            processor: Processor::new(),
            cols,
            rows,
        })
    }

    /// Advance the terminal state machine over raw bytes.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedReport {
        let alt_before = self.term.mode().contains(TermMode::ALT_SCREEN);
        let cursor_before = self.term.grid().cursor.point;
        let history_before = self.term.grid().history_size();
        // Snapshot the cursor row for the same-line cursor-travel artifact
        // check (see module docs); one short row clone per feed.
        let cursor_row_before: Vec<Cell> = {
            let row = &self.term.grid()[cursor_before.line];
            (0..self.cols as usize)
                .map(|c| row[Column(c)].clone())
                .collect()
        };

        self.processor.advance(&mut self.term, bytes);

        let alt_after = self.term.mode().contains(TermMode::ALT_SCREEN);
        let cursor_after = self.term.grid().cursor.point;
        let history_after = self.term.grid().history_size();

        // Collect damage bounds first: the Partial iterator borrows the term,
        // and the artifact filter below needs to read the grid.
        let bounds: Option<Vec<(usize, usize, usize)>> = match self.term.damage() {
            TermDamage::Full => None,
            TermDamage::Partial(iter) => Some(iter.map(|b| (b.line, b.left, b.right)).collect()),
        };
        self.term.reset_damage();

        let mut full_repaint = false;
        let mut meaningful_damage = false;
        let mut damaged_rows = Vec::new();
        match bounds {
            None => {
                // Full damage is emitted on any viewport scroll (bake-off
                // finding); scrolled content is real content — always
                // meaningful.
                full_repaint = true;
                meaningful_damage = true;
            }
            Some(bounds) => {
                for (line, left, right) in bounds {
                    let single_cell_artifact = left == right
                        && (is_cursor_cell(line, left, cursor_before)
                            || is_cursor_cell(line, left, cursor_after));
                    // Same-line cursor move: alacritty merges old+new cursor
                    // cells into one span covering exactly the travel; it is
                    // an artifact only if the cells are untouched.
                    let travel_span_artifact = || {
                        cursor_before.line == cursor_after.line
                            && cursor_before.line.0 >= 0
                            && cursor_before.line.0 as usize == line
                            && left == cursor_before.column.0.min(cursor_after.column.0)
                            && right == cursor_before.column.0.max(cursor_after.column.0)
                            && self.span_unchanged(line, left, right, &cursor_row_before)
                    };
                    if !single_cell_artifact && !travel_span_artifact() {
                        meaningful_damage = true;
                        damaged_rows.push(line as u16);
                    }
                }
            }
        }

        FeedReport {
            meaningful_damage,
            damaged_rows,
            full_repaint,
            alt_screen_changed: alt_before != alt_after,
            scrolled_lines: history_after.saturating_sub(history_before),
        }
    }

    /// Visible screen as text lines (trailing whitespace trimmed per line).
    pub fn screen_lines(&self) -> Vec<String> {
        (0..self.rows as i32)
            .map(|l| self.row_text(Line(l)))
            .collect()
    }

    /// Up to `n` most recent scrollback lines (oldest first), text only.
    pub fn scrollback_lines(&self, n: usize) -> Vec<String> {
        let take = n.min(self.term.grid().history_size());
        // History rows live at negative Line indices: -1 is the most recent.
        (1..=take)
            .rev()
            .map(|i| self.row_text(Line(-(i as i32))))
            .collect()
    }

    pub fn cursor(&self) -> CursorPos {
        let point = self.term.grid().cursor.point;
        CursorPos {
            row: point.line.0.max(0) as u16,
            col: point.column.0 as u16,
            visible: self.term.mode().contains(TermMode::SHOW_CURSOR),
        }
    }

    pub fn alt_screen_active(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Terminal modes input encoding must honor (see [`crate::keys`]).
    pub fn key_modes(&self) -> KeyModes {
        let mode = self.term.mode();
        KeyModes {
            application_cursor: mode.contains(TermMode::APP_CURSOR),
            application_keypad: mode.contains(TermMode::APP_KEYPAD),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.term
            .resize(TermSize::new(cols as usize, rows as usize));
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    /// True when cells `left..=right` of viewport row `line` are identical to
    /// the pre-feed snapshot of that row (cursor-travel artifact check).
    fn span_unchanged(&self, line: usize, left: usize, right: usize, before: &[Cell]) -> bool {
        let row = &self.term.grid()[Line(line as i32)];
        (left..=right.min(before.len().saturating_sub(1)))
            .all(|col| row[Column(col)] == before[col])
    }

    /// One grid row as text: skip wide-char spacer cells, keep zero-width
    /// combiners, trim trailing whitespace (bake-off `grid_text` shape).
    fn row_text(&self, line: Line) -> String {
        let grid = self.term.grid();
        let row = &grid[line];
        let mut s = String::with_capacity(self.cols as usize);
        for col in 0..self.cols as usize {
            let cell = &row[Column(col)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            s.push(cell.c);
            if let Some(zerowidth) = cell.zerowidth() {
                s.extend(zerowidth.iter());
            }
        }
        s.truncate(s.trim_end().len());
        s
    }
}

fn is_cursor_cell(line: usize, col: usize, cursor: Point) -> bool {
    cursor.line.0 >= 0 && cursor.line.0 as usize == line && cursor.column.0 == col
}

/// Input-relevant terminal modes, queried from the emulator at write time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyModes {
    /// DECCKM: cursor keys send SS3 (`\x1bOA`) instead of CSI (`\x1b[A`).
    pub application_cursor: bool,
    /// DECPAM/DECPNM keypad state.
    pub application_keypad: bool,
    /// Application enabled bracketed paste (`?2004h`).
    pub bracketed_paste: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_print_and_screen_lines() {
        let mut emu = Emu::new(80, 24, 100).unwrap();
        let report = emu.feed(b"hello\r\nworld");
        assert!(report.meaningful_damage);
        assert!(!report.alt_screen_changed);
        assert_eq!(report.scrolled_lines, 0);
        let lines = emu.screen_lines();
        assert_eq!(lines.len(), 24);
        assert_eq!(lines[0], "hello");
        assert_eq!(lines[1], "world");
        assert_eq!(lines[2], "");
        let cursor = emu.cursor();
        assert_eq!((cursor.row, cursor.col), (1, 5));
        assert!(cursor.visible);
        assert_eq!(emu.size(), (80, 24));
    }

    #[test]
    fn cursor_only_damage_is_not_meaningful() {
        // The D5 regression test: mirrors the bake-off damage probe.
        let mut emu = Emu::new(80, 24, 100).unwrap();
        emu.feed(b"hello\r\nworld\r\n$ ");

        // Zero-byte feed: alacritty still damages the cursor cell.
        let report = emu.feed(b"");
        assert!(!report.meaningful_damage, "zero-byte feed: {report:?}");
        assert!(report.damaged_rows.is_empty());

        // Real content at the cursor: meaningful.
        let report = emu.feed(b"abc");
        assert!(report.meaningful_damage, "content feed: {report:?}");

        // Cursor move only: damages old + new cursor cells — both artifacts.
        let report = emu.feed(b"\x1b[5;5H");
        assert!(!report.meaningful_damage, "cursor move: {report:?}");
        assert!(report.damaged_rows.is_empty());
        assert!(!report.full_repaint);

        // SGR only: still just the cursor cell.
        let report = emu.feed(b"\x1b[31m");
        assert!(!report.meaningful_damage, "sgr only: {report:?}");
    }

    #[test]
    fn same_line_cursor_travel_is_not_meaningful_but_prints_are() {
        // alacritty merges a same-line cursor move into ONE span (old..new);
        // the bounds are identical to a print of that span, so the filter
        // must fall back to comparing cell content.
        let mut emu = Emu::new(80, 24, 100).unwrap();
        emu.feed(b"hello world");
        // Same-line move: col 11 -> col 3.
        let report = emu.feed(b"\x1b[4G");
        assert!(!report.meaningful_damage, "same-line move: {report:?}");
        assert!(report.damaged_rows.is_empty());
        // A print producing the exact same damage signature (cursor travel
        // span on one line) must stay meaningful: overwrite cols 3..7.
        let report = emu.feed(b"XYZW");
        assert!(report.meaningful_damage, "same-line print: {report:?}");
        assert_eq!(report.damaged_rows, vec![0]);
        assert_eq!(emu.screen_lines()[0], "helXYZWorld");
    }

    #[test]
    fn full_damage_on_scroll_is_meaningful() {
        let mut emu = Emu::new(80, 4, 100).unwrap();
        emu.feed(b"a\r\nb\r\nc\r\nd");
        // Next line scrolls the viewport: alacritty reports Full damage.
        let report = emu.feed(b"\r\ne\r\nf");
        assert!(report.full_repaint);
        assert!(report.meaningful_damage);
        assert!(report.damaged_rows.is_empty());
        assert_eq!(report.scrolled_lines, 2);
        assert_eq!(emu.scrollback_lines(10), vec!["a", "b"]);
        // Oldest-first, capped at n.
        assert_eq!(emu.scrollback_lines(1), vec!["b"]);
    }

    #[test]
    fn alt_screen_flag_and_change_reporting() {
        let mut emu = Emu::new(80, 24, 100).unwrap();
        assert!(!emu.alt_screen_active());
        let report = emu.feed(b"\x1b[?1049h");
        assert!(report.alt_screen_changed);
        assert!(emu.alt_screen_active());
        let report = emu.feed(b"vim!");
        assert!(!report.alt_screen_changed);
        let report = emu.feed(b"\x1b[?1049l");
        assert!(report.alt_screen_changed);
        assert!(!emu.alt_screen_active());
    }

    #[test]
    fn key_modes_track_decset() {
        let mut emu = Emu::new(80, 24, 100).unwrap();
        assert_eq!(emu.key_modes(), KeyModes::default());
        emu.feed(b"\x1b[?1h\x1b[?2004h\x1b=");
        assert_eq!(
            emu.key_modes(),
            KeyModes {
                application_cursor: true,
                application_keypad: true,
                bracketed_paste: true,
            }
        );
        emu.feed(b"\x1b[?1l\x1b[?2004l\x1b>");
        assert_eq!(emu.key_modes(), KeyModes::default());
    }

    #[test]
    fn wide_chars_and_zerowidth_render_once() {
        let mut emu = Emu::new(80, 24, 100).unwrap();
        emu.feed("日本語 e\u{0301}".as_bytes());
        assert_eq!(emu.screen_lines()[0], "日本語 e\u{0301}");
    }

    #[test]
    fn resize_updates_size_and_grid() {
        let mut emu = Emu::new(80, 24, 100).unwrap();
        emu.feed(b"before resize");
        emu.resize(100, 30);
        assert_eq!(emu.size(), (100, 30));
        assert_eq!(emu.screen_lines().len(), 30);
        assert_eq!(emu.screen_lines()[0], "before resize");
        emu.feed(b"\r\nafter");
        assert_eq!(emu.screen_lines()[1], "after");
    }
}
