# stem regression fixtures

Byte-for-byte copies of the Phase 0 emulator bake-off corpus at
`spikes/emulator-bakeoff/fixtures/` (copied 2026-08-15; see that directory's
README.md for full provenance, byte layouts, and re-recording commands).

- Synthetic fixtures (`osc133-session.raw`, `utf8-wide.raw`,
  `scroll-regions.raw`, `flood.raw`) were produced by the spike's
  `generate.py`.
- Recorded fixtures (`altscreen-vim.raw` — real vim 9.x, `repl-python.raw` —
  real CPython 3.9) were captured on macOS 15.6.1 with BSD `script(1)`,
  `TERM=xterm-256color`, 80x24.

Treat these as golden captures: do not regenerate casually. Expected grids and
damage behavior are baselined in `spikes/emulator-bakeoff/results/*.txt`.
Consumed by `stem/tests/stream_layer.rs` and unit tests in `src/`.
