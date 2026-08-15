# emulator-bakeoff

Phase 0.2 spike comparing the two VT-emulator candidates for the native terminal
session manager (`stem`): `wezterm-term` (git dependency; unpublished on
crates.io) vs `alacritty_terminal` 0.26 (crates.io). Standalone Cargo project —
deliberately **not** part of any workspace.

## Purpose

Produce decision-grade evidence for design decision D5 in
[../../design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md):
grid fidelity, damage/dirty-tracking ergonomics (the future `DamageQuiet`
signal), scrollback access, alt-screen flag, cursor position, OSC 133
observability, throughput, dependency weight, license, and maintenance posture.
Outcome and recommendation are recorded in [findings.md](./findings.md)
(recommendation: `alacritty_terminal`, reversing D5's initial lean).

## Files

- `Cargo.toml` — standalone package (`[workspace]` stanza keeps it out of any parent workspace); pins `alacritty_terminal` 0.26 and `wezterm-term` + `wezterm-escape-parser` as git deps on `wezterm/wezterm` main (Cargo.lock pins rev `fe3006aef`).
- `Cargo.lock` — checked in for reproducible dependency resolution (the wezterm git rev lives here).
- `src/main.rs` — runner: feeds every fixture to both emulators in 4 KiB chunks, writes per-fixture side-by-side grid diffs / damage logs / OSC captures to `results/`, runs the damage micro-probe, and measures flood parse throughput (best of 3).
- `src/report.rs` — shared `FeedReport` shape and grid/chunk constants (80x24, 4096-byte chunks, 10k scrollback).
- `src/wez.rs` — wezterm-term adapter: seqno-watermark damage queries, semantic-zone extraction, typed OSC 133 pre-parse via `wezterm-escape-parser`.
- `src/alac.rs` — alacritty_terminal adapter: `damage()`/`reset_damage()` handling, EventListener capture, raw OSC 133 capture via a second low-level `vte::Parser`.
- `fixtures/` — raw byte fixture corpus + `generate.py` (synthetic fixtures) + `README.md` (inventory, provenance, re-recording commands). Two fixtures (`altscreen-vim.raw`, `repl-python.raw`) are real recordings via BSD `script(1)`. Intended to seed the Phase 1/2 regression suite (`stem/tests/fixtures/`).
- `results/` — checked-in run outputs: per-fixture reports, `damage-probe.txt`, `summary.txt`.
- `findings.md` — comparison table, per-fixture notes, recommendation + caveats (feeds design doc D5).

## Running

```bash
cd spikes/emulator-bakeoff
cargo run --release          # rewrites results/
python3 fixtures/generate.py # regenerate synthetic fixtures only (recorded ones are golden)
```

## Dependencies

- [../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md](../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md) — owning plan phase (work item 0.2).
- [../../design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md) — D5 (emulator decision), D6a (OSC 133 pre-parse), D7 (damage-quiet settling).
- Crates: `alacritty_terminal` 0.26.0 (Apache-2.0, crates.io), `wezterm-term`/`wezterm-escape-parser` (MIT, git `wezterm/wezterm` @ `fe3006aef`).

## TODOs / Technical Debt

- <!-- SPEC:TODO --> Record `htop` and `codex` TUI fixtures on a machine that has them; re-run the comparison (see findings.md "What would flip this decision").
- <!-- SPEC:TODO --> Add a mid-stream resize/reflow fixture when the stem emulator adapter exists.

---

*Referenced by: [../spikes.spec.md](../spikes.spec.md)*
