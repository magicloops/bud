# Fixture corpus

Raw byte streams (escape sequences included, CRLF line endings) as a PTY-attached
program would emit them. Synthetic fixtures are produced by `generate.py` in this
directory; recorded fixtures were captured on macOS 15.6.1 with BSD `script(1)`
(`script -q <outfile> <command> [args...]`), `TERM=xterm-256color`, 80x24.

These files are the seed of the Phase 1/2 regression suite (`stem/tests/fixtures/`
per plan phase 0.2) — do not regenerate casually; treat recorded fixtures as
golden captures.

| File | Kind | Bytes | Contents |
|---|---|---|---|
| `osc133-session.raw` | hand-authored (generate.py) | 840 | Shell session with OSC 133 A/B/C/D markers: colored prompt (SGR bold/green/blue), `ls -la` exiting 0, `cat missing.txt` exiting 1 (red error line), a 5-line loop exiting 0, trailing fresh prompt. Mixes ST- and BEL-terminated OSC (the `D;0` after `ls` uses BEL) to exercise both terminators. |
| `utf8-wide.raw` | hand-authored (generate.py) | 16444 | CJK wide chars, emoji, a ZWJ sequence (woman-technologist 👩‍💻), a regional-indicator flag, combining accents (e + U+0301 etc.), wide/narrow interleaving, a 100-wide-char line that must wrap at 80 cols, then ASCII padding sized so a 4-byte emoji (U+1F600, `F0 9F 98 80`) starts at absolute offset **16382** and is split by the runner's 4096-byte chunk boundary at offset **16384** (2 bytes in chunk 3, 2 bytes in chunk 4). Tests partial-codepoint handling across `advance` calls. |
| `altscreen-vim.raw` | **recorded** | 2099 | Real vim 9.x (`/usr/bin/vim -u NONE -i NONE -c ':redraw' -c ':sleep 500m' -c ':q!' notes.txt`) captured through `script -q`: alt-screen enter (`?1049h`), full paint of a 2-line file with colored `~` filler lines and cursor addressing, alt-screen leave (`?1049l`). stdin was held open with a `(sleep 3) \|` pipe so no `^D` echo pollutes the capture. |
| `repl-python.raw` | **recorded** | 276 | Real interactive `python3 -q` under `script -q`, driven by paced stdin (`{ sleep ...; printf ... } \| script ...` — pacing is required: an unpaced pipe races the prompts and produces a garbled transcript). Contains `>>>` prompts, `...` continuation prompts, expression results, a for-loop, and a NameError traceback. |
| `flood.raw` | generated (generate.py) | 3888895 | `seq 1 500000`-equivalent with CRLF endings (~3.9 MB). Throughput measurement and scrollback-cap behavior. |
| `scroll-regions.raw` | hand-authored (generate.py) | 2259 | Clear + home, 4 fixed header lines, DECSTBM region rows 5–20, 40 lines scrolled inside the region (headers must stay put), footer below region, DECSTBM reset, then 60 full-screen lines to push real scrollback. |

## Skipped (not installed / not recorded)

- `htop`: listed in the plan's wish list; not recorded in this pass (would need an
  interactive 10s capture; add later on a machine with htop installed).
- `codex` TUI startup: binary not available on this machine; noted as a follow-up
  fixture for the regression corpus since it is the known-problematic TUI.

## Reproduction commands (recorded fixtures)

```bash
# altscreen-vim.raw
printf 'hello from the editor\nsecond line of the file\n' > notes.txt
(sleep 3) | COLUMNS=80 LINES=24 TERM=xterm-256color \
  script -q altscreen-vim.raw /usr/bin/vim -u NONE -i NONE \
  -c ':redraw' -c ':sleep 500m' -c ':q!' notes.txt

# repl-python.raw
{ sleep 1; printf '1+1\n'; sleep 0.7; printf '"bud" * 3\n'; sleep 0.7; \
  printf 'for i in range(3):\n'; sleep 0.4; printf '    print("loop", i)\n'; \
  sleep 0.4; printf '\n'; sleep 0.7; printf 'undefined_name\n'; sleep 0.7; \
  printf 'exit()\n'; sleep 1; } | COLUMNS=80 LINES=24 TERM=xterm-256color \
  script -q repl-python.raw /usr/bin/python3 -q
```

Note: recorded bytes are exact for the tool versions used (vim 9.x, CPython 3.9,
macOS BSD script). Re-recording on other versions will produce different bytes;
that is fine for a regression corpus as long as expected outputs are re-baselined.
