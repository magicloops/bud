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
offers a daemon restart. After that opt-in, daemon startup automatically upgrades
the embedded helper before advertising readiness. Use
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
reload their modules. For embedded helpers, rebuild and restart; startup installs
and validates that binary's bundled helper automatically for existing managed
installations. `browser prepare` is only needed for initial opt-in or Node/Chrome
installation or repair. Helpers are cached by archive SHA-256, so different dirty
builds cannot reuse stale code merely because their Git version labels match.
Startup never downloads dependencies, switches browsers, or modifies profiles.
A failed upgrade preserves the manifest and disables browsing for that startup;
terminal startup continues. Development overrides are never replaced.

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
host caveats without installing anything. Restart for a helper-only mismatch; use
`browser prepare` to repair missing/incompatible Node or Chrome. The readiness probe is headless;
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
required. Build and restart the matching daemon; already-enabled managed helpers
upgrade automatically. For checkout overrides, use the preparation command above. It advertises REPL support only if all new helper modules
are present. Set `BUD_BROWSER_TOOL_MODE=tools` to compare the existing tool family.
Production retains the existing family until the planned cutover.

The agent gets `browser_exec` plus the existing handoff tool. A typical cell:

```js
var tab = await browser.tabs.open('https://example.com');
var snapshot = await tab.snapshot();
snapshot.nodes.filter(n => n.role === 'link').slice(0, 5);
```

Later cells can filter `snapshot` without reading the page again. Screenshots are
explicit: `await repl.emitImage(await tab.screenshot())`. `tabs.open` ensures and
navigates the current workspace page. `tabs.create(url?)` creates an additional
owned tab; `tab.select()` selects it in the viewer; `tab.close()` closes only that
tab and preserves variables. After a snapshot, use
`tab.getByReference(reference)` or `tab.getByRole(role, {name, exact:true})`, then
`click()`, `fill(text)` or `focus()`. Native clicks use normal Playwright
actionability; choose the actual observed control, including unnamed
`cursor:"pointer"` nodes. For a deliberately chosen exposed point on that same
element, `await handle.geometry()` returns current CSS padding-box `{width,height}`
and `await handle.click({position:{x,y}})` accepts finite, nonnegative coordinates
inside those bounds. Zero-sized/inline client boxes do not support explicit
positions. Coordinates are not screenshot pixels; hit checks still apply.
Failures can have effects: inspect before reconsidering, never replay blindly. `tab.insertText(text)` requires focus on that
tab. `tab.scroll(delta_y)` sends one wheel request to this live owned tab without
a snapshot (integer −10000…10000). It may race navigation; observe afterward
before using page content. Closed/foreign targets reject without reopening or
retargeting; uncertain input is never automatically repeated. Recreate element handles
after a new snapshot, navigation or Return; old handles cannot be revived.
New modules `repl-worker.mjs`, `repl-api.mjs`, `repl-artifacts.mjs`, `repl-snapshot.mjs` are embedded in
the daemon add-on. The worker executes trusted host JavaScript, not sandboxed code.
See the [plan](../../plan/bud-owned-browser/repl-implementation.md) for limits,
private-control behavior and outstanding real-agent acceptance.


Each cell shares an **8 KiB UTF-8 output budget** across console and final completion values.
For a deliberately larger result, call `repl.setOutputBudget(32768)` before the
cell's first output (integer 1024–32768 bytes). It resets for the next cell.
Full observations remain local up to 2 MiB regardless of this output budget.

Overflow keeps complete preceding writes and returns `truncated:true` with a
local `output_artifact`; a clearly marked incomplete excerpt is included when
space remains, without failing the browser action. Filter retained variables in a follow-up cell, or read the exact
returned artifact path with `repl.files.read(path)`. Captures can themselves be
truncated at 1 MiB. They contain formatted text, not necessarily JSON; only parse
a complete capture that was explicitly serialized as JSON. Do not repeat browser
actions to recover omitted output. See [Phase 4 measurements](../../debug/browser-repl-phase4.md).


Console calls and the final non-undefined result share one output path. A final
`console.log(...)` prints once; logging and then evaluating the same value prints
twice intentionally. Declarations/undefined are silent. False, zero, null and the
empty string are displayed. Assignments/blocks follow native Node completion
semantics; a trailing semicolon does not suppress output. End with `void 0` for
silence. `repl.write` has been removed without an alias.

Objects use Node inspection with depth 5, at most 100 array entries and 10,000
characters per inspected string; getters and custom inspection hooks are disabled.
Elision is visible in the preview, independent of the byte-budget `truncated` flag.
Use `console.log(JSON.stringify(selected))` when exact JSON evidence is needed.
Direct binary values display a size notice, never an implicit image. Formatting
failures produce a short notice rather than failing a completed browser action.
Completion output is appended only after tracked calls drain successfully and is
subject to the existing authority/delivery fence. See [Phase 5](../../plan/bud-owned-browser/repl-phase-5-standard-output.md).


## Compare observations with agent output

For a local debugging run, start the **daemon** with:

```sh
BUD_BROWSER_TRACE=1 cargo run --manifest-path bud/Cargo.toml -- --terminal-enabled
```

Keep your usual daemon flags/environment (including headed mode). Rebuild and
prepare the matching helper first, as described above. No service setting is
needed. Tracing is off unless the variable is exactly `1`.

Each completed cell logs `Browser observation trace saved` with a request ID and
local `trace-*.json` path. Compare these stages using `operation_id`:

- `upstream_snapshot`: the same Playwright tree used for this observation, before
  Bud flattening/visibility filtering. Field values/field descendants are redacted.
- `operation_result`: the snapshot/visible-DOM/evaluate JSON actually delivered to
  the REPL, plus its request, size, hash and timing. Other operations record only
  outcome metadata; screenshot pixels are not copied.
- `formatted_output`: console and final-expression text after inspection formatting
  but before the inline byte budget. Includes attempted byte count, capture
  truncation, output budget and formatter settings.
- `daemon_result`: ordinary cell result, without diagnostic fields. Match
  `correlation.request_id` to the service's persisted `browser_exec` tool payload
  to see what was delivered; that payload also has the model `call_id` and code.
  Service authority checks may still withhold a daemon result. This trace is not
  a dump of provider requests or proof that the provider consumed the result.

Trace payloads never enter the supported REPL API, public protocol or model
context. They add no extra page reads and do not increase agent output budgets.
Arbitrary evaluate/console results and page text/URLs can contain sensitive data;
only enable this when intentionally collecting local diagnostics. The private
0700 worker directory contains 0600 trace files, with at most 64 files/64 MiB per
worker. Normal worker reset/shutdown removes them; an abrupt process kill can
leave temporary files, which should be removed after review. Copy wanted traces
before restarting or reaching the retention cap.

Raw/result content is capped at 1 MiB per value, formatted output at the existing
1 MiB capture limit, and stage records at 4 MiB/128 entries per cell. Check
`truncated`, `bytes`, `unavailable`, and `omitted_stages` before concluding content
was absent. Content strings marked truncated need not be parseable JSON. Hashes
refer to the full Rust-serialized returned JSON, not the excerpt. Errors report
canonical codes, not raw page-bearing exception messages. Interrupted or already
unauthorized cells publish no trace; authority loss during trace I/O withholds
output and retracts that file (cleanup failure logs a warning). Prior authorized
traces remain until normal retention/cleanup; this is not a host-code sandbox.


### Compact snapshot output (Phase 7b)

```js
var tab = await browser.tabs.current();
var snapshot = await tab.snapshot();
console.log(snapshot.format());
// Or select original node objects while retaining exact full data locally:
console.log(snapshot.format({nodes: snapshot.nodes.filter(n => n.role === 'link')}));
// Use only an observed short ref, bound to this snapshot:
// await snapshot.getByReference('e2').click();
// snapshot.url('u1') resolves an observed URL alias without dropping query/fragment.
```

`format` is local: no new capture or page action. `maxBytes` optionally bounds the
view (512–32768); it always respects remaining cell output space. Increase the
cell budget explicitly before output when a larger view is needed. The view identifies
source coverage and reports omitted records/URL definitions. It does not change
`nodes` or make a partial capture complete. Refresh invalidates action refs, while
retained data remains historical evidence. Short refs from another snapshot cannot
be passed to a different snapshot expecting the same element.

Overflow now retains preceding writes plus an explicitly incomplete text excerpt
when space remains. Check `truncated` and bounded `output_artifact` metadata; never
parse an excerpt as complete JSON or repeat browser actions to recover output.
Prefer selection from retained data or a bounded artifact excerpt over reprinting
an entire oversized artifact. The default is restored to 8 KiB after the live 16 KiB comparison. Explicit expansion still reaches 32 KiB. See [results](../../debug/browser-repl-phase7b.md).
Rebuild, prepare the matching add-on and restart workers alongside updated service
guidance to activate this API. No viewer build or database migration is required.
