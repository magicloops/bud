# Private browser semantic helper

Node 22+ and pinned Playwright Core 1.63.0 provide structured accessible DOM
snapshots and exact semantic actions against Rust's managed Chrome for Testing.
No browser is downloaded or launched by this helper. The semantic entrypoint accepts frame-scoped evaluation through the guarded REPL
bridge, never raw CDP from tool arguments. A separate REPL worker executes trusted JavaScript. The Rust
browser manager owns serialization and authority for both paths.

- `README.md`: add-on setup, checkout development, tests, dependency pins,
  diagnostics and removal, with links to the Rust installer/runtime.
- `main.mjs`: serial, private stdio adapter; loopback CDP bootstrap, bounded
  commands and canonical errors without raw page-bearing exception text.
- `engine.mjs`: snapshot hierarchy, value exclusion, visible geometry, metadata,
  exact role/name and reference targeting, fill and wheel. Uses Playwright's
  `ariaSnapshotJSON({mode:'ai'})` and `aria-ref` selectors from that snapshot.
  Plain string children become ordered text nodes at their source depth, without
  action references or invented geometry. Field text and descendants remain
  excluded. Checked/pressed states preserve reported booleans and `mixed`;
  absent upstream states are not inferred.
  Reference locators retain the observed iframe ancestry; a document-root selector
  prevents Playwright from routing cached references through obsolete frame IDs.
  Scoped observations inherit their source frame. Bud never replays mutations;
  Playwright may internally retry actionability/input within a click invocation.
- `compact.mjs`: deterministic tree normalization and UTF-8-budgeted text/node serialization with ancestor context. Removes empty row leaves and redundant single-cell table nesting while preserving real/ambiguous table structure. Text uses one-space depth and `[opaque-reference]` annotations; identities and map lookup are unchanged.
  Pressed states participate in wrapper preservation and text rendering, including
  false/mixed. Inline text survives compaction and existing byte/node limits.
- `compact.test.mjs`: structure/state preservation (including blank cells and named containers), deep hierarchy, pagination, Unicode and limits.
- `engine.test.mjs`: disposable Chrome fixtures, legacy/compact size comparison, sanitizer, scope and reference regressions.
  Fidelity regressions cover mixed inline text, toggle states, scoped/full/visible
  snapshots and continued exclusion of field values.
- `package.json` / `package-lock.json`: reproducible runtime dependency.

One snapshot per thread workspace/helper, 60-second lifetime, 2 MiB retained nodes.
Phase 3k workspaces share one regular Chrome context for cookies/site storage but
have independent helpers/reference maps. Rust checks target ownership before every
helper call; observing in one thread cannot invalidate another thread’s snapshot. Negotiated
compact snapshots return text only; visible DOM returns nodes/boxes only. The compact
helper observation is limited to 32 KiB, reserving space for the service envelope.
Legacy requests retain 24 KiB node pages plus text through the same engine.
Compact reference namespaces combine a random helper-lifetime prefix and monotonic
observation counter; exact maps and document/epoch fences remain authoritative.
Continuation format/mode must match its retained snapshot. Oversized single nodes
report browser_observation_limit; they are never skipped. New snapshot, navigation, disconnect or authority
invalidation retires references. Continuations read retained nodes, not a new
page; each call checks the current document. Scope uses an observed reference.
Closed shadow roots/inaccessible frames are explicitly outside coverage.
The helper's operation deadline is eight seconds, with a 128 MiB V8 heap limit; interruption kills the helper
and poisons the adapter, never replays a mutation.

Setup: `npm ci --ignore-scripts --prefix bud/browser-helper` from repo root,
then build the daemon: `bud/build.rs` packs the sources plus vendored
`node_modules` into the binary, and `bud browser prepare` unpacks them to
`<base_dir>/browser/helper/sha256-<archive digest>/` next to a pinned managed Node
(Phase 3r). Installed daemons never need `npm` or a host Node. A checkout can
skip the download path with `bud browser prepare --helper-dir bud/browser-helper
--node $(which node)`; `BUD_BROWSER_HELPER`/`BUD_BROWSER_NODE` (with
`BUD_BROWSER_EXECUTABLE`) remain a logged development override. The pinned
playwright-core and its `browsers.json` also define the daemon's managed Chrome
for Testing build and system-browser version floor via
`scripts/browser-addon-pins.mjs`. Missing helper disables browser readiness, not terminals.

See [Phase 3d](../../plan/bud-owned-browser/phase-3d-agent-observations-and-targeting.md).

Reliability fixtures additionally exercise explicit identity-qualified reference
clicks, stale observation rejection and wheel requests at a bounded page bottom.
Repeated viewport offsets alone do not prove dropped wheel input; dispatch
acknowledges the request, not animation completion.

BFCache-enabled Chrome coverage verifies retained page state, fresh reference clicks
after Back, invalidated-reference rejection, and exact iframe/scoped targeting.
This is helper-local; wire shapes, capability negotiation and ownership fences
are unchanged. Restart an already-running helper (or daemon) to load the fix.

[Phase 3i](../../plan/bud-owned-browser/phase-3i-snapshot-structure-compaction.md) and
[measurements](../../debug/browser-snapshot-structure-compaction.md) document the
serializer follow-up. Nested 30-story fixture drops from three pages to two;
all-30-in-8-KiB is not claimed. Restart the helper/daemon to load this change.

Temporary failure diagnostics (`diagnostics.mjs`, privacy regression in `diagnostics.test.mjs`) send only a fixed stage index and boolean Playwright error signals over private helper stdio. Rust logs these without returning diagnostics to the model; raw exception text is never emitted.

## Native click targeting and link destinations — Phase 7

`engine.mjs` preserves upstream `cursor:"pointer"` as a hint, without inventing
roles or a clickability guarantee. Full, scoped, visible and compact observations
retain hinted nodes and their real references, including unnamed wrappers.
Field values remain excluded; exact link URLs, hierarchy and budgets are unchanged.

Clicks resolve one exact element, recheck observation/document identity and invoke
native Playwright click with a three-second budget. The randomized point sampler
and its custom descendant/media/transform exclusions are removed. Normal scrolling,
visibility, stability and hit checks remain. Bud never forces, substitutes another
element or retries an uncertain mutation; Playwright may retry internally.

`repl-api.mjs` element handles add `geometry()` returning current CSS padding-box
`{width,height}` from the same element/frame, and optional
`click({position:{x,y}})`. Positions must be finite, nonnegative and inside current
bounds. No caller-supplied force/timeout or unrelated options. These methods retain
the same observation and authority fences; geometry is not a hit-test guarantee.
Zero-sized/inline client boxes cannot be used for explicit positions; native
unpositioned clicks remain available. Native failures remain uncertain, not claims
that no input occurred. The obsolete `browser_click_blocked` code is removed.

- `click.test.mjs`: disposable Chrome disclosures, pointer preservation, layered
  cards versus media, exact positions/bounds, stale identity, native controls,
  clipping/transforms/zoom, slots/frames/overlays and hover/down effects.
- `diagnostics.mjs` / `diagnostics.test.mjs`: fixed failure stage/boolean flags;
  sampler-only counts/points are removed. No raw page text or exceptions in logs.

Link URLs retain query strings, fragments and relative forms. Compact text renders
one escaped `url=...`; visible nodes retain `url` without duplicate text. URL/hint
bytes count toward existing output bounds and frozen continuation pages.
See [Phase 7](../../plan/bud-owned-browser/repl-phase-7-actionability.md) and
[validation](../../debug/browser-repl-phase7.md).

## Persistent REPL runtime foundation

- `repl-worker.mjs`: separate killable worker using the managed Node's built-in
  REPL evaluator, persistent bindings/top-level await/imports, native completion
  values and bounded console output and private JSON stdio. No inspector port.
  `browser.operation` is an internal bridge bootstrap, not the final model API.
- `repl-worker.test.mjs`: persistent bindings, partial exceptions, module imports,
  syntax/rejected-await recovery, UTF-8 bounds, isolated workers, tracked
  unawaited calls and rejection of late callbacks/output.

Each worker has a 128 MiB V8 old-space limit (not a total RSS limit), 64 KiB code
and an 8 KiB default text output budget (32 KiB explicit ceiling); host supervision enforces a 30-second maximum
cell deadline. Successful non-undefined completion values append after tracked calls drain. `var` supports repeated declarations;
lexical declarations follow Node REPL rules. Console/stdout/stderr writes share
the output budget. Errors are bounded separately to 2 KiB. Oversized text gets a local captured-output file; images require explicit emission.

Node's default REPL routes evaluation exceptions through `REPLServer._domain`,
not solely its eval callback. This version-pinned dependency is isolated in the
worker and exercised on managed Node 24.21.0; rerun these tests when repinning.
No source rewriting or custom JavaScript parser is introduced. AsyncLocalStorage
cell identity prevents old timers from joining later cells; supported calls drain
before completion. Any failed bridge call conservatively marks the cell failed,
even when caught locally. Trusted Node code can still use arbitrary host APIs.

The worker receives no inherited environment except PATH. It uses its own process
and JavaScript heap; killing it does not kill the semantic helper or undo browser
effects. The source is included in the existing helper archive/build watch list.
See [plan](../../plan/bud-owned-browser/repl-implementation.md).


## REPL selective observations — Phase 2

- `repl-api.mjs`: typed workspace tabs/current/get/open, navigation/info, full/scoped
  structured snapshots, visible DOM, frame evaluation and viewport screenshots.
  Open ensures the current workspace page; it is not additional-tab creation.
- `repl-artifacts.mjs`: UTF-8 truncation and private worker-local text/JSON files:
  16 files maximum, 1 MiB each, oldest-first eviction, opaque relative names,
  no symlink traversal. Runtime destruction deletes the directory.

Final values and console share the per-cell text budget; overflow retains at most 1 MiB in a
referenced file. `repl.files.write/read` explicitly store/recall bounded data.
`repl.emitImage(await tab.screenshot())` accepts captured screenshot buffers and
uploads at most two images per cell. Image bytes never enter ordinary tool text.
Full snapshot nodes retain hierarchy/identity/coverage up to 2 MiB locally; this
is independent of compact observation output. Evaluation returns JSON up to 2 MiB
from the main frame or a freshly enumerated owned frame, without Node lexical
capture; it can mutate and never retries. Private helper replies allow 16 MiB for
JSON escaping; the model-facing envelope remains bounded separately.
Worker tests cover retained large snapshots, recall/eviction and multiple images;
real Chrome daemon tests cover owned frame evaluation and local-only follow-ups.

## REPL interactions — Phase 3

`repl-api.mjs` adds reference/exact role-name handles with click/fill/focus,
scroll and guarded committed text. Handles capture the latest observation ID at
construction; refreshing a snapshot cannot revive a retained handle. The existing
engine still checks document, TTL, unique match and bounded click actionability.
`tabs.create` creates an additional owned tab; `tab.select` is logical viewer
selection, and `tab.close` closes one tab without destroying the worker. Open
retains ensure-and-navigate semantics. No forced click or navigation fallback.

The engine allows one second for newly created targets to enter Playwright's
page inventory after a create acknowledgement on Rust's independent CDP channel.
Only inventory discovery waits; mutations never replay. The daemon's live REPL
fixture covers immediate new-tab metadata, stale handles, forms, partial effects,
cross-workspace rejection, tab close/reopen and private Return using the facade.

Managed helper identity is the embedded archive SHA-256, independent of the daemon
Git label. Preparation installs changed bundles side by side; daemon resolution
rejects an old managed helper until preparation with the matching binary. Rebuild,
prepare, then restart after helper edits. Explicit checkout overrides still bypass
managed identity checks. Existing profile data and sign-ins are unaffected.


## Phase 4 output controls

The default is 8 KiB UTF-8 per cell. `repl.setOutputBudget(bytes)` explicitly sets
1024..32768 bytes before the cell's first output; the next cell resets to the default.
Phase 7b supersedes whole-write omission: overflow preserves preceding writes and
adds a bounded, explicitly incomplete UTF-8 excerpt when space remains, with
`truncated:true` and the existing local `output_artifact`. Clipped output is never
presented as complete JSON; output size is not an execution failure. The artifact can itself
be incomplete at 1 MiB; callers check its truncation flag before parsing JSON.
Local observation materialization stays at 2 MiB. No browser action is replayed
for output recovery. Worker tests cover budget reset, shared console output,
Unicode, marked overflow excerpts, local recall and varied structured extractions.
See [validation](../../debug/browser-repl-phase4.md).


## Standard output — Phase 5

`repl.write` is removed without an alias. Console and native evaluator completion
use one formatter/capture path, with inspection depth 5, 100 array entries and
10,000 characters per inspected string, getters/custom inspection disabled.
These previews are not JSON; inspection elision is separate from byte truncation.
Direct binary values emit a size notice; images still require `repl.emitImage`.
Formatter failures emit a bounded notice, not an action-retry error. Failed cells
keep earlier console output but suppress the final value. Completion remains
inside the active AsyncLocalStorage cell and existing daemon authority fence.
Tests cover ordering, silence, false/zero/null/empty string, cycles, BigInt,
getter safety, revoked proxies, marked overflow, operation draining and
single execution. See [validation](../../debug/browser-repl-phase5.md).


## Opt-in observation tracing

`engine.mjs` optionally adds a private `_bud_trace` from the exact upstream
snapshot before filtering, redacting field text/value/descendants. It performs no
second observation; diagnostic copy failure becomes `unavailable`, not an action
failure. Rust strips this field before the worker receives its normal snapshot.
`repl-worker.mjs` sends `_trace_output` only when the daemon's internal execute
flag requests it, using existing bounded formatted capture (including omitted
inline output) and formatter settings. Rust strips it from the public result.
`observation-trace.test.mjs` covers same-capture correspondence, redaction, bounds,
and a live Chrome collapsed-disclosure versus evaluate extraction fixture.
Worker tests verify opt-in isolation and overflow. No new agent API/dependency.
See [enablement/retention](README.md#compare-observations-with-agent-output) and
[plan](../../plan/bud-owned-browser/repl-observation-tracing.md).

## Compact retained snapshot views — Phase 7b

`repl-snapshot.mjs` adds non-enumerable `format({nodes?, maxBytes?})`,
`getByReference(shortRef)` and `url(alias)` methods to full snapshot results.
JSON/`nodes` remain exact. The pure view emits identity/coverage once, ordered
hierarchical records, short snapshot-bound refs and factored exact URLs. Selected
nodes must belong to that capture; omitted records/oversized URL definitions are
explicit. The view always respects remaining cell output space; explicit view budgets
are 512–32768 bytes and cannot expand the cell budget. Whole records fit or are omitted with counts. Source coverage,
view omission, JS inspection and collector overflow remain distinct.

Short handles close over original target/observation evidence and use the existing
action path; there is no global alias map or new authority. URL lookup preserves
queries/fragments and relative spelling. Historical data does not authorize actions.
`repl-snapshot.test.mjs` covers fidelity, Unicode, URL factoring/selection, immutable
reference binding and real Chrome stale-handle rejection. Build/archive watch and
REPL readiness include the new module. See [Phase 7b validation](../../debug/browser-repl-phase7b.md).
