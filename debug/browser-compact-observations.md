# Debug: browser observation context growth

## Environment and reproduction

Local macOS arm64, Chrome for Testing 152.0.7977.82, Node/Playwright Core 1.63.0.
Thread `e6857eba-a908-493b-846e-e58d12e5fa3b` used GPT-5.6 Luna.
Repeated snapshot calls while browsing Hacker News rapidly expanded model context.
Read-only inspection found 23 snapshots / 1,006,053 stored characters, roughly 98%
of tool-result text; provider input peaked at 373,974 tokens. Original history was
not modified. See [Phase 3f](../plan/bud-owned-browser/phase-3f-compact-browser-observations.md).

## Observations and diagnosis

Each result repeated node data as text; long reference namespaces appeared in both.
The 24 KiB budget counted nodes only, before text/envelope. Empty wrappers expanded
hierarchy and output. Scrolling did not advance document snapshot pagination.

## Implemented fix

Capability-gated compact observations use one representation, transparent empty
presentational wrappers, short observation-qualified references and an 8 KiB helper
result budget. The final service tool result has a 12 KiB guard. Pagination counts
UTF-8 and escaping, retains ancestor context and never silently skips oversized
nodes. Visible DOM sends nodes/boxes only, with explicit viewport coverage. Existing
metadata, screenshot, private authority, exact locators and freshness checks stay.
Legacy callers use the same semantic engine with the existing serialization.

## Validation — 2026-09-15

- `node --test bud/browser-helper/*.test.mjs` with explicit CfT executable:
  6 passed, no skips; compact and legacy real-browser fixtures, reference click,
  exact actions, scope, pagination, mode mismatch, expiry and field-value redaction.
- Fixed 30-story HN-like fixture, complete output including all pages:
  legacy 39,333 bytes → compact 7,484 bytes (81.0% reduction), one page each.
  `tiktoken` / `o200k_base`, compact JSON for both complete outputs:
  18,338 → 2,874 tokens (84.3% reduction). This is a tokenizer comparison, not a
  claim about exact provider billing or context for every model/page.
- `cargo test --manifest-path bud/Cargo.toml --lib browser::` with CfT:
  13 passed, including private handoff/media, reconnect and stale authority.
- Focused service broker/browser-tools/observation-budget tests:
  10 passed, one opt-in prototype test skipped. Mixed-capability command forms,
  final envelope size and exact transcript replay covered.
- Web observation renderer: 2 passed, covering old/compact text, node-only visible
  DOM, lazy expansion, authenticated image paths and expired images.
- Service TypeScript build and web TypeScript build passed. Rust formatting and
  diff whitespace checks passed.

The mobile snapshot detail path already reads `data.observation.text`; no mobile
source change is needed for compact text. Visible DOM remains available in generic
payload detail; web adds lazy node-only detail rendering. Device visual validation
and the actual-agent repeated browsing acceptance remain manual follow-up.

No latency improvement claim: fixture wall-clock test time includes browser startup
and actions, not an isolated benchmark. Broader large-site p50/p95/memory measurement
remains a release validation item. No payload logging, database migration, production
deployment or user daemon restart was performed.

## Actual-agent follow-up — 2026-09-15 Pacific

Reviewed thread `d34e4e7b-3571-4770-be5e-fac926330eca` after two requests
covering six stories. All successful snapshot/visible-DOM results used compact_v1.
The earlier thread now has nine requested stories; compare its first two batches
only, rather than its full peak, for the six-story comparison:

| Metric | Earlier first two batches | New two batches |
| --- | ---: | ---: |
| Peak provider input tokens | 337,870 | 91,858 |
| Model calls | 41 | 50 |
| Tool calls | 39 | 48 |
| Successful snapshot/visible-DOM results | 17 | 21 |
| Observation characters | 760,138 | 164,010 |
| Observation tokens (o200k_base) | 314,600 | 59,934 |

These are different articles/access conditions, not a controlled benchmark. The
new run successfully paginated the HN listing with six continuation calls, but
article snapshots remained partial. Two invalid action arguments and two stale
observation uses recovered; both visible-DOM reads after scrolling reported
scroll_y=104. WSJ restricted access and Jiga 403 added four searches and three
web reads. Follow-ups: inspect argument failures, repeated viewport behavior and
partial-reading claims. This validates real-agent compact output and pagination,
not complete article reading or all original acceptance cases.
