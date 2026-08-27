# Grid Width-Parity Corpus — server emulator goldens for native clients

Companion to `reference/mobile-grid-contract-pack.md` §2.2 (Unicode cell
rules). Generated 2026-08-21 from the live emulator — **empirical, not
derived from tables**: every number below was measured by feeding the bytes
through the exact code that produces production grid frames.

- Emulator: `alacritty_terminal 0.26.0` (pinned `=0.26.0` in `stem`)
- Width tables: `unicode-width 0.2.2` (locked)
- Generator: `bud/stem/examples/width_goldens.rs` (untracked) —
  `cargo run -p stem --example width_goldens -- <out_dir>` from `bud/`

## Files

| File | Contents |
|---|---|
| `width-oracle.json` | 53 curated Unicode probes: for each, the server-measured column width (cursor advance) and the exported run text with codepoint listings |
| `fixture-goldens.json` | Each fixture in `bud/stem/tests/fixtures/*.raw` fed through the emulator at its recorded 80×24 geometry: final screen as wire-shape runs (`t`/`fg`/`bg`/`a`), cursor (+shape/blink), alt-screen flag, scrollback tail |

The raw fixture inputs live in the repo at `bud/stem/tests/fixtures/`
(golden captures — synthetic OSC 133/UTF-8-wide/scroll-region/flood streams
plus real vim 9.x and CPython 3.9 recordings; see that directory's README
for provenance). `utf8-wide.raw` is the Unicode-heavy one.

## The parity contract

For every run row the server ships, the client's column arithmetic must
reproduce the server's:

```
sum(client_width(scalar) for scalar in run_text of the row) == server columns occupied
```

`width-oracle.json` encodes this per probe: `width` is the number of columns
the probe occupied on the server. A client whose per-column math disagrees
drifts — cursor position, dirty-row alignment, and selection all break, even
though rendering "looks" fine.

## The four rules a SwiftTerm-table client must match

These are where stock Unicode/grapheme-based width logic diverges from the
server, and the oracle proves each one:

1. **Width is per Unicode scalar, never per grapheme cluster.** The server
   sums `unicode-width` values scalar by scalar as bytes arrive; it has no
   grapheme segmentation.
2. **VS16 (U+FE0F) never adds width.** `☺` = 1, `☺️` = **1**, `❤️` = **1**.
   Renderers that promote emoji-presentation sequences to width 2 (common,
   and what CoreText wants to draw) will drift one column per heart. Render
   the glyph however you like *inside* the columns the server assigned —
   but assign columns the server's way.
3. **ZWJ sequences never merge.** Width is the sum of the parts:
   `👩‍💻` = **4** (2+0+2), `👨‍👩‍👧‍👦` = **8**, `🏳️‍🌈` = **3** (1+0+0+2),
   `✌🏽` = **3** (1+2 — skin-tone modifiers are width-2 scalars, not
   combiners). A grapheme-cluster width table says 2 for all of these.
4. **Zero-width scalars attach to the previous cell** and are preserved in
   run text: combining marks, ZWJ/ZWNJ/ZWSP, the keycap enclosing mark
   (`#️⃣` = **1**: `#` +0 +0). Exception worth noting: some marks are
   *spacing* — Devanagari `कि` = **2** (U+093F is width 1); decomposed
   Hangul jamo `각` = **2** (wide leading jamo + zero-width vowel/final,
   same as precomposed).

Also confirmed: all East Asian **Ambiguous** characters resolve **narrow**
(width 1) — box drawing, arrows, Greek/Cyrillic, `§ ± · × ★ ● …` — the
server never applies ambiguous-as-wide, regardless of locale. Regional
indicator pairs (`🇺🇸`) happen to total **2** (1+1), which coincidentally
matches a single-glyph rendering.

## Suggested client check (SwiftTerm)

1. Extract/port your width function `width(scalar) -> 0|1|2`.
2. For each oracle probe: `assert sum(width(s) for s in probe.exported.unicodeScalars) == probe.width`.
3. For each fixture golden: for every screen row, recompute occupied columns
   from the run texts and assert they fit `cols`, and that your renderer
   places each run's first cell at the cumulative column the server implies.
4. Failures in rule-2/3 territory are expected on stock tables — fix by
   computing layout per-scalar (rules above), then choose glyph rendering
   separately (e.g. draw the ZWJ sequence as one image spanning the summed
   columns, or draw parts — the server doesn't care, the columns do).

If any of this is inconvenient enough that native would rather the server
adopted grapheme-aware widths: that would be a coordinated wire-visible
change across emulator, web, and native — raise it before building around a
divergence, don't shim silently.

## Width oracle (rendered from `width-oracle.json`)

| Category | Case | Probe | Codepoints | Server width |
|---|---|---|---|---|
| ascii | plain ascii | `abc` | U+0061 U+0062 U+0063 | **3** |
| ascii | space | ` ` | U+0020 | **1** |
| latin | precomposed e-acute | `é` | U+00E9 | **1** |
| latin | u-umlaut | `ü` | U+00FC | **1** |
| ambiguous | section sign | `§` | U+00A7 | **1** |
| ambiguous | plus-minus | `±` | U+00B1 | **1** |
| ambiguous | middle dot | `·` | U+00B7 | **1** |
| ambiguous | multiplication sign | `×` | U+00D7 | **1** |
| ambiguous | greek alpha | `α` | U+03B1 | **1** |
| ambiguous | greek capital omega | `Ω` | U+03A9 | **1** |
| ambiguous | cyrillic be | `б` | U+0431 | **1** |
| ambiguous | cyrillic capital ya | `Я` | U+042F | **1** |
| ambiguous | box light horizontal | `─` | U+2500 | **1** |
| ambiguous | box light vertical | `│` | U+2502 | **1** |
| ambiguous | full block | `█` | U+2588 | **1** |
| ambiguous | rightwards arrow | `→` | U+2192 | **1** |
| ambiguous | black star | `★` | U+2605 | **1** |
| ambiguous | white circle | `○` | U+25CB | **1** |
| ambiguous | black circle | `●` | U+25CF | **1** |
| ambiguous | horizontal ellipsis | `…` | U+2026 | **1** |
| ambiguous | em dash | `—` | U+2014 | **1** |
| narrow | euro sign | `€` | U+20AC | **1** |
| narrow | fi ligature | `ﬁ` | U+FB01 | **1** |
| wide | cjk ideograph | `日` | U+65E5 | **2** |
| wide | cjk pair | `日本` | U+65E5 U+672C | **4** |
| wide | hiragana | `あ` | U+3042 | **2** |
| wide | katakana | `ア` | U+30A2 | **2** |
| wide | hangul syllable (precomposed) | `각` | U+AC01 | **2** |
| wide | hangul jamo (decomposed) | `각` | U+1100 U+1161 U+11A8 | **2** |
| wide | fullwidth latin A | `Ａ` | U+FF21 | **2** |
| wide | fullwidth digit one | `１` | U+FF11 | **2** |
| wide | ideographic space | `　` | U+3000 | **2** |
| narrow | halfwidth katakana | `ｱ` | U+FF71 | **1** |
| combining | e + combining acute | `é` | U+0065 U+0301 | **1** |
| combining | e + acute + cedilla | `ȩ́` | U+0065 U+0301 U+0327 | **1** |
| combining | a + combining arrow above | `a⃗` | U+0061 U+20D7 | **1** |
| combining | devanagari ka + vowel sign i | `कि` | U+0915 U+093F | **2** |
| combining | thai ko kai + mai han-akat | `กั` | U+0E01 U+0E31 | **1** |
| zero-width | zero width space | `​` | U+200B | **0** |
| zero-width | zero width joiner alone | `‍` | U+200D | **0** |
| zero-width | zero width non-joiner | `‌` | U+200C | **0** |
| emoji | slightly smiling face | `🙂` | U+1F642 | **2** |
| emoji | thumbs up | `👍` | U+1F44D | **2** |
| emoji | white smiling face (text-default) | `☺` | U+263A | **1** |
| emoji | white smiling face + VS16 | `☺️` | U+263A U+FE0F | **1** |
| emoji | heavy black heart + VS16 | `❤️` | U+2764 U+FE0F | **1** |
| emoji | victory hand + medium skin tone | `✌🏽` | U+270C U+1F3FD | **3** |
| emoji | woman technologist (ZWJ) | `👩‍💻` | U+1F469 U+200D U+1F4BB | **4** |
| emoji | family MWGB (ZWJ x3) | `👨‍👩‍👧‍👦` | U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466 | **8** |
| emoji | rainbow flag (ZWJ + VS16) | `🏳️‍🌈` | U+1F3F3 U+FE0F U+200D U+1F308 | **3** |
| emoji | US flag (regional indicators) | `🇺🇸` | U+1F1FA U+1F1F8 | **2** |
| emoji | keycap number sign | `#️⃣` | U+0023 U+FE0F U+20E3 | **1** |
| mixed | cjk + ascii + emoji | `日a🙂b` | U+65E5 U+0061 U+1F642 U+0062 | **6** |
---

*Regenerate after any emulator or unicode-width upgrade: the lockfile pins are part of the contract, and a version bump that changes any oracle number is a wire-visible change for grid clients (call it out in the release notes / mobile channel).*
