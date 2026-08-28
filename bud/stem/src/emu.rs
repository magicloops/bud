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
use alacritty_terminal::vte::ansi::{
    Color as AnsiColor, CursorShape as AnsiCursorShape, CursorStyle as AnsiCursorStyle, NamedColor,
};

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorPos {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

/// Cell color, alacritty-independent (grid-sync plan §2). Named ANSI colors
/// collapse into palette indices 0–15; defaults are represented by `None` on
/// the run, never as a color value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellColor {
    /// 256-color palette index (0–15 = the classic named colors).
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Attribute bitfield values for [`StyledRun::attrs`] (grid-sync plan §2).
pub mod cell_attrs {
    pub const BOLD: u8 = 1;
    pub const DIM: u8 = 2;
    pub const ITALIC: u8 = 4;
    pub const UNDERLINE: u8 = 8;
    pub const INVERSE: u8 = 16;
    pub const STRIKEOUT: u8 = 32;
}

/// A maximal run of consecutive cells sharing one presentation — the unit of
/// the grid-sync wire encoding. Wide chars appear once (spacer cells are
/// skipped); zero-width combiners stay attached to their base char.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledRun {
    pub text: String,
    pub fg: Option<CellColor>,
    pub bg: Option<CellColor>,
    /// Bitfield per [`cell_attrs`].
    pub attrs: u8,
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
    /// Lines pushed into primary-screen scrollback history by this feed —
    /// exact even when alacritty's history is saturated at its cap (where
    /// `history_size()` deltas read 0 while the grid still rotates): the top
    /// viewport row's identity (cell-buffer address + content hash) is
    /// tracked across the feed, and its displacement into history is the
    /// rotation count.
    pub scrolled_lines: usize,
    /// Scroll accounting lost track this feed (identity not found after a
    /// saturated rotation — e.g. a single feed scrolled beyond the whole
    /// history cap). `scrolled_lines` is then a lower bound; consumers
    /// maintaining scrollback continuity should record a gap.
    pub scroll_history_lost: bool,
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
    scrollback_cap: usize,
    /// Primary-screen history size at the end of the last feed (frozen while
    /// the alt screen is active — the alt grid has no history).
    primary_hist_watermark: usize,
    /// Identity (cell-buffer address, see [`Self::row_addr`]) of the primary
    /// screen's top viewport row at the end of the last feed.
    primary_top_id: Option<usize>,
    /// A resize happened while the alt screen was active: primary history was
    /// reflowed while unmeasurable; the next primary feed reports
    /// `scroll_history_lost` and re-anchors.
    pending_scroll_loss: bool,
    /// The attachment's replay ended inside the alt screen, so the primary
    /// history built during replay could not be anchored (`history_size()`
    /// reads the ALT grid, which has none). The first primary feed anchors
    /// with `scrolled_lines = 0` and no loss: everything up to that point is
    /// pre-attachment history, covered by consumers' snapshots — counting it
    /// as freshly scrolled shipped the entire replayed history as
    /// `scrollback_push` (mobile cumulative-scrollback report, restart-
    /// mid-TUI shape).
    anchor_pending_alt_exit: bool,
}

/// Forensic snapshot of primary-scroll anchor state (grid-duplication
/// triage; surfaced through `Session::grid_debug`).
#[derive(Debug, Clone, Copy)]
pub struct ScrollDebug {
    pub history_size: usize,
    pub watermark: usize,
    pub top_id_set: bool,
    pub pending_scroll_loss: bool,
    pub anchor_pending_alt_exit: bool,
    pub alt_screen: bool,
}

enum RowLocation {
    Viewport,
    History(usize),
    Gone,
}

impl Emu {
    pub fn new(cols: u16, rows: u16, scrollback_lines: usize) -> Result<Self> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let config = Config {
            scrolling_history: scrollback_lines,
            // Real-terminal default: a BLINKING block (alacritty's own config
            // default is steady, which is an app preference, not the wire
            // convention). Apps that set DECSCUSR steady variants still
            // report blinking:false; DECSCUSR 0 resets back to this.
            default_cursor_style: AnsiCursorStyle {
                shape: AnsiCursorShape::Block,
                blinking: true,
            },
            ..Config::default()
        };
        let size = TermSize::new(cols as usize, rows as usize);
        let term = Term::new(config, &size, EventProxy);
        Ok(Self {
            term,
            processor: Processor::new(),
            cols,
            rows,
            scrollback_cap: scrollback_lines,
            primary_hist_watermark: 0,
            primary_top_id: None,
            pending_scroll_loss: false,
            anchor_pending_alt_exit: false,
        })
    }

    /// Advance the terminal state machine over raw bytes.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedReport {
        let alt_before = self.term.mode().contains(TermMode::ALT_SCREEN);
        let cursor_before = self.term.grid().cursor.point;
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

        // Scroll accounting: exact primary-history push count. `history_size`
        // deltas alone undercount to 0 once history saturates at its cap (the
        // grid keeps rotating; only the size stops growing), so at saturation
        // the previous top row is located by identity to measure the true
        // rotation. Frozen while the alt screen is active — the alt grid has
        // no history, and the primary grid is untouched underneath it, so an
        // alt period simply defers measurement to the exit feed.
        let mut scrolled_lines = 0usize;
        let mut scroll_history_lost = false;
        if !alt_after {
            let hist_after = self.term.grid().history_size();
            if self.anchor_pending_alt_exit {
                // First primary feed after an attach whose replay ended in
                // the alt screen: anchor WITHOUT counting — the history that
                // exists now predates the attachment (snapshot-covered).
                self.anchor_pending_alt_exit = false;
                self.pending_scroll_loss = false;
            } else if self.pending_scroll_loss {
                // A resize under the alt screen reflowed primary history while
                // the watermark was unreadable; continuity is gone.
                self.pending_scroll_loss = false;
                scroll_history_lost = true;
            } else {
                scrolled_lines = hist_after.saturating_sub(self.primary_hist_watermark);
                if self.scrollback_cap > 0 && hist_after == self.scrollback_cap {
                    if let Some(addr) = self.primary_top_id {
                        match self.locate_row(addr, hist_after) {
                            RowLocation::History(k) => scrolled_lines = k,
                            RowLocation::Viewport => {}
                            RowLocation::Gone => scroll_history_lost = true,
                        }
                    }
                }
            }
            self.primary_hist_watermark = hist_after;
            self.primary_top_id = Some(self.row_addr(Line(0)));
        }

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
            scrolled_lines,
            scroll_history_lost,
        }
    }

    /// Address of viewport/history row `line`'s cell buffer — a stable row
    /// identity: Storage rotations and `Vec<Row>` reallocations move `Row`
    /// structs, not their heap cell allocations, and rows are never freed
    /// outside resize (which explicitly re-anchors tracking).
    fn row_addr(&self, line: Line) -> usize {
        &self.term.grid()[line][Column(0)] as *const Cell as usize
    }

    /// FNV-1a over a viewport row's visible cell state (char + colors +
    /// style flags). Paired with [`Self::row_addr`] it identifies "this exact
    /// row content moved" for scroll-shift detection: address equality alone
    /// cannot distinguish a moved row from one rewritten in place.
    fn row_content_hash(&self, line: Line) -> u64 {
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = FNV_OFFSET;
        let mut mix = |value: u64| {
            hash ^= value;
            hash = hash.wrapping_mul(FNV_PRIME);
        };
        let row = &self.term.grid()[line];
        for col in 0..self.cols as usize {
            let cell = &row[Column(col)];
            mix(cell.c as u64);
            mix(color_hash(cell.fg));
            mix(color_hash(cell.bg));
            mix(cell.flags.bits() as u64);
        }
        hash
    }

    /// (address, content hash) identity per viewport row — the substrate for
    /// take-time scroll-shift detection (grid-sync `row_shift`).
    pub(crate) fn viewport_row_ids(&self) -> Vec<(usize, u64)> {
        (0..self.rows as i32)
            .map(|line| (self.row_addr(Line(line)), self.row_content_hash(Line(line))))
            .collect()
    }

    fn locate_row(&self, addr: usize, history: usize) -> RowLocation {
        for r in 0..self.rows as i32 {
            if self.row_addr(Line(r)) == addr {
                return RowLocation::Viewport;
            }
        }
        for k in 1..=history {
            if self.row_addr(Line(-(k as i32))) == addr {
                return RowLocation::History(k);
            }
        }
        RowLocation::Gone
    }

    /// Visible screen as text lines (trailing whitespace trimmed per line).
    pub fn screen_lines(&self) -> Vec<String> {
        (0..self.rows as i32)
            .map(|l| self.row_text(Line(l)))
            .collect()
    }

    /// Visible screen serialized as ANSI: SGR color/attribute runs per cell
    /// plus a final cursor-position sequence, so a fresh terminal that writes
    /// this string reproduces the grid faithfully (colors, styles, cursor).
    /// Rows are separated by CRLF; trailing default-styled blank cells are
    /// trimmed per row. Used by the client snapshot bootstrap — plain
    /// `screen_lines` loses presentation, which is glaring when reloading
    /// into a colorful TUI.
    pub fn screen_ansi(&self) -> String {
        let mut out = String::with_capacity((self.cols as usize + 8) * self.rows as usize);
        // Emitted-style state persists across rows; escape sequences are
        // emitted only when a run's presentation differs from it.
        let mut current: Option<(Option<CellColor>, Option<CellColor>, u8)> = None;
        for line in 0..self.rows as i32 {
            if line > 0 {
                out.push_str("\r\n");
            }
            for run in self.line_runs(Line(line)) {
                let style = (run.fg, run.bg, run.attrs);
                if current != Some(style) {
                    push_sgr(&mut out, run.fg, run.bg, run.attrs);
                    current = Some(style);
                }
                out.push_str(&run.text);
            }
        }
        out.push_str("\x1b[0m");
        let cursor = self.cursor();
        out.push_str(&format!("\x1b[{};{}H", cursor.row + 1, cursor.col + 1));
        out
    }

    /// Viewport row `row` as styled runs (grid-sync plan §2). Out-of-range
    /// rows yield no runs.
    pub fn row_runs(&self, row: u16) -> Vec<StyledRun> {
        if row >= self.rows {
            return Vec::new();
        }
        self.line_runs(Line(row as i32))
    }

    /// The `n` most recently scrolled-off history lines, oldest first, as
    /// styled runs (scrollback capture for grid sync).
    pub fn recent_history_runs(&self, n: usize) -> Vec<Vec<StyledRun>> {
        let take = n.min(self.term.grid().history_size());
        (1..=take)
            .rev()
            .map(|i| self.line_runs(Line(-(i as i32))))
            .collect()
    }

    /// One grid row as maximal same-presentation runs: wide-char spacers
    /// skipped, zero-width combiners kept, trailing default-styled blanks
    /// trimmed — the single source of truth `screen_ansi` also serializes
    /// from (drift between the two is impossible by construction).
    fn line_runs(&self, line: Line) -> Vec<StyledRun> {
        let row = &self.term.grid()[line];
        // Trim trailing cells that are blank AND default-styled. A '\t' cell
        // counts as blank: alacritty stores the tab CHARACTER in the cell the
        // tab started at (put_tab), but it occupies exactly one cell — see
        // display_char below.
        let mut last = 0usize;
        for col in 0..self.cols as usize {
            let cell = &row[Column(col)];
            if !matches!(cell.c, ' ' | '\t')
                || !cell_is_default_style(cell)
                || cell.zerowidth().is_some()
            {
                last = col + 1;
            }
        }
        let mut runs: Vec<StyledRun> = Vec::new();
        for col in 0..last {
            let cell = &row[Column(col)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let ch = display_char(cell.c);
            let fg = convert_color(cell.fg);
            let bg = convert_color(cell.bg);
            let attrs = attr_bits(cell.flags);
            match runs.last_mut() {
                Some(run) if run.fg == fg && run.bg == bg && run.attrs == attrs => {
                    run.text.push(ch);
                    if let Some(zerowidth) = cell.zerowidth() {
                        run.text.extend(zerowidth.iter());
                    }
                }
                _ => {
                    let mut text = String::new();
                    text.push(ch);
                    if let Some(zerowidth) = cell.zerowidth() {
                        text.extend(zerowidth.iter());
                    }
                    runs.push(StyledRun {
                        text,
                        fg,
                        bg,
                        attrs,
                    });
                }
            }
        }
        runs
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

    /// DECSCUSR cursor style: (shape, blinking). Hidden is expressed via
    /// [`CursorPos::visible`], not a shape.
    pub fn cursor_shape(&self) -> (CursorShapeKind, bool) {
        let style = self.term.cursor_style();
        let shape = match style.shape {
            AnsiCursorShape::Underline => CursorShapeKind::Underline,
            AnsiCursorShape::Beam => CursorShapeKind::Beam,
            _ => CursorShapeKind::Block,
        };
        (shape, style.blinking)
    }

    /// Reset DECSCUSR back to the terminal default. Used at prompt return:
    /// full-screen apps (nvim) leave an explicit steady style behind on exit
    /// and never reset it; prompt-level styling (zsh vi-mode widgets) is
    /// emitted AFTER the prompt marker and lands on top of this unharmed.
    pub fn reset_cursor_style(&mut self) {
        use alacritty_terminal::vte::ansi::Handler as _;
        self.term.set_cursor_style(None);
    }

    pub fn alt_screen_active(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Mouse-reporting modes the application enabled via DECSET (grid-sync
    /// mouse support: clients encode mouse events only when the app asked).
    pub fn mouse_modes(&self) -> MouseModes {
        let mode = self.term.mode();
        let report = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseReport::Motion
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseReport::Drag
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseReport::Click
        } else {
            MouseReport::None
        };
        MouseModes {
            report,
            sgr: mode.contains(TermMode::SGR_MOUSE),
            alt_scroll: mode.contains(TermMode::ALTERNATE_SCROLL),
        }
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

    /// Re-anchor scroll accounting to the CURRENT state without counting
    /// anything as scrolled. Called after an attach's ring replay: replayed
    /// history predates the attachment and is covered by consumers'
    /// snapshots. While the alt screen is active the primary grid is
    /// unreadable, so the anchor is deferred to the first primary feed
    /// (`anchor_pending_alt_exit`).
    pub fn sync_scroll_anchor(&mut self) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            self.anchor_pending_alt_exit = true;
        } else {
            self.anchor_pending_alt_exit = false;
            self.primary_hist_watermark = self.term.grid().history_size();
            self.primary_top_id = Some(self.row_addr(Line(0)));
        }
    }

    /// See [`ScrollDebug`].
    pub fn scroll_debug(&self) -> ScrollDebug {
        ScrollDebug {
            history_size: self.term.grid().history_size(),
            watermark: self.primary_hist_watermark,
            top_id_set: self.primary_top_id.is_some(),
            pending_scroll_loss: self.pending_scroll_loss,
            anchor_pending_alt_exit: self.anchor_pending_alt_exit,
            alt_screen: self.term.mode().contains(TermMode::ALT_SCREEN),
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
        // Reflow rewrites history and reallocates rows: re-anchor scroll
        // tracking. Under the alt screen the primary grid is unreadable, so
        // mark the continuity loss for the next primary feed instead.
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            self.primary_top_id = None;
            self.pending_scroll_loss = true;
        } else {
            self.primary_hist_watermark = self.term.grid().history_size();
            self.primary_top_id = Some(self.row_addr(Line(0)));
        }
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
            s.push(display_char(cell.c));
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

/// Grid cell char → what a renderer should draw for it. A cell holding
/// '\t' is the single cell a tab STARTED at (alacritty's put_tab stores the
/// character for copy fidelity but advances the cursor past it); rendering
/// the raw '\t' through CSS/text pipelines re-expands it at arbitrary tab
/// stops and shreds column alignment (found live: BSD `ls` pads columns
/// with tabs).
fn display_char(c: char) -> char {
    if c == '\t' {
        ' '
    } else {
        c
    }
}

/// Stable numeric encoding of a cell color for row content hashing.
fn color_hash(color: AnsiColor) -> u64 {
    match color {
        AnsiColor::Named(named) => 0x0100 + named as u64,
        AnsiColor::Indexed(index) => 0x0200 + index as u64,
        AnsiColor::Spec(rgb) => {
            0x0100_0000 + ((rgb.r as u64) << 16) + ((rgb.g as u64) << 8) + rgb.b as u64
        }
    }
}

/// DECSCUSR cursor shape (vim's insert-mode beam, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CursorShapeKind {
    #[default]
    Block,
    Underline,
    Beam,
}

/// Highest mouse-reporting level enabled: DECSET 1000 (clicks) < 1002
/// (clicks + drag motion) < 1003 (all motion).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseReport {
    #[default]
    None,
    Click,
    Drag,
    Motion,
}

/// Application-enabled mouse modes (DECSET), for grid-sync clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MouseModes {
    pub report: MouseReport,
    /// SGR extended coordinate encoding (DECSET 1006).
    pub sgr: bool,
    /// Alternate-scroll (DECSET 1007): wheel → arrow keys in the alt screen.
    pub alt_scroll: bool,
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

fn cell_is_default_style(cell: &Cell) -> bool {
    matches!(cell.fg, AnsiColor::Named(NamedColor::Foreground))
        && matches!(cell.bg, AnsiColor::Named(NamedColor::Background))
        && !cell.flags.intersects(
            Flags::BOLD
                | Flags::DIM
                | Flags::ITALIC
                | Flags::UNDERLINE
                | Flags::INVERSE
                | Flags::STRIKEOUT,
        )
}

/// alacritty color → stem [`CellColor`]. Named ANSI colors collapse into
/// palette indices 0–15; Foreground/Background defaults (and render-time
/// named variants apps cannot set via SGR) map to `None` = default.
fn convert_color(color: AnsiColor) -> Option<CellColor> {
    match color {
        AnsiColor::Named(named) => {
            let code: Option<u8> = match named {
                NamedColor::Black => Some(0),
                NamedColor::Red => Some(1),
                NamedColor::Green => Some(2),
                NamedColor::Yellow => Some(3),
                NamedColor::Blue => Some(4),
                NamedColor::Magenta => Some(5),
                NamedColor::Cyan => Some(6),
                NamedColor::White => Some(7),
                NamedColor::BrightBlack => Some(8),
                NamedColor::BrightRed => Some(9),
                NamedColor::BrightGreen => Some(10),
                NamedColor::BrightYellow => Some(11),
                NamedColor::BrightBlue => Some(12),
                NamedColor::BrightMagenta => Some(13),
                NamedColor::BrightCyan => Some(14),
                NamedColor::BrightWhite => Some(15),
                _ => None,
            };
            code.map(CellColor::Indexed)
        }
        AnsiColor::Indexed(index) => Some(CellColor::Indexed(index)),
        AnsiColor::Spec(rgb) => Some(CellColor::Rgb(rgb.r, rgb.g, rgb.b)),
    }
}

fn attr_bits(flags: Flags) -> u8 {
    let mut attrs = 0u8;
    if flags.contains(Flags::BOLD) {
        attrs |= cell_attrs::BOLD;
    }
    if flags.contains(Flags::DIM) {
        attrs |= cell_attrs::DIM;
    }
    if flags.contains(Flags::ITALIC) {
        attrs |= cell_attrs::ITALIC;
    }
    if flags.contains(Flags::UNDERLINE) {
        attrs |= cell_attrs::UNDERLINE;
    }
    if flags.contains(Flags::INVERSE) {
        attrs |= cell_attrs::INVERSE;
    }
    if flags.contains(Flags::STRIKEOUT) {
        attrs |= cell_attrs::STRIKEOUT;
    }
    attrs
}

/// Emit the full SGR state for a run: reset then re-emit — simple and always
/// correct (attr removal has no single-code equivalent for every combo).
fn push_sgr(out: &mut String, fg: Option<CellColor>, bg: Option<CellColor>, attrs: u8) {
    out.push_str("\x1b[0m");
    if attrs & cell_attrs::BOLD != 0 {
        out.push_str("\x1b[1m");
    }
    if attrs & cell_attrs::DIM != 0 {
        out.push_str("\x1b[2m");
    }
    if attrs & cell_attrs::ITALIC != 0 {
        out.push_str("\x1b[3m");
    }
    if attrs & cell_attrs::UNDERLINE != 0 {
        out.push_str("\x1b[4m");
    }
    if attrs & cell_attrs::INVERSE != 0 {
        out.push_str("\x1b[7m");
    }
    if attrs & cell_attrs::STRIKEOUT != 0 {
        out.push_str("\x1b[9m");
    }
    if let Some(fg) = fg {
        push_color(out, fg, true);
    }
    if let Some(bg) = bg {
        push_color(out, bg, false);
    }
}

fn push_color(out: &mut String, color: CellColor, foreground: bool) {
    match color {
        CellColor::Indexed(code) if code < 16 => {
            let base = if code < 8 {
                if foreground {
                    30 + code
                } else {
                    40 + code
                }
            } else if foreground {
                90 + (code - 8)
            } else {
                100 + (code - 8)
            };
            out.push_str(&format!("\x1b[{base}m"));
        }
        CellColor::Indexed(index) => {
            let sel = if foreground { 38 } else { 48 };
            out.push_str(&format!("\x1b[{sel};5;{index}m"));
        }
        CellColor::Rgb(r, g, b) => {
            let sel = if foreground { 38 } else { 48 };
            out.push_str(&format!("\x1b[{sel};2;{r};{g};{b}m"));
        }
    }
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
    #[test]
    fn row_runs_group_by_presentation() {
        let mut emu = Emu::new(40, 4, 100).unwrap();
        emu.feed(b"\x1b[31mred\x1b[0m plain \x1b[1;38;5;42mfancy\x1b[0m");
        let runs = emu.row_runs(0);
        assert_eq!(
            runs,
            vec![
                StyledRun {
                    text: "red".into(),
                    fg: Some(CellColor::Indexed(1)),
                    bg: None,
                    attrs: 0,
                },
                StyledRun {
                    text: " plain ".into(),
                    fg: None,
                    bg: None,
                    attrs: 0,
                },
                StyledRun {
                    text: "fancy".into(),
                    fg: Some(CellColor::Indexed(42)),
                    bg: None,
                    attrs: cell_attrs::BOLD,
                },
            ]
        );
        // Untouched rows and out-of-range rows are empty.
        assert!(emu.row_runs(1).is_empty());
        assert!(emu.row_runs(99).is_empty());
    }

    #[test]
    fn row_runs_keep_styled_trailing_blanks_and_wide_chars() {
        let mut emu = Emu::new(40, 4, 100).unwrap();
        // bg-colored trailing spaces are content; default trailing blanks are not.
        emu.feed("A\x1b[44m  \x1b[0m   \r\n日本\x1b[0m".as_bytes());
        let runs = emu.row_runs(0);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].text, "A");
        assert_eq!(runs[1].text, "  ");
        assert_eq!(runs[1].bg, Some(CellColor::Indexed(4)));
        // Wide chars appear once (spacer cells skipped).
        assert_eq!(emu.row_runs(1)[0].text, "日本");
    }

    #[test]
    fn row_runs_and_screen_ansi_agree() {
        // screen_ansi is serialized FROM line_runs; feeding it to a fresh emu
        // must reproduce identical runs (the no-drift contract).
        let mut a = Emu::new(30, 5, 100).unwrap();
        a.feed(b"\x1b[31;44mred-on-blue\x1b[0m mid \x1b[7;9minv\x1b[0m\r\n\x1b[38;2;1;2;3mrgb");
        let mut b = Emu::new(30, 5, 100).unwrap();
        b.feed(a.screen_ansi().as_bytes());
        for row in 0..5 {
            assert_eq!(a.row_runs(row), b.row_runs(row), "row {row}");
        }
    }

    #[test]
    fn tab_cells_render_as_single_blank_cells() {
        // BSD ls pads columns with tabs; alacritty stores '\t' in the cell
        // the tab started at. Text extraction must never leak raw tabs (CSS
        // and copy pipelines re-expand them at arbitrary stops).
        let mut emu = Emu::new(40, 4, 100).unwrap();
        emu.feed(b"A\tB\tC");
        let line = emu.screen_lines()[0].clone();
        assert!(!line.contains('\t'), "screen_lines leaked a tab: {line:?}");
        assert_eq!(line, format!("A{}B{}C", " ".repeat(7), " ".repeat(7)));
        let runs = emu.row_runs(0);
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert!(!text.contains('\t'), "row_runs leaked a tab: {text:?}");
        assert_eq!(text, line);
        assert!(!emu.screen_ansi().contains('\t'));
    }

    #[test]
    fn recent_history_runs_are_oldest_first() {
        let mut emu = Emu::new(80, 3, 100).unwrap();
        emu.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let texts: Vec<String> = emu
            .recent_history_runs(2)
            .into_iter()
            .map(|runs| runs.into_iter().map(|r| r.text).collect())
            .collect();
        assert_eq!(texts, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn scrolled_lines_stay_exact_at_history_saturation() {
        // History cap 4: once saturated, history_size() deltas read 0 while
        // the grid still rotates — the row-identity tracker must keep the
        // count exact (grid-sync scrollback capture depends on it).
        let mut emu = Emu::new(80, 3, 4).unwrap();
        let report = emu.feed(b"a\r\nb\r\nc\r\nd\r\ne");
        assert_eq!(report.scrolled_lines, 2); // a, b pushed
        assert!(!report.scroll_history_lost);

        let report = emu.feed(b"\r\nf\r\ng"); // c, d pushed → history full (4)
        assert_eq!(report.scrolled_lines, 2);

        // Saturated: every further scroll must still report exactly.
        let report = emu.feed(b"\r\nh");
        assert_eq!(report.scrolled_lines, 1, "saturated single scroll");
        assert!(!report.scroll_history_lost);
        let report = emu.feed(b"\r\ni\r\nj\r\nk");
        assert_eq!(report.scrolled_lines, 3, "saturated multi scroll");
        assert!(!report.scroll_history_lost);

        // Scrolling past the entire retained history in one feed loses the
        // anchor row — reported honestly instead of guessed.
        let report = emu.feed(b"\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8");
        assert!(report.scroll_history_lost);
    }

    #[test]
    fn alt_screen_defers_scroll_accounting_to_exit() {
        let mut emu = Emu::new(80, 3, 100).unwrap();
        emu.feed(b"one\r\ntwo\r\nthree");
        // Enter alt, scroll wildly inside it: no primary history pushes.
        let report = emu.feed(b"\x1b[?1049h1\r\n2\r\n3\r\n4\r\n5");
        assert_eq!(report.scrolled_lines, 0);
        // Exit alt and scroll in the same chunk: pushes counted on exit.
        let report = emu.feed(b"\x1b[?1049l\r\nfour\r\nfive");
        assert_eq!(report.scrolled_lines, 2);
        assert!(!report.scroll_history_lost);
        assert_eq!(emu.scrollback_lines(10), vec!["one", "two"]);
    }

    #[test]
    fn screen_ansi_roundtrips_colors_and_cursor() {
        let mut a = Emu::new(30, 5, 100).unwrap();
        a.feed(b"\x1b[31mred\x1b[0m plain \x1b[1;38;5;42mfancy\x1b[0m\r\nline2\x1b[3;7H");
        let ansi = a.screen_ansi();
        // Colors and styles survive serialization...
        assert!(ansi.contains("\x1b[31m"), "named red missing: {ansi:?}");
        assert!(
            ansi.contains("\x1b[38;5;42m"),
            "indexed color missing: {ansi:?}"
        );
        assert!(ansi.contains("\x1b[1m"), "bold missing: {ansi:?}");
        // ...and feeding it to a FRESH emulator reproduces grid + cursor.
        let mut b = Emu::new(30, 5, 100).unwrap();
        b.feed(ansi.as_bytes());
        assert_eq!(a.screen_lines(), b.screen_lines());
        let (ca, cb) = (a.cursor(), b.cursor());
        assert_eq!((ca.row, ca.col), (cb.row, cb.col));
    }
}
