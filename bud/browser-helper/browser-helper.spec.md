# Private browser semantic helper

Node 22+ and pinned Playwright Core 1.63.0 provide structured accessible DOM
snapshots and exact semantic actions against Rust's managed Chrome for Testing.
No browser is downloaded or launched by this helper. No model-supplied JavaScript
or CDP is accepted. The Rust browser manager owns serialization and authority.

- `main.mjs`: serial, private stdio adapter; loopback CDP bootstrap, bounded
  commands and canonical errors without raw page-bearing exception text.
- `engine.mjs`: snapshot hierarchy, value exclusion, visible geometry, metadata,
  exact role/name and reference targeting, fill and wheel. Uses Playwright's
  `ariaSnapshotJSON({mode:'ai'})` and `aria-ref` selectors from that snapshot.
- `engine.test.mjs`: disposable Chrome fixture and sanitizer regressions.
- `package.json` / `package-lock.json`: reproducible runtime dependency.

One snapshot per browser, 60-second lifetime, 2 MiB retained nodes, 24 KiB node
pages plus rendered text. New snapshot, navigation, disconnect or authority
invalidation retires references. Continuations read retained nodes, not a new
page; each call checks the current document. Scope uses an observed reference.
Closed shadow roots/inaccessible frames are explicitly outside coverage.
The helper's operation deadline is eight seconds, with a 128 MiB V8 heap limit; interruption kills the helper
and poisons the adapter, never replays a mutation.

Setup: `npm ci --ignore-scripts --prefix bud/browser-helper` from repo root.
Source builds find `main.mjs` relative to the Cargo manifest. Installed builds
must set `BUD_BROWSER_HELPER` to the deployed helper and supply Node on PATH or
`BUD_BROWSER_NODE`. Packaging this optional runtime into release installers is
still release work. Missing helper disables browser readiness, not terminals.

See [Phase 3d](../../plan/bud-owned-browser/phase-3d-agent-observations-and-targeting.md).
