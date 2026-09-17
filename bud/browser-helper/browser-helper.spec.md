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
  Reference locators retain the observed iframe ancestry; a document-root selector
  prevents Playwright from routing cached references through obsolete frame IDs.
  Scoped observations inherit their source frame. No mutation is retried.
- `compact.mjs`: deterministic tree normalization and UTF-8-budgeted text/node serialization with ancestor context. Removes empty row leaves and redundant single-cell table nesting while preserving real/ambiguous table structure. Text uses one-space depth and `[opaque-reference]` annotations; identities and map lookup are unchanged.
- `compact.test.mjs`: structure/state preservation (including blank cells and named containers), deep hierarchy, pagination, Unicode and limits.
- `engine.test.mjs`: disposable Chrome fixtures, legacy/compact size comparison, sanitizer, scope and reference regressions.
- `package.json` / `package-lock.json`: reproducible runtime dependency.

One snapshot per thread workspace/helper, 60-second lifetime, 2 MiB retained nodes.
Phase 3k workspaces share one regular Chrome context for cookies/site storage but
have independent helpers/reference maps. Rust checks target ownership before every
helper call; observing in one thread cannot invalidate another thread’s snapshot. Negotiated
compact snapshots return text only; visible DOM returns nodes/boxes only. The full
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

Setup: `npm ci --ignore-scripts --prefix bud/browser-helper` from repo root.
Source builds find `main.mjs` relative to the Cargo manifest. Installed builds
must set `BUD_BROWSER_HELPER` to the deployed helper and supply Node on PATH or
`BUD_BROWSER_NODE`. Packaging this optional runtime into release installers is
still release work. Missing helper disables browser readiness, not terminals.

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
