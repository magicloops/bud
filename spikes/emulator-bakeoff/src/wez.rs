//! wezterm-term adapter.
//!
//! Damage model: every `Line` carries a last-changed `SequenceNo`; the terminal
//! has a monotonically increasing `current_seqno()`. Damage query = "which
//! lines changed since seqno X" via `Screen::get_changed_stable_rows`, which is
//! non-destructive (any number of observers can each keep their own watermark).
//! There are no per-line column bounds — granularity is whole lines.

use std::sync::Arc;

use crate::report::{trim_trailing_empty, FeedReport, COLS, ROWS, SCROLLBACK};
use wezterm_term::color::ColorPalette;
use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize};

#[derive(Debug)]
struct BakeoffConfig;

impl TerminalConfiguration for BakeoffConfig {
    fn color_palette(&self) -> ColorPalette {
        ColorPalette::default()
    }
    fn scrollback_size(&self) -> usize {
        SCROLLBACK
    }
}

pub fn new_terminal() -> Terminal {
    Terminal::new(
        TerminalSize {
            rows: ROWS,
            cols: COLS,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 96,
        },
        Arc::new(BakeoffConfig),
        "emulator-bakeoff",
        "0.1.0",
        // Responses to queries (DA/DSR/...) are discarded.
        Box::new(std::io::sink()),
    )
}

fn grid_text(term: &Terminal) -> Vec<String> {
    let screen = term.screen();
    let phys = screen.phys_range(&(0..screen.physical_rows as i64));
    screen
        .lines_in_phys_range(phys)
        .iter()
        .map(|l| l.as_str().trim_end().to_string())
        .collect()
}

/// Which visible rows changed since `since_seqno`? Non-destructive.
fn changed_visible_rows(term: &Terminal, since_seqno: usize) -> Vec<isize> {
    let screen = term.screen();
    let start = screen.visible_row_to_stable_row(0);
    let end = screen.visible_row_to_stable_row(screen.physical_rows as i64 - 1) + 1;
    screen.get_changed_stable_rows(start..end, since_seqno)
}

pub fn run_fixture(data: &[u8]) -> FeedReport {
    let mut term = new_terminal();
    let mut damage_log = Vec::new();
    let mut quiet_chunks = 0usize;
    let mut watermark = term.current_seqno();

    for (i, chunk) in crate::report::chunks(data).enumerate() {
        term.advance_bytes(chunk);
        let changed = changed_visible_rows(&term, watermark);
        watermark = term.current_seqno();
        if changed.is_empty() {
            quiet_chunks += 1;
            damage_log.push(format!("chunk {i:>4}: quiet (no visible line changed)"));
        } else {
            damage_log.push(format!(
                "chunk {i:>4}: {} visible lines changed (stable rows {:?}{})",
                changed.len(),
                &changed[..changed.len().min(8)],
                if changed.len() > 8 { ", ..." } else { "" }
            ));
        }
    }

    let mut extra = Vec::new();
    // Semantic zones: wezterm-term's native OSC 133 integration.
    match term.get_semantic_zones() {
        Ok(zones) => {
            extra.push(format!(
                "semantic zones (native OSC 133 support): {} zones",
                zones.len()
            ));
            for z in &zones {
                extra.push(format!(
                    "  zone {:?} rows {}..{} cols {}..{}",
                    z.semantic_type, z.start_y, z.end_y, z.start_x, z.end_x
                ));
            }
        }
        Err(e) => extra.push(format!("get_semantic_zones failed: {e}")),
    }

    let cursor = term.cursor_pos();
    let screen = term.screen();
    let scrollback_lines = screen.scrollback_rows().saturating_sub(screen.physical_rows);

    FeedReport {
        grid: trim_trailing_empty(grid_text(&term)),
        cursor: (cursor.y as usize, cursor.x),
        alt_screen: term.is_alt_screen_active(),
        scrollback_lines,
        damage_log,
        quiet_chunks,
        extra,
    }
}

/// Micro-probe of the damage API for the DamageQuiet use case: seed a screen,
/// then apply tiny inputs and report what the damage query says after each.
pub fn damage_probe() -> Vec<String> {
    let mut term = new_terminal();
    term.advance_bytes(b"hello\r\nworld\r\n$ ");
    let mut watermark = term.current_seqno();
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
            term.advance_bytes(bytes);
        }
        let changed = changed_visible_rows(&term, watermark);
        let cursor = term.cursor_pos();
        out.push(format!(
            "{label}: changed lines {:?}; quiet={}; cursor seqno {} vs watermark {} (cursor moves visible via seqno)",
            changed,
            changed.is_empty(),
            cursor.seqno,
            watermark
        ));
        watermark = term.current_seqno();
    }
    out
}

/// Throughput: feed the whole buffer in CHUNK-sized pieces, no damage queries.
pub fn throughput_secs(data: &[u8]) -> f64 {
    let mut term = new_terminal();
    let start = std::time::Instant::now();
    for chunk in crate::report::chunks(data) {
        term.advance_bytes(chunk);
    }
    start.elapsed().as_secs_f64()
}

/// OSC 133 observability via the pre-parse path: run the same bytes through
/// `wezterm_escape_parser::parser::Parser` and capture typed FinalTerm
/// semantic-prompt actions (exit codes included). This is the embedder-level
/// hook — `Terminal` itself consumes OSC 133 into semantic zones and drops
/// the CommandStatus exit code.
pub fn osc133_scan(data: &[u8]) -> Vec<String> {
    use wezterm_escape_parser::{Action, OperatingSystemCommand};
    let mut parser = wezterm_escape_parser::parser::Parser::new();
    let mut seen = Vec::new();
    parser.parse(data, |action| {
        if let Action::OperatingSystemCommand(osc) = &action {
            match osc.as_ref() {
                OperatingSystemCommand::FinalTermSemanticPrompt(p) => {
                    seen.push(format!("typed FinalTermSemanticPrompt: {p:?}"));
                }
                OperatingSystemCommand::Unspecified(parts) => {
                    let joined: Vec<String> = parts
                        .iter()
                        .map(|p| String::from_utf8_lossy(p).to_string())
                        .collect();
                    seen.push(format!("unspecified OSC: {joined:?}"));
                }
                _ => {}
            }
        }
    });
    seen
}
