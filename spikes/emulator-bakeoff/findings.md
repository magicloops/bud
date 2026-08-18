# Emulator bake-off findings: `wezterm-term` vs `alacritty_terminal`

Phase 0.2 of [plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md](../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md);
feeds decision **D5** in [design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md).

- Environment: macOS 15.6.1 (arm64), rustc 1.92.0, release builds, 80x24 grid,
  10,000-line scrollback config, fixtures fed in 4,096-byte chunks.
- Candidates:
  - `alacritty_terminal` **0.26.0** from crates.io (Apache-2.0), vte 0.15.
  - `wezterm-term` — **not published on crates.io** (sparse index returns 404; only
    `termwiz` is published). Evaluated as a git dependency on
    `https://github.com/wezterm/wezterm`, branch `main`, resolved to rev
    `fe3006aef` (2026-08-12). The git dependency builds cleanly; Cargo resolves the
    workspace-internal path deps without issue. So: usable, but only ever as a
    pinned git rev (or vendored), never as a semver crates.io release.
- Raw outputs: `results/*.txt` (per-fixture side-by-side grid diffs, damage logs,
  OSC captures), `results/damage-probe.txt`, `results/summary.txt`.

## Comparison table

| Dimension | wezterm-term (git `fe3006aef`) | alacritty_terminal 0.26.0 | Edge |
|---|---|---|---|
| Grid fidelity (6 fixtures) | identical | identical | tie |
| Cursor position (all fixtures) | identical | identical | tie |
| Alt-screen flag | `is_alt_screen_active()`; correct through vim enter/leave | `mode().contains(TermMode::ALT_SCREEN)`; correct through vim enter/leave | tie |
| Split UTF-8 codepoint at chunk boundary | handled (emoji split at byte 16384 renders correctly) | handled (same) | tie |
| Wide chars / ZWJ / combining | correct; `Line::as_str()` reconstructs text incl. zero-width | correct; must skip `WIDE_CHAR_SPACER` flags and append `zerowidth()` yourself | slight wezterm (nicer text API) |
| Scrollback | config-trait `scrollback_size()`; count via `screen.scrollback_rows() - physical_rows`; full line access incl. scrollback | `Config::scrolling_history`; count via `grid().history_size()`; access via negative `Line` indices | tie |
| Damage model | per-`Line` last-changed **seqno**; query = `get_changed_stable_rows(range, watermark)`; **non-destructive**, any number of observers; whole-line granularity, no column bounds | `damage()` -> `Full` \| `Partial(iter of {line, left, right})` (column bounds); **destructive** (`reset_damage()`), single consumer; any viewport scroll -> `Full` | see below |
| "Quiet" cheaply queryable (DamageQuiet) | yes, cleanly: empty changed-set = quiet; cursor-only moves stay quiet (and are separately observable via `cursor_pos().seqno`) | **not directly**: `damage()` always includes the current cursor cell, so it is *never* empty; quiet detection requires filtering out cursor-only damage (small, contained adapter fix) | **wezterm** |
| OSC 133 observability | parsed **natively** into typed semantic zones (`get_semantic_zones()` -> Prompt/Input/Output with coordinates — verified on the fixture); exit code (`CommandStatus{status}`) is parsed by `wezterm-escape-parser` but **dropped by the Terminal** — embedder gets exit codes by pre-parsing with the same typed parser (`Parser::parse` -> `Action` -> `perform_actions`, single parse) | **no hook at all** on the `Term`/`Processor` path — vte drops unrecognized OSC with a `debug!` log; `EventListener` has no OSC event; only option demonstrated: a second, separate low-level `vte::Parser` with a custom `Perform` (double parse), or a hand-rolled pre-scanner | **wezterm** |
| Unrecognized OSC generally | optional warn log only; no embedder callback on `Terminal` (pre-parse is the supported pattern) | debug log only; same pre-parse story | tie (both need pre-parse) |
| Throughput (3.9 MB flood, 4 KiB chunks, best of 3) | 43.7 MB/s | **191 MB/s** (4.4x) | **alacritty** |
| Transitive deps | **252** (incl. image codecs, terminfo, bidi, lru — `use_image` is hard-wired in wezterm-term's own deps) | **39** | **alacritty** |
| Clean release build (this machine) | 14.2 s wall / 176 s CPU | 3.5 s wall / 24.5 s CPU | **alacritty** |
| License | MIT | Apache-2.0 | tie (both fine) |
| Packaging | unpublished, `version 0.1.0`, git-pin or vendor forever | semver releases on crates.io (~2/yr: 0.24->0.25 Feb 2025, 0.26 Apr 2026) | **alacritty** |
| Maintenance impression | very active repo (last commit 2 days before this spike; ~95 commits in 6 months); but the crate itself has no release discipline — you track `main` | active; releases track the alacritty app's needs; **known breaking API churn between minors** (the design doc already flags this) | roughly tie, different failure modes |

Fixture-level notes (details in `results/`):

- `osc133-session`: grids identical; wezterm additionally produced 10 correct
  semantic zones (Prompt/Input/Output spans) from the markers — for free.
- `utf8-wide`: grids identical, including the 100-wide-char wrapped line and the
  emoji deliberately split across the 16,384-byte chunk boundary.
- `altscreen-vim` (real recorded vim): grids identical; both correctly end with
  alt-screen inactive after `?1049l`.
- `repl-python` (real recorded CPython): identical.
- `scroll-regions` (DECSTBM): grids identical; **one benign divergence**:
  scrollback line count 62 (wezterm) vs 63 (alacritty) — an off-by-one in how the
  two account lines pushed to history around the margin reset. Visible state
  agrees; flagged for the Phase 1 regression suite rather than blocking.
- `flood`: grids identical, both capped scrollback at the configured 10,000.
- Damage probe (`results/damage-probe.txt`): after a cursor-only move, wezterm
  reports quiet (changed-lines empty) while exposing the move via the cursor
  seqno; alacritty reports the old+new cursor cells damaged, and even a
  zero-byte feed reports the cursor cell damaged. During scrolling output
  alacritty collapses to `Full` damage every chunk; wezterm keeps reporting
  exact changed rows.

## Recommendation

**Choose `alacritty_terminal` (0.26.x, crates.io) for stem's emulator**, with a
thin adapter absorbing its two sharp edges. This *reverses* D5's initial lean
toward wezterm-term, on the evidence:

1. **Fidelity — the reason to prefer wezterm — was a tie.** Across a corpus that
   includes real vim, DECSTBM regions, wide/ZWJ/combining text, and a split
   codepoint at a chunk boundary, final grids, cursors, and alt-screen flags were
   identical. No fidelity gap materialized to justify wezterm's costs.
2. **wezterm-term cannot be a normal dependency.** It is unpublished (0.1.0,
   git-only) and drags **252 transitive deps** (including an image stack the
   daemon will never use) vs **39**, and 4x the compile time. For a shipped
   daemon binary, a pinned-git, 250-crate emulator is the wrong trade.
3. **The OSC 133 advantage is neutralized by our own design.** D6a already
   commits to pre-parsing OSC 133 daemon-side, *before* the emulator, precisely
   so the semantic layer is emulator-agnostic and works during ring replay.
   Given that, neither emulator's hook matters; the pre-scanner we must write
   anyway covers alacritty's gap. (If a typed parser is wanted rather than a
   ~50-line scanner, `termwiz` 0.23 — which *is* on crates.io — contains the
   FinalTerm-typed escape parser.)
4. **DamageQuiet is achievable with one contained filter.** alacritty's
   `damage()` always includes the current cursor cell; "quiet" = damage set is
   empty after excluding a cursor-cell-only entry. That is a few lines in the
   stem adapter, verified feasible by the probe (cursor damage is exactly
   `line == cursor.line, left == right == cursor.col`). The remaining coarseness
   (Full damage on scroll) does not hurt the actual use case: the TUI settling
   signal runs on the **alt screen**, where full-screen scrolls are rare and
   in-place repaints produce the partial, column-bounded damage alacritty is
   good at. For scrolling shell output we don't need damage at all — mode
   Shell/REPL readiness comes from OSC 133 / prompt patterns, not damage.
5. **Throughput margin** (191 vs 44 MB/s) is not decisive for PTY-rate input but
   is free headroom for ring replay on reattach, which parses megabytes in one
   burst — replaying an 8 MiB ring takes ~40 ms vs ~180 ms.

### Caveats accepted with alacritty_terminal

- **API churn risk (the known cost):** minor releases break embedders
  (~2 releases/yr). Mitigation: pin exact version; all usage confined to one
  adapter module in stem (this spike's `src/alac.rs` is already that shape,
  ~160 lines); budget a small bump per release.
- **Damage is destructive and single-consumer** (`reset_damage()`): stem's
  emulator wrapper must be the sole damage reader and fan out derived events.
  That matches the D10 architecture (stem owns the emulator; daemon consumes
  stem events), so no design change.
- **Cursor-only damage filter** must exist and be tested (regression case in the
  Phase 1 suite; the damage probe here is the template).
- The scroll-regions scrollback off-by-one vs wezterm is unexplained at depth;
  carry the fixture into the regression suite and pick one behavior as baseline.
- `Term::new` takes dimensions via the `test::TermSize` helper or any
  `Dimensions` impl — mildly awkward but public and stable enough in practice.

### What would flip this decision

- A fidelity failure on the harder TUI fixtures still to be recorded (htop,
  codex startup) — wezterm-term remains the fallback and the harness here makes
  re-comparison a one-command affair.
- A hard requirement for emulator-native semantic zones or multi-observer
  damage watermarks (not in the current design).

## Deviations / not covered

- `htop` and `codex` fixtures skipped (not installed / not available); noted in
  `fixtures/README.md` as follow-ups for the regression corpus.
- Mid-stream **resize behavior** (mentioned in plan 0.2's compare list, not in
  D5's requirement list) was not exercised; recommend adding a resize fixture
  when the stem adapter exists, since resize semantics interact with reflow and
  both crates reflow differently.
- Throughput was measured on parse only (no damage queries in the timed loop);
  per-chunk damage querying adds negligible cost in both (line-bounds iteration
  vs seqno compare).
