# Bud browser add-on

Browser support lets Bud's agent navigate and inspect websites, with a remote
viewer and private user control. It is optional; terminals work without it.

This directory contains the add-on's **semantic helper**: Node.js and Playwright
Core provide structured snapshots and element targeting. Rust owns Chrome,
profiles, tabs, screenshots, control authority and process lifecycle. The helper
uses private stdio and attaches to the daemon's browser; it is not a standalone
browser service or a Chrome extension.

## Enable browser support

With an installed Bud daemon:

```sh
bud browser prepare
bud browser status
```

Preparation prefers installed Google Chrome or Chromium, installs the pinned
Node runtime, extracts the helper embedded in the daemon, probes browser launch,
and writes `<base_dir>/browser/manifest.json`. If no usable browser is found, it
offers the pinned Chrome for Testing download. To select that managed browser:

```sh
bud browser prepare --managed
```

Installed users do not need npm or a separate Node installation. Preparation
offers a daemon restart; the daemon reads the manifest at startup. Use
`--no-restart` to restart later, or `--yes` to accept download/restart prompts.
Use the same base directory as your daemon:

```sh
bud --base-dir /path/to/bud-state browser prepare
```

The default is `~/.bud`; `--local` uses the launch directory's `.bud`. Even with
a system Chrome executable, Bud uses its own profile, separate from personal
Chrome. Sign-ins persist and are shared across thread-owned tabs. Private control
pauses agent browser work across the Bud until explicit Return to agent.

## Develop from a checkout

Use Node **22 or newer**, npm, and the daemon's normal Rust/build prerequisites.
From the repository root:

```sh
npm ci --ignore-scripts --prefix bud/browser-helper
cargo build --manifest-path bud/Cargo.toml
```

The build embeds helper sources and installed `node_modules`. A build without
those dependencies still supports terminals, but its embedded helper is incomplete.
Install dependencies before producing a browser-ready build.

To use this checkout's helper and local Node instead of extracted/managed copies:

```sh
./bud/target/debug/bud browser prepare \
  --helper-dir bud/browser-helper \
  --node "$(command -v node)" \
  --no-restart
```

Add `--browser /absolute/path/to/chrome` to choose the executable. Preparation
records absolute paths, so the daemon can start from another working directory.
Restart your development daemon after helper changes; running helpers do not
reload their modules. For embedded helpers, rebuild first, then run
`./bud/target/debug/bud browser prepare --no-restart`, then restart. Managed
helpers are cached by archive SHA-256, so different dirty builds cannot reuse
stale code merely because their Git version labels match. A mismatched managed
helper is unavailable until prepared with the matching daemon binary.

## Tests

From the repository root:

```sh
npm --prefix bud/browser-helper test
```

Live-browser fixtures are skipped unless `BUD_BROWSER_EXECUTABLE` is set. For
example, with installed Chrome on macOS:

```sh
BUD_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npm --prefix bud/browser-helper test
```

Fixtures launch disposable headless browsers. Passing with skipped fixtures does
not validate live Chrome, persistent profiles or viewer/control behavior.

## Dependency pins and release builds

`package.json` and `package-lock.json` pin Playwright Core. Its browser metadata
determines the managed Chrome build and minimum accepted system Chromium major.
The managed Node version and artifact hashes are maintained by
[`scripts/browser-addon-pins.mjs`](../../scripts/browser-addon-pins.mjs).

After updating dependency pins and installing the locked dependencies, regenerate
and check the Rust artifact pins from the repository root:

```sh
node scripts/browser-addon-pins.mjs
node scripts/browser-addon-pins.mjs --check
```

Generation downloads and hashes artifacts; `--check` checks committed pin values
without downloads. Do not hand-edit generated `bud/src/browser/pins.rs` or ship
empty hashes. The release workflow vendors dependencies before Cargo builds so
installed daemons can prepare the add-on without a source checkout.

## Diagnostics and removal

```sh
bud browser status --json
bud doctor --format json
```

Status performs a fresh launch probe and reports manifest staleness, paths and
host caveats. If stale, prepare again and restart. The readiness probe is headless;
the actual browser's window behavior is configured separately.

Persistent secure-storage support is currently validated on macOS. Monitorless
Ubuntu/display and Linux secure-storage work remain in
[Phase 3o](../../plan/bud-owned-browser/phase-3o-ubuntu-headed-browser.md);
dependency installation alone does not establish Linux browser readiness.

To remove the add-on, stop the daemon and its owned Chrome first, then run:

```sh
bud browser remove --no-restart
```

Removal deletes the manifest and managed runtime/helper/browser files, preserving
profiles and sign-ins by default. `--keep-managed-browser` retains managed Chrome;
`--profiles` also deletes saved profiles and sign-ins. Removal refuses while a
profile is in use, including Chrome surviving a crashed daemon. It does not
uninstall system Chrome or delete a checkout helper.

## Source map

| File | Responsibility |
| --- | --- |
| `main.mjs` | Bounded private stdio protocol and helper startup |
| `engine.mjs` | Snapshots, observed references, exact targeting and actions |
| `compact.mjs` | Budgeted structured text/visible-node output and pagination |
| `diagnostics.mjs` | Sanitized failure classification without page-bearing exception text |
| `*.test.mjs` | Serialization/privacy regressions and disposable Chrome fixtures |
| [`../src/browser/addon.rs`](../src/browser/addon.rs) | Runtime resolution, manifest, verified downloads and installation |
| [`../src/browser_cli.rs`](../src/browser_cli.rs) | Prepare, status and remove commands |
| [`../build.rs`](../build.rs) | Embeds helper sources and vendored dependencies |

See the [helper spec](browser-helper.spec.md),
[runtime spec](../src/browser/browser.spec.md),
[add-on design](../../design/browser-addon.md), and
[Phase 3r](../../plan/bud-owned-browser/phase-3r-browser-addon.md) for contracts,
decisions and remaining release acceptance.


## Development REPL experiment

Phase 2 defaults to REPL on a non-production service; no environment setting is
required. Build the matching daemon, prepare its
helper with the checkout command above (or re-extract with `bud browser prepare`),
then restart the daemon. It advertises REPL support only if all new helper modules
are present. Set `BUD_BROWSER_TOOL_MODE=tools` to compare the existing tool family.
Production retains the existing family until the planned cutover.

The agent gets `browser_exec` plus the existing handoff tool. A typical cell:

```js
var tab = await browser.tabs.open('https://example.com');
var snapshot = await tab.snapshot();
repl.write(snapshot.nodes.filter(n => n.role === 'link').slice(0, 5));
```

Later cells can filter `snapshot` without reading the page again. Screenshots are
explicit: `await repl.emitImage(await tab.screenshot())`. `tabs.open` ensures and
navigates the current workspace page. `tabs.create(url?)` creates an additional
owned tab; `tab.select()` selects it in the viewer; `tab.close()` closes only that
tab and preserves variables. After a snapshot, use
`tab.getByReference(reference)` or `tab.getByRole(role, {name, exact:true})`, then
`click()`, `fill(text)` or `focus()`. `tab.insertText(text)` requires focus on that
tab; `tab.scroll(delta_y)` requires a current observation. Recreate element handles
after a new snapshot, navigation or Return; old handles cannot be revived.
New modules `repl-worker.mjs`, `repl-api.mjs`, `repl-artifacts.mjs` are embedded in
the daemon add-on. The worker executes trusted host JavaScript, not sandboxed code.
See the [plan](../../plan/bud-owned-browser/repl-implementation.md) for limits,
private-control behavior and outstanding real-agent acceptance.
