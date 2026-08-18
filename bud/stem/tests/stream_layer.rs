//! Integration tests for the stream-intelligence layer: `semantic` scanner,
//! `emu` wrapper, and `modes` machine over the Phase 0 fixture corpus
//! (`tests/fixtures/`, copied from `spikes/emulator-bakeoff/fixtures/`).

use stem::emu::Emu;
use stem::events::{Integration, Mode};
use stem::modes::{ModeMachine, NoRepl};
use stem::semantic::{ScanEvent, ScanKind, Scanner};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn scan_whole(data: &[u8]) -> Vec<ScanEvent> {
    Scanner::new().scan(0, data)
}

/// The exact marker sequence hand-authored into osc133-session.raw
/// (generate.py): three commands exiting 0, 1, 0, each preceded by a prompt
/// (A + B), plus a trailing fresh prompt.
fn expected_osc133_kinds() -> Vec<ScanKind> {
    let mut kinds = Vec::new();
    for exit in [0, 1, 0] {
        kinds.push(ScanKind::PromptStart);
        kinds.push(ScanKind::CommandInputStart);
        kinds.push(ScanKind::CommandOutputStart);
        kinds.push(ScanKind::CommandEnd {
            exit_code: Some(exit),
        });
    }
    kinds.push(ScanKind::PromptStart);
    kinds.push(ScanKind::CommandInputStart);
    kinds
}

#[test]
fn scanner_osc133_session_marker_sequence() {
    let data = fixture("osc133-session.raw");
    let events = scan_whole(&data);

    let kinds: Vec<ScanKind> = events.iter().map(|e| e.kind.clone()).collect();
    assert_eq!(kinds, expected_osc133_kinds());

    // Offsets are strictly increasing, in-range, and each points at the byte
    // AFTER an OSC terminator (BEL, or the backslash of ESC \).
    let mut prev = 0u64;
    for event in &events {
        assert!(
            event.at_offset > prev,
            "offsets must strictly increase: {events:?}"
        );
        assert!(event.at_offset <= data.len() as u64);
        let at = event.at_offset as usize;
        let bel = data[at - 1] == 0x07;
        let st = at >= 2 && data[at - 2] == 0x1b && data[at - 1] == b'\\';
        assert!(bel || st, "offset {at} does not follow an OSC terminator");
        prev = event.at_offset;
    }
}

#[test]
fn scanner_is_chunk_boundary_safe_on_osc133_session() {
    let data = fixture("osc133-session.raw");
    let expected = scan_whole(&data);

    // 1-byte chunks: identical events and offsets.
    let mut scanner = Scanner::new();
    let mut events = Vec::new();
    for (i, byte) in data.iter().enumerate() {
        events.extend(scanner.scan(i as u64, std::slice::from_ref(byte)));
    }
    assert_eq!(events, expected, "1-byte chunk feed diverged");

    // Two-chunk split at every boundary within the first 200 bytes (this
    // range crosses several complete markers, including mid-escape and
    // mid-payload splits).
    for split in 0..=200.min(data.len()) {
        let mut scanner = Scanner::new();
        let mut events = scanner.scan(0, &data[..split]);
        events.extend(scanner.scan(split as u64, &data[split..]));
        assert_eq!(events, expected, "split at byte {split} diverged");
    }
}

#[test]
fn scanner_altscreen_vim_enter_and_leave() {
    let data = fixture("altscreen-vim.raw");
    // Recorded vim also toggles ?2004 (bracketed paste) — reported separately
    // as interactivity signals; this test asserts the alt-screen facts only.
    let events: Vec<_> = scan_whole(&data)
        .into_iter()
        .filter(|e| {
            matches!(
                e.kind,
                stem::semantic::ScanKind::AltScreenEnter | stem::semantic::ScanKind::AltScreenLeave
            )
        })
        .collect();
    // Recorded vim sets many private modes; only ?1049h/?1049l are
    // alt-screen facts. ?1049h is the very first sequence (bytes 0..8).
    assert_eq!(
        events,
        vec![
            ScanEvent {
                at_offset: 8,
                kind: ScanKind::AltScreenEnter
            },
            ScanEvent {
                at_offset: 2093,
                kind: ScanKind::AltScreenLeave
            },
        ]
    );
}

#[test]
fn mode_machine_drives_tui_from_vim_fixture() {
    let data = fixture("altscreen-vim.raw");

    // Integrated shell session enters vim and exits back to Shell.
    let mut scanner = Scanner::new();
    let mut machine = ModeMachine::new(Box::new(NoRepl));
    let mut transitions = Vec::new();
    for event in scanner.scan(0, b"\x1b]133;A\x07") {
        if let Some(change) = machine.on_scan(&event.kind) {
            transitions.push((change.mode, change.integration));
        }
    }
    for event in scanner.scan(8, &data) {
        if let Some(change) = machine.on_scan(&event.kind) {
            transitions.push((change.mode, change.integration));
        }
    }
    assert_eq!(
        transitions,
        vec![
            (Mode::Shell, Integration::Osc133),
            (Mode::Tui, Integration::Osc133),
            (Mode::Shell, Integration::Osc133),
        ]
    );

    // Non-integrated session: Unknown → Tui → Unknown.
    let mut scanner = Scanner::new();
    let mut machine = ModeMachine::new(Box::new(NoRepl));
    let mut modes = Vec::new();
    for event in scanner.scan(0, &data) {
        if let Some(change) = machine.on_scan(&event.kind) {
            modes.push(change.mode);
        }
    }
    assert_eq!(modes, vec![Mode::Tui, Mode::Unknown]);
    assert_eq!(machine.integration(), Integration::None);
}

#[test]
fn emu_renders_utf8_wide_fixture() {
    // Baseline: spikes/emulator-bakeoff/results/utf8-wide.txt (80x24,
    // 10000-line scrollback, 4096-byte chunks — the emoji at offset 16382 is
    // split across the chunk boundary at 16384).
    let data = fixture("utf8-wide.raw");
    let mut emu = Emu::new(80, 24, 10_000).unwrap();
    for chunk in data.chunks(4096) {
        emu.feed(chunk);
    }
    let lines = emu.screen_lines();
    assert_eq!(lines.len(), 24);
    assert_eq!(
        lines[0],
        "padding padding padding padding padding padding padding padding"
    );
    assert_eq!(
        lines[19],
        "padding padding padding padding padding padding padding padding"
    );
    assert!(
        lines[20].chars().all(|c| c == 'x') && !lines[20].is_empty(),
        "{:?}",
        lines[20]
    );
    assert_eq!(lines[21], "😀 <- this emoji straddles byte 16384");
    assert_eq!(lines[22], "end of utf8 fixture");
    assert_eq!(lines[23], "");

    let cursor = emu.cursor();
    assert_eq!((cursor.row, cursor.col), (23, 0));
    assert!(!emu.alt_screen_active());

    // Scrollback matches the bake-off baseline count and content shape.
    let scrollback = emu.scrollback_lines(100_000);
    assert_eq!(scrollback.len(), 228);
    assert_eq!(scrollback[0], "CJK wide: 日本語テスト 中文测试 한국어");
    assert_eq!(scrollback[1], "emoji: 🚀 🎉 ok");
}

#[test]
fn emu_renders_altscreen_vim_fixture() {
    let data = fixture("altscreen-vim.raw");
    // ?1049l sits at bytes 2085..2093 (verified by the scanner test above):
    // split there to observe the alt screen while vim is "running".
    let leave = 2085;
    let mut emu = Emu::new(80, 24, 10_000).unwrap();
    emu.feed(&data[..leave]);
    assert!(emu.alt_screen_active());
    let screen = emu.screen_lines().join("\n");
    assert!(
        screen.contains("hello from the editor"),
        "alt screen:\n{screen}"
    );
    assert!(
        screen.contains("second line of the file"),
        "alt screen:\n{screen}"
    );

    let report = emu.feed(&data[leave..]);
    assert!(report.alt_screen_changed);
    assert!(!emu.alt_screen_active());
    // Baseline (results/altscreen-vim.txt): primary screen restored to empty,
    // cursor home, no scrollback.
    let cursor = emu.cursor();
    assert_eq!((cursor.row, cursor.col), (0, 0));
    assert!(emu.screen_lines().iter().all(|l| l.is_empty()));
    assert_eq!(emu.scrollback_lines(10), Vec::<String>::new());
}

#[test]
fn emu_cursor_only_damage_is_filtered() {
    // The D5 DECIDED-note regression: cursor artifacts must not read as
    // meaningful damage, while real prints must.
    let mut emu = Emu::new(80, 24, 100).unwrap();
    let report = emu.feed(b"abc");
    assert!(report.meaningful_damage, "print: {report:?}");

    // Cursor moves only (absolute, relative, column) — no content change.
    for probe in [b"\x1b[5;5H".as_slice(), b"\x1b[2A", b"\x1b[10G", b""] {
        let report = emu.feed(probe);
        assert!(
            !report.meaningful_damage,
            "cursor-only feed {:?} reported meaningful damage: {report:?}",
            String::from_utf8_lossy(probe)
        );
        assert!(report.damaged_rows.is_empty());
        assert!(!report.full_repaint);
    }

    // And content is still detected afterwards.
    let report = emu.feed(b"more");
    assert!(report.meaningful_damage);
}

#[test]
fn flood_through_scanner_and_emu() {
    let data = fixture("flood.raw");
    let started = std::time::Instant::now();

    let mut scanner = Scanner::new();
    let mut events = 0usize;
    let mut offset = 0u64;
    for chunk in data.chunks(4096) {
        events += scanner.scan(offset, chunk).len();
        offset += chunk.len() as u64;
    }
    let scan_elapsed = started.elapsed();
    assert_eq!(events, 0, "flood fixture contains no semantic markers");

    let emu_started = std::time::Instant::now();
    let mut emu = Emu::new(80, 24, 10_000).unwrap();
    for chunk in data.chunks(4096) {
        emu.feed(chunk);
    }
    let emu_elapsed = emu_started.elapsed();

    // Completion is the assertion; timing is logged for the throughput note.
    let mb = data.len() as f64 / 1e6;
    eprintln!(
        "flood {:.1} MB: scanner {:.3}s ({:.1} MB/s), emu {:.3}s ({:.1} MB/s)",
        mb,
        scan_elapsed.as_secs_f64(),
        mb / scan_elapsed.as_secs_f64(),
        emu_elapsed.as_secs_f64(),
        mb / emu_elapsed.as_secs_f64(),
    );

    assert_eq!(emu.screen_lines().last().map(String::as_str), Some(""));
    assert_eq!(
        emu.scrollback_lines(100_000).len(),
        10_000,
        "scrollback capped"
    );
}

#[test]
fn scroll_regions_fixture_sane() {
    // Carried from the bake-off (results/scroll-regions.txt): headers stay
    // put, alacritty accounts 63 scrollback lines (baseline behavior chosen
    // per findings.md).
    let data = fixture("scroll-regions.raw");
    let mut emu = Emu::new(80, 24, 10_000).unwrap();
    for chunk in data.chunks(4096) {
        emu.feed(chunk);
    }
    let lines = emu.screen_lines();
    assert!(!emu.alt_screen_active());
    assert!(lines
        .iter()
        .any(|l| l.contains("last line of scroll-regions fixture")));
    assert_eq!(emu.scrollback_lines(100_000).len(), 63);
}
