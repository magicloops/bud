//! alacritty_terminal adapter.
//!
//! Damage model: `Term::damage()` returns either `TermDamage::Full` or an
//! iterator of per-line `LineDamageBounds { line, left, right }` (line plus
//! column bounds). The query is destructive-by-convention: the caller must
//! invoke `reset_damage()` afterwards, so there is exactly one damage consumer.
//! "No damage" = `Partial` iterator yields nothing.

use std::sync::{Arc, Mutex};

use crate::report::{trim_trailing_empty, FeedReport, COLS, ROWS, SCROLLBACK};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte;

#[derive(Clone, Default)]
pub struct CollectingListener {
    pub events: Arc<Mutex<Vec<String>>>,
}

impl EventListener for CollectingListener {
    fn send_event(&self, event: Event) {
        self.events.lock().unwrap().push(format!("{event:?}"));
    }
}

pub fn new_terminal() -> (Term<CollectingListener>, CollectingListener) {
    let config = Config {
        scrolling_history: SCROLLBACK,
        ..Config::default()
    };
    let listener = CollectingListener::default();
    let size = TermSize::new(COLS, ROWS);
    let term = Term::new(config, &size, listener.clone());
    (term, listener)
}

fn grid_text(term: &Term<CollectingListener>) -> Vec<String> {
    let grid = term.grid();
    let mut lines = Vec::with_capacity(ROWS);
    for l in 0..ROWS {
        let row = &grid[Line(l as i32)];
        let mut s = String::new();
        for c in 0..COLS {
            let cell = &row[Column(c)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            s.push(cell.c);
            if let Some(zw) = cell.zerowidth() {
                s.extend(zw.iter());
            }
        }
        lines.push(s.trim_end().to_string());
    }
    lines
}

pub fn run_fixture(data: &[u8]) -> FeedReport {
    let (mut term, listener) = new_terminal();
    let mut processor: vte::ansi::Processor = vte::ansi::Processor::new();
    let mut damage_log = Vec::new();
    let mut quiet_chunks = 0usize;

    for (i, chunk) in crate::report::chunks(data).enumerate() {
        processor.advance(&mut term, chunk);
        let entry = match term.damage() {
            TermDamage::Full => "full damage (entire viewport)".to_string(),
            TermDamage::Partial(iter) => {
                let bounds: Vec<String> = iter
                    .map(|b| format!("line {} cols {}..{}", b.line, b.left, b.right))
                    .collect();
                if bounds.is_empty() {
                    quiet_chunks += 1;
                    "quiet (no damaged lines)".to_string()
                } else {
                    format!(
                        "{} damaged lines [{}{}]",
                        bounds.len(),
                        bounds[..bounds.len().min(6)].join("; "),
                        if bounds.len() > 6 { "; ..." } else { "" }
                    )
                }
            }
        };
        term.reset_damage();
        damage_log.push(format!("chunk {i:>4}: {entry}"));
    }

    let cursor = term.grid().cursor.point;
    let alt_screen = term.mode().contains(TermMode::ALT_SCREEN);
    let scrollback_lines = term.grid().history_size();
    let events = listener.events.lock().unwrap().clone();

    let mut extra = Vec::new();
    extra.push(format!("EventListener events ({}):", events.len()));
    for e in events.iter().take(20) {
        extra.push(format!("  {e}"));
    }
    if events.len() > 20 {
        extra.push(format!("  ... {} more", events.len() - 20));
    }

    FeedReport {
        grid: trim_trailing_empty(grid_text(&term)),
        cursor: (cursor.line.0 as usize, cursor.column.0),
        alt_screen,
        scrollback_lines,
        damage_log,
        quiet_chunks,
        extra,
    }
}

/// Micro-probe of the damage API for the DamageQuiet use case: seed a screen,
/// then apply tiny inputs and report what the damage query says after each.
pub fn damage_probe() -> Vec<String> {
    let (mut term, _listener) = new_terminal();
    let mut processor: vte::ansi::Processor = vte::ansi::Processor::new();
    processor.advance(&mut term, b"hello\r\nworld\r\n$ ");
    let _ = term.damage();
    term.reset_damage();
    let mut out = Vec::new();
    let probes: &[(&str, &[u8])] = &[
        ("no input at all", b""),
        ("print 'abc' at cursor", b"abc"),
        ("cursor move only (ESC[5;5H)", b"\x1b[5;5H"),
        ("SGR only (ESC[31m)", b"\x1b[31m"),
        ("no input again", b""),
    ];
    for (label, bytes) in probes {
        if !bytes.is_empty() {
            processor.advance(&mut term, bytes);
        }
        let entry = match term.damage() {
            TermDamage::Full => "FULL".to_string(),
            TermDamage::Partial(iter) => {
                let bounds: Vec<String> = iter
                    .map(|b| format!("line {} cols {}..{}", b.line, b.left, b.right))
                    .collect();
                if bounds.is_empty() {
                    "quiet".to_string()
                } else {
                    format!("damaged: [{}]", bounds.join("; "))
                }
            }
        };
        term.reset_damage();
        out.push(format!("{label}: {entry}"));
    }
    out
}

/// Throughput: feed the whole buffer in CHUNK-sized pieces, no damage queries.
pub fn throughput_secs(data: &[u8]) -> f64 {
    let (mut term, _listener) = new_terminal();
    let mut processor: vte::ansi::Processor = vte::ansi::Processor::new();
    let start = std::time::Instant::now();
    for chunk in crate::report::chunks(data) {
        processor.advance(&mut term, chunk);
    }
    start.elapsed().as_secs_f64()
}

/// OSC 133 observability: the `Term` path has NO hook — vte's
/// `ansi::Processor` drops unrecognized OSC (incl. 133) with a debug! log.
/// The only embedder option is a second, separate low-level `vte::Parser`
/// with a custom `Perform`, i.e. parsing the byte stream twice.
struct Osc133Capture {
    seen: Vec<String>,
}

impl vte::Perform for Osc133Capture {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.first().map(|p| *p == b"133").unwrap_or(false) {
            let parts: Vec<String> = params
                .iter()
                .skip(1)
                .map(|p| String::from_utf8_lossy(p).to_string())
                .collect();
            self.seen
                .push(format!("raw OSC 133 params: {:?}", parts.join(";")));
        }
    }
}

pub fn osc133_scan(data: &[u8]) -> Vec<String> {
    let mut parser = vte::Parser::new();
    let mut capture = Osc133Capture { seen: Vec::new() };
    parser.advance(&mut capture, data);
    capture.seen
}
