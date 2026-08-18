//! Phase 0 emulator bake-off runner.
//!
//! For each fixture in fixtures/: feed both emulators in 4 KiB chunks, then
//! write per-fixture side-by-side results (grid, cursor, alt-screen flag,
//! scrollback count, per-chunk damage log, OSC 133 observations) to results/.
//! The flood fixture additionally measures parse throughput (best of 3).

mod alac;
mod report;
mod wez;

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use report::FeedReport;

const FIXTURES: &[&str] = &[
    "osc133-session.raw",
    "utf8-wide.raw",
    "altscreen-vim.raw",
    "repl-python.raw",
    "scroll-regions.raw",
    "flood.raw",
];

fn base_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR so the binary works from any cwd.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn diff_grids(wez: &[String], alac: &[String]) -> (usize, String) {
    let mut out = String::new();
    let rows = wez.len().max(alac.len());
    let mut diffs = 0;
    for i in 0..rows {
        let a = wez.get(i).map(String::as_str).unwrap_or("<absent>");
        let b = alac.get(i).map(String::as_str).unwrap_or("<absent>");
        if a == b {
            writeln!(out, "  row {i:>2} == |{a}|").unwrap();
        } else {
            diffs += 1;
            writeln!(out, "  row {i:>2} DIFF").unwrap();
            writeln!(out, "    wezterm-term       |{a}|").unwrap();
            writeln!(out, "    alacritty_terminal |{b}|").unwrap();
        }
    }
    (diffs, out)
}

fn write_report(
    path: &Path,
    name: &str,
    len: usize,
    wez: &FeedReport,
    alac: &FeedReport,
    wez_osc: &[String],
    alac_osc: &[String],
) -> (usize, usize) {
    let mut out = String::new();
    writeln!(out, "fixture: {name} ({len} bytes, fed in 4096-byte chunks)").unwrap();
    writeln!(out, "grid: 80x24, scrollback config: 10000 lines").unwrap();
    writeln!(out).unwrap();

    writeln!(out, "== state after full feed ==").unwrap();
    writeln!(
        out,
        "{:<24} {:<28} {:<28}",
        "", "wezterm-term", "alacritty_terminal"
    )
    .unwrap();
    writeln!(
        out,
        "{:<24} {:<28} {:<28}",
        "cursor (row, col)",
        format!("{:?}", wez.cursor),
        format!("{:?}", alac.cursor)
    )
    .unwrap();
    writeln!(
        out,
        "{:<24} {:<28} {:<28}",
        "alt-screen active", wez.alt_screen, alac.alt_screen
    )
    .unwrap();
    writeln!(
        out,
        "{:<24} {:<28} {:<28}",
        "scrollback lines", wez.scrollback_lines, alac.scrollback_lines
    )
    .unwrap();
    writeln!(
        out,
        "{:<24} {:<28} {:<28}",
        "quiet chunks",
        format!("{}/{}", wez.quiet_chunks, wez.damage_log.len()),
        format!("{}/{}", alac.quiet_chunks, alac.damage_log.len())
    )
    .unwrap();
    writeln!(out).unwrap();

    writeln!(out, "== final grid diff (trailing-space-trimmed) ==").unwrap();
    let (diffs, diff_text) = diff_grids(&wez.grid, &alac.grid);
    writeln!(
        out,
        "{}",
        if diffs == 0 {
            "  IDENTICAL".to_string()
        } else {
            format!("  {diffs} row(s) differ")
        }
    )
    .unwrap();
    out.push_str(&diff_text);
    writeln!(out).unwrap();

    let cursor_match = wez.cursor == alac.cursor;
    writeln!(out, "cursor match: {cursor_match}").unwrap();
    writeln!(out).unwrap();

    writeln!(out, "== damage log: wezterm-term (seqno/changed-lines model) ==").unwrap();
    for l in cap_log(&wez.damage_log) {
        writeln!(out, "  {l}").unwrap();
    }
    writeln!(out).unwrap();
    writeln!(out, "== damage log: alacritty_terminal (LineDamageBounds model) ==").unwrap();
    for l in cap_log(&alac.damage_log) {
        writeln!(out, "  {l}").unwrap();
    }
    writeln!(out).unwrap();

    writeln!(out, "== OSC 133 observability ==").unwrap();
    writeln!(out, "wezterm (typed pre-parse via wezterm-escape-parser):").unwrap();
    if wez_osc.is_empty() {
        writeln!(out, "  (none seen)").unwrap();
    }
    for l in wez_osc {
        writeln!(out, "  {l}").unwrap();
    }
    writeln!(out, "alacritty (second raw vte::Parser + custom Perform):").unwrap();
    if alac_osc.is_empty() {
        writeln!(out, "  (none seen)").unwrap();
    }
    for l in alac_osc {
        writeln!(out, "  {l}").unwrap();
    }
    writeln!(out).unwrap();

    writeln!(out, "== emulator-specific extras ==").unwrap();
    writeln!(out, "wezterm-term:").unwrap();
    for l in &wez.extra {
        writeln!(out, "  {l}").unwrap();
    }
    writeln!(out, "alacritty_terminal:").unwrap();
    for l in &alac.extra {
        writeln!(out, "  {l}").unwrap();
    }

    fs::write(path, out).expect("write report");
    (diffs, if cursor_match { 0 } else { 1 })
}

fn cap_log(log: &[String]) -> Vec<String> {
    // Full log for small fixtures; head+tail for the flood.
    if log.len() <= 24 {
        return log.to_vec();
    }
    let mut v: Vec<String> = log[..12].to_vec();
    v.push(format!("  ... {} chunks elided ...", log.len() - 20));
    v.extend_from_slice(&log[log.len() - 8..]);
    v
}

fn main() {
    let base = base_dir();
    let fixtures = base.join("fixtures");
    let results = base.join("results");
    fs::create_dir_all(&results).unwrap();

    let mut summary = String::new();
    writeln!(
        summary,
        "{:<22} {:>9} {:>10} {:>12} {:>14} {:>16}",
        "fixture", "bytes", "grid diff", "cursor match", "alt-screen", "scrollback w/a"
    )
    .unwrap();

    for name in FIXTURES {
        let path = fixtures.join(name);
        let data = match fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("SKIP {name}: {e}");
                continue;
            }
        };
        eprintln!("running {name} ({} bytes)...", data.len());

        let wez_report = wez::run_fixture(&data);
        let alac_report = alac::run_fixture(&data);
        let wez_osc = wez::osc133_scan(&data);
        let alac_osc = alac::osc133_scan(&data);

        let stem = name.trim_end_matches(".raw");
        let (grid_diffs, cursor_mismatch) = write_report(
            &results.join(format!("{stem}.txt")),
            name,
            data.len(),
            &wez_report,
            &alac_report,
            &wez_osc,
            &alac_osc,
        );

        writeln!(
            summary,
            "{:<22} {:>9} {:>10} {:>12} {:>14} {:>16}",
            name,
            data.len(),
            if grid_diffs == 0 {
                "identical".to_string()
            } else {
                format!("{grid_diffs} rows")
            },
            if cursor_mismatch == 0 { "yes" } else { "NO" },
            format!("{}/{}", wez_report.alt_screen, alac_report.alt_screen),
            format!(
                "{}/{}",
                wez_report.scrollback_lines, alac_report.scrollback_lines
            ),
        )
        .unwrap();

        // Throughput: flood fixture only, best of 3 per emulator.
        if *name == "flood.raw" {
            let mb = data.len() as f64 / 1e6;
            let mut wez_best = f64::MAX;
            let mut alac_best = f64::MAX;
            for _ in 0..3 {
                wez_best = wez_best.min(wez::throughput_secs(&data));
                alac_best = alac_best.min(alac::throughput_secs(&data));
            }
            let line = format!(
                "flood throughput (best of 3, {mb:.1} MB): wezterm-term {:.1} MB/s ({wez_best:.3}s), alacritty_terminal {:.1} MB/s ({alac_best:.3}s)",
                mb / wez_best,
                mb / alac_best
            );
            eprintln!("{line}");
            writeln!(summary, "\n{line}").unwrap();
        }
    }

    // Damage micro-probe: the DamageQuiet signal quality, isolated from fixtures.
    let mut probe = String::new();
    writeln!(
        probe,
        "Damage micro-probe: seed screen \"hello\\r\\nworld\\r\\n$ \", then tiny inputs.\n"
    )
    .unwrap();
    writeln!(probe, "wezterm-term (seqno watermark, non-destructive query):").unwrap();
    for l in wez::damage_probe() {
        writeln!(probe, "  {l}").unwrap();
    }
    writeln!(probe).unwrap();
    writeln!(
        probe,
        "alacritty_terminal (damage() + reset_damage(), single consumer):"
    )
    .unwrap();
    for l in alac::damage_probe() {
        writeln!(probe, "  {l}").unwrap();
    }
    fs::write(results.join("damage-probe.txt"), &probe).unwrap();
    println!("{probe}");

    fs::write(results.join("summary.txt"), &summary).unwrap();
    println!("{summary}");
    println!("per-fixture reports written to {}", results.display());
}
