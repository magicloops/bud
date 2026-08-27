//! Golden-dump generator for native-client parity testing (untracked handoff
//! tool; see reference/grid-width-parity/README.md).
//!
//! Usage: cargo run --example width_goldens -- <out_dir>
//!
//! Emits:
//!   fixture-goldens.json — each tests/fixtures/*.raw fed through the
//!     emulator at its recorded 80x24 geometry; final screen as wire-shape
//!     styled runs + cursor + scrollback tail.
//!   width-oracle.json — a curated Unicode probe set; for each probe, the
//!     server-authoritative column width (cursor advance) and the exported
//!     run text. Sum of the client's per-column widths over `exported` MUST
//!     equal `width` or the client's grid drifts from the server's.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use stem::emu::{CellColor, Emu, StyledRun};

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn color_json(c: &Option<CellColor>) -> Option<String> {
    match c {
        None => None,
        Some(CellColor::Indexed(i)) => Some(i.to_string()),
        Some(CellColor::Rgb(r, g, b)) => Some(format!("[{r},{g},{b}]")),
    }
}

fn run_json(run: &StyledRun) -> String {
    let mut s = format!("{{\"t\":\"{}\"", json_escape(&run.text));
    if let Some(fg) = color_json(&run.fg) {
        let _ = write!(s, ",\"fg\":{fg}");
    }
    if let Some(bg) = color_json(&run.bg) {
        let _ = write!(s, ",\"bg\":{bg}");
    }
    if run.attrs != 0 {
        let _ = write!(s, ",\"a\":{}", run.attrs);
    }
    s.push('}');
    s
}

fn runs_json(runs: &[StyledRun]) -> String {
    let items: Vec<String> = runs.iter().map(run_json).collect();
    format!("[{}]", items.join(","))
}

fn codepoints(s: &str) -> String {
    s.chars()
        .map(|c| format!("U+{:04X}", c as u32))
        .collect::<Vec<_>>()
        .join(" ")
}

fn fixture_goldens(fixtures_dir: &Path, out_dir: &Path) {
    let mut entries: Vec<_> = fs::read_dir(fixtures_dir)
        .expect("fixtures dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "raw").unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.file_name());

    let mut docs = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let bytes = fs::read(entry.path()).expect("fixture bytes");
        let mut emu = Emu::new(80, 24, 1000).expect("emu");
        emu.feed(&bytes);
        let cursor = emu.cursor();
        let (shape, blink) = emu.cursor_shape();
        let rows: Vec<String> = (0..24)
            .map(|r| format!("{{\"row\":{r},\"runs\":{}}}", runs_json(&emu.row_runs(r))))
            .collect();
        let scrollback = emu.scrollback_lines(1000);
        let sb_tail: Vec<String> = scrollback
            .iter()
            .rev()
            .take(30)
            .rev()
            .map(|l| format!("\"{}\"", json_escape(l)))
            .collect();
        docs.push(format!(
            "{{\"fixture\":\"{name}\",\"input_bytes\":{},\"cols\":80,\"rows\":24,\
             \"alt_screen\":{},\"cursor\":{{\"row\":{},\"col\":{},\"visible\":{},\
             \"shape\":\"{:?}\",\"blink\":{}}},\
             \"scrollback_total_captured\":{},\"scrollback_tail_text\":[{}],\
             \"screen\":[{}]}}",
            bytes.len(),
            emu.alt_screen_active(),
            cursor.row,
            cursor.col,
            cursor.visible,
            shape,
            blink,
            scrollback.len(),
            sb_tail.join(","),
            rows.join(",")
        ));
    }
    let json = format!(
        "{{\"generator\":\"stem examples/width_goldens.rs\",\
         \"emulator\":\"alacritty_terminal 0.26.0\",\"unicode_width\":\"0.2.2\",\
         \"geometry\":\"80x24, 1000-line scrollback\",\
         \"fixtures\":[\n{}\n]}}",
        docs.join(",\n")
    );
    fs::write(out_dir.join("fixture-goldens.json"), json).expect("write goldens");
}

const PROBES: &[(&str, &str, &str)] = &[
    // (category, label, probe)
    ("ascii", "plain ascii", "abc"),
    ("ascii", "space", " "),
    ("latin", "precomposed e-acute", "é"),
    ("latin", "u-umlaut", "ü"),
    ("ambiguous", "section sign", "§"),
    ("ambiguous", "plus-minus", "±"),
    ("ambiguous", "middle dot", "·"),
    ("ambiguous", "multiplication sign", "×"),
    ("ambiguous", "greek alpha", "α"),
    ("ambiguous", "greek capital omega", "Ω"),
    ("ambiguous", "cyrillic be", "б"),
    ("ambiguous", "cyrillic capital ya", "Я"),
    ("ambiguous", "box light horizontal", "─"),
    ("ambiguous", "box light vertical", "│"),
    ("ambiguous", "full block", "█"),
    ("ambiguous", "rightwards arrow", "→"),
    ("ambiguous", "black star", "★"),
    ("ambiguous", "white circle", "○"),
    ("ambiguous", "black circle", "●"),
    ("ambiguous", "horizontal ellipsis", "…"),
    ("ambiguous", "em dash", "—"),
    ("narrow", "euro sign", "€"),
    ("narrow", "fi ligature", "ﬁ"),
    ("wide", "cjk ideograph", "日"),
    ("wide", "cjk pair", "日本"),
    ("wide", "hiragana", "あ"),
    ("wide", "katakana", "ア"),
    ("wide", "hangul syllable (precomposed)", "각"),
    (
        "wide",
        "hangul jamo (decomposed)",
        "\u{1100}\u{1161}\u{11A8}",
    ),
    ("wide", "fullwidth latin A", "Ａ"),
    ("wide", "fullwidth digit one", "１"),
    ("wide", "ideographic space", "\u{3000}"),
    ("narrow", "halfwidth katakana", "ｱ"),
    ("combining", "e + combining acute", "e\u{0301}"),
    ("combining", "e + acute + cedilla", "e\u{0301}\u{0327}"),
    ("combining", "a + combining arrow above", "a\u{20D7}"),
    ("combining", "devanagari ka + vowel sign i", "क\u{093F}"),
    ("combining", "thai ko kai + mai han-akat", "ก\u{0E31}"),
    ("zero-width", "zero width space", "\u{200B}"),
    ("zero-width", "zero width joiner alone", "\u{200D}"),
    ("zero-width", "zero width non-joiner", "\u{200C}"),
    ("emoji", "slightly smiling face", "🙂"),
    ("emoji", "thumbs up", "👍"),
    ("emoji", "white smiling face (text-default)", "☺"),
    ("emoji", "white smiling face + VS16", "☺\u{FE0F}"),
    ("emoji", "heavy black heart + VS16", "❤\u{FE0F}"),
    ("emoji", "victory hand + medium skin tone", "✌🏽"),
    ("emoji", "woman technologist (ZWJ)", "👩\u{200D}💻"),
    (
        "emoji",
        "family MWGB (ZWJ x3)",
        "👨\u{200D}👩\u{200D}👧\u{200D}👦",
    ),
    ("emoji", "rainbow flag (ZWJ + VS16)", "🏳\u{FE0F}\u{200D}🌈"),
    ("emoji", "US flag (regional indicators)", "🇺🇸"),
    ("emoji", "keycap number sign", "#\u{FE0F}\u{20E3}"),
    ("mixed", "cjk + ascii + emoji", "日a🙂b"),
];

fn width_oracle(out_dir: &Path) {
    let mut docs = Vec::new();
    for (category, label, probe) in PROBES {
        // Anchor char gives zero-width leaders a base cell; width is the
        // cursor advance beyond the anchor.
        let mut emu = Emu::new(100, 4, 10).expect("emu");
        emu.feed("|".as_bytes());
        emu.feed(probe.as_bytes());
        let width = emu.cursor().col.saturating_sub(1);
        let row = emu.row_runs(0);
        let text: String = row.iter().map(|r| r.text.as_str()).collect();
        let exported = text.strip_prefix('|').unwrap_or(&text).to_string();
        docs.push(format!(
            "{{\"category\":\"{}\",\"label\":\"{}\",\"probe\":\"{}\",\
             \"codepoints\":\"{}\",\"width\":{},\"exported\":\"{}\",\
             \"exported_codepoints\":\"{}\"}}",
            category,
            json_escape(label),
            json_escape(probe),
            codepoints(probe),
            width,
            json_escape(&exported),
            codepoints(&exported),
        ));
    }
    let json = format!(
        "{{\"generator\":\"stem examples/width_goldens.rs\",\
         \"emulator\":\"alacritty_terminal 0.26.0\",\"unicode_width\":\"0.2.2\",\
         \"contract\":\"sum(client per-column widths over exported) == width, \
per row, or the client grid drifts from the server\",\
         \"probes\":[\n{}\n]}}",
        docs.join(",\n")
    );
    fs::write(out_dir.join("width-oracle.json"), json).expect("write oracle");
}

fn main() {
    let out = std::env::args()
        .nth(1)
        .expect("usage: width_goldens <out_dir>");
    let out_dir = Path::new(&out);
    fs::create_dir_all(out_dir).expect("out dir");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    fixture_goldens(&fixtures, out_dir);
    width_oracle(out_dir);
    println!("wrote {}", out_dir.display());
}
