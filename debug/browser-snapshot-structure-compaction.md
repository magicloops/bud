# Debug: browser snapshot structure overhead (Phase 3i)

## Environment and reproduction

Local macOS arm64, pinned Playwright Core 1.63.0, Chrome for Testing 151.0.7922.34.
Synthetic fixtures only; no LLM or DB required for validation.
See [Phase 3i](../plan/bud-owned-browser/phase-3i-snapshot-structure-compaction.md)
and the [actual-agent budget comparison](browser-observation-budget-32k.md).

The recorded HN snapshot spent 38% of text bytes on references and 26% on spaces.
Probe of ariaSnapshotJSON confirmed that ordinary layout and data tables both
arrive as table/row/cell nodes; no reliable layout flag is present in this output.
Removing all unnamed tables or cells would risk losing real table relationships.

## Implemented fix

Keep the existing sanitizer, reference identities/maps and output limits. Normalize
in the helper before pagination: prune empty stateless row leaves and collapse only
an unnamed stateless sole-child table → row → cell → table chain. Preserve blank
data cells, populated rows, named/stateful groups and ambiguous table semantics.
Use one space per retained depth (without the prior 24-level visual clamp) and
`[opaque-reference]` instead of `[ref=opaque-reference]`. Namespaces remain intact;
no bare node aliases, service rewrites, additional browser queries or new caches.

## Measurements

Same synthetic page and sanitized nodes, identical fixed reference prefix and
metadata, full compact output including all continuation envelopes. Baseline is
pre-change compact.mjs, not the much larger legacy dual representation.

| Metric | Before | After |
| --- | ---: | ---: |
| Nested 30-story fixture serialized JSON bytes | 18,868 | 13,380 |
| o200k_base tokens of that JSON | 5,288 | 4,497 |
| Continuation pages (including first) | 3 | 2 |
| Normalized nodes | 454 | 451 |
| Mean normalization time, 1,000 iterations | 0.055 ms | 0.152 ms |
| Existing simpler 30-story live fixture bytes | 7,484 | 6,266 |
| Simpler fixture pages | 1 | 1 |

The nested fixture retains ranks, story links, domains, upvotes, authors, age,
hide and comments links. Bytes fall 29.1%, tokens 15.0%. Reference entropy and real
page structure remain; the 40% initial target and all-30-in-8-KiB aspiration are
not met. Avoid destructive flattening to force those numbers. Normalization adds
bounded arrays/sets linear in node count and no retained cache; the existing
snapshot memory/node bounds are unchanged. Timing is a microbenchmark, not agent
latency or a peak-memory measurement. New live result IDs/metadata yield slightly
different bytes (13,492 in the test output).

## Validation

`BUD_BROWSER_EXECUTABLE='/Users/adam/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' npm test`
from `bud/browser-helper`: 12/12 pass, none skipped. Covers all thirty fixture story
links, clicking ranks 3/16/30, scope, Unicode pagination, explicit huge-node error,
blank cells and headers, stateful/named containers, deep nesting, duplicate names,
unnamed controls, visible geometry, field-value exclusion, stale references without
observation IDs, expiry, navigation/Back, and iframe targeting.

Service executor forwards compact text with an envelope byte check; daemon helper
adapter transports JSON opaquely; web observation renderer displays text verbatim.
No production consumer was found parsing the old `[ref=...]` text annotation.
Legacy helper output remains unchanged; existing stored transcripts remain valid.

An initial validation invocation ran `npm test` with the same executable/benchmark
environment from the repo root and failed with `npm error Missing script: "test"`.
Corrected working directory to `bud/browser-helper`; no dependency change needed.
A test append also initially used the repo-relative path from the package directory
(`zsh: no such file or directory: bud/browser-helper/engine.test.mjs`); rerun using
the package-relative filename, then reran the complete suite successfully.

Actual-agent deeper-reading/context comparisons remain manual acceptance after
restarting the daemon/helper. No service restart, migration, or mobile build is
required for this serializer-only change. No user browser sessions were restarted.
