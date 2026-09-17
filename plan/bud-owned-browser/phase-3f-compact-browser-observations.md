# Phase 3f: compact browser observations

Status: implemented locally; automated validation and actual-agent compact output/pagination confirmed. Reading-quality and broader acceptance follow-ups remain. 2026-09-15.

Follow-up: [Phase 3i: snapshot structure compaction](phase-3i-snapshot-structure-compaction.md) implements further layout/reference savings with measurements at 8 KiB and a subsequent selected default of 32 KiB. Automated validation passed; actual-agent acceptance pending.

## Context and evidence

Follow-up to [Phase 3d](phase-3d-agent-observations-and-targeting.md).
Read-only inspection of local thread `e6857eba-a908-493b-846e-e58d12e5fa3b`
("Hacker News Haiku Request", GPT-5.6 Luna) found:

| Result type | Count | Stored result characters |
| --- | ---: | ---: |
| Snapshot | 23 | 1,006,053 |
| Browser action | 21 | 10,558 |
| Page metadata | 6 | 3,430 |
| Browser open | 1 | 555 |
| Web read | 1 | 2,170 |

Snapshots account for about 98% of tool-result text. Recorded provider input grew
from 12,429 to a peak of 373,974 tokens. The first snapshot was followed by about
19,600 additional input tokens; that delta includes surrounding provider items,
not an isolated tokenizer measurement. Cached input still occupies context.

The first snapshot has 265 nodes, 143 without names or text. It includes both a
`nodes` array and a rendered `text` copy, repeating UUID-prefixed references in
both. The helper budgets 24 KiB of node JSON before adding rendered text and the
result envelope; typical results approach 46,500 characters. Scrolling followed
by another document snapshot repeats the first page of nodes. Three calls used
continuations; none requested `visible_dom` or a scoped snapshot.

This is structured DOM pagination, not raw HTML or continuous screenshot input.
The problems are representation overhead and repeated broad observations. We
should fix those before adding context-history eviction or a new browser API.

## Objective and acceptance criteria

Reduce model-visible browser output while preserving evidence and reliable actions.
Retain the five tools and existing private-control lifecycle.

- One representation per observation: compact text for `snapshot`, structured
  nodes/boxes for `visible_dom`; no duplicate text/node encoding in either mode.
- Useful headings, reading order, links, controls, state, list/table relationships
  and content remain accessible. No HN-specific filtering or title-only shortcut.
- Short references remain observation-bound; old references never resolve to a
  different node after refresh, navigation, restart or takeover.
- Continuations expose all retained content without repeats or silent omissions.
- Initial target: at least 70% fewer serialized bytes and model tokens for the
  complete fixed HN-like fixture, including all continuation pages. Measure with
  the same tokenizer and fixture before/after; this is a target, not a result.
- Provisional maximum: 12 KiB for the complete serialized text observation result,
  including metadata and tool envelope. Verify the actual persisted/provider-facing
  result, not just an internal array. Tune only with recorded fixture evidence.
- Actual agent identifies stories 3, 4 and 16, opens the requested observed links,
  and verifies destinations without manually supplied URLs or retrieval fallback.

## Recommended design

### 1. Compact at the source; persist what the model receives

Use the existing Playwright helper as the single semantic engine. Keep its bounded
internal snapshot and reference map; change the result serializer rather than
adding a second extractor or a provider-specific compression layer.

For `snapshot`, return a small metadata envelope and one indented `text` value.
For `visible_dom`, return only bounded nodes with necessary geometry and metadata.
Keep `page_info` and screenshot behavior unchanged. Tool calls explicitly request
observations; actions do not automatically return page content.

Store the same compact tool result for live execution, transcript, continuation
and replay. Do not retain duplicate representations just for Show payload. Web and
mobile should consume text for snapshots and nodes for visible DOM, tolerating
older stored results. Inspect both clients before removing a field they use.
Historical records remain immutable and readable; this phase reduces new output.

Illustrative snapshot text:

```text
heading "Hacker News"
link "new" [ref=s7:e2]
row
  text "3."
  link "Example third story" [ref=s7:e19]
  text "42 points"
```

The exact short observation token is an implementation detail, not the literal
`s7` above. Keep document/target/observation identity once in the envelope.

### 2. Remove structural noise without losing meaning

Perform one deterministic tree transformation before pagination. Promote children
of empty presentational wrappers and normalize indentation. Preserve semantic
landmarks, headings, meaningful groups, lists, genuine data-table row/cell
relationships, relevant states and unnamed actionable controls. Missing names alone
are not a deletion rule: an unnamed checkbox or structural table cell can matter.

Do not flatten a table into unrelated links, erase rank/label associations, repeat
ancestor aggregate text at every level, or use generated summaries in place of
observed content. Keep a reference on useful scoping containers and actionable
nodes; plain text leaves do not need action references. Retained references map to
actual Playwright nodes, never reconstructed selectors.

### 3. Shorten references without weakening freshness

Replace repeated UUID prefixes with short opaque observation-qualified references.
Reuse the current reference-action shape rather than adding another required tool
argument. Use exact map lookup and prevent token reuse within a live runtime;
restart must not allow a prior reference to match a new observation. Reference
length must not be treated as authentication or permission.

Preserve current target, document, generation, control-epoch and invocation checks,
60-second snapshot lifetime, replacement invalidation and private-control fencing.
Do not implement bare `e19` aliases that silently bind to the newest snapshot.
Continuation pages belong to one observation; scoped reads create a new observation
and invalidate the previous one under the existing contract. Exact role/name
locators still reject missing or ambiguous matches, without automatic replay.

### 4. Budget the actual output and clarify coverage

Paginate the normalized retained tree in reading order using the full serialized
result size, accounting for UTF-8, JSON escaping, indentation, cursor and envelope.
Preserve enough ancestor context on continuation pages to interpret content;
any repeated context counts against the budget. Every continuation advances.

A single oversized node must not cause an endless continuation or silently lose
text. Prefer the cheapest bounded behavior: explicit content-limit result directing
the agent to scope/visible inspection; do not introduce text-chunk cursor variants
in this phase. Keep the retained snapshot memory/node/depth limits.

Clarify the existing modes in concise tool descriptions:

- `snapshot`: document or observed subtree; scrolling does not advance pagination.
- `continuation`: next portion of the same frozen observation, not a fresh capture.
- `visible_dom`: current viewport with geometry; use after scrolling when viewport
  evidence is required. Pagination of a frozen viewport does not move the browser.
- `scope`: a previously observed useful container; `page_info`: title/URL only.

Include concise coverage/completeness metadata. Never imply that a paginated
snapshot covers the entire document or that a viewport snapshot covers offscreen
content. Preserve existing inaccessible-frame/shadow limitations.

## Implementation slices and technical-debt cleanup

1. Add deterministic fixtures and baseline measurement, then replace duplicated
   encoding and wrapper-heavy serialization in the helper. Remove the superseded
   serializer rather than leaving a second configurable default.
2. Introduce short reference identities and full-result budgeting through existing
   daemon/service boundaries. Update tool descriptions and client rendering only
   where needed. Keep serialization independent of individual LLM providers.
3. Validate live calls, history replay and actual-agent browsing. Record size,
   token and latency comparisons in a debug note; update phase status honestly.

Audit the existing old-service adapter when implementing. Keep only a narrow
negotiated boundary adapter needed for mixed versions; do not retain two semantic
engines. Do not fold the general history-refresh/context-compaction architecture
into this change. No new database, background observer, scheduler or service.

## Ownership and impacted contracts

Resource ownership remains owner → Bud → thread → browser session/target. Agent
identity comes from the owned invocation. Existing broker/daemon admission fences
apply before observation and delivery; authenticated transcript readers retain
normal thread authorization. No new browser-facing route, global query or owner
stamping path is proposed. Form-value redaction and private-frame separation stay.

Impacted: browser result payload, reference semantics, tool descriptions, transcript
rendering and replay validation. No new SSE family, DB schema, image format or
human input/control protocol is planned.

## Validation

- Fixed HN-like page: ranks 3/4/16 and all links survive across continuation pages.
- Nested wrappers, real data tables, lists, duplicate names, unnamed controls,
  scope containers, Unicode/emoji and escaped/multiline text.
- Empty pages, one huge node, pagination boundary, no cursor progress, expired
  snapshot, invalid cursor and retained-memory limit.
- Old reference after refresh/navigation/target switch/helper restart/takeover;
  same-document DOM changes return missing/ambiguous/detached truthfully.
- Password/form values remain excluded; late private observation delivery is
  rejected; exact locators and uncertain-action behavior stay unchanged.
- Live execution and history replay deliver equivalent compact results; OpenAI,
  Claude and local provider adapters receive ordinary text without duplicate copies.
- Web/mobile expand both old and compact snapshots; visible DOM remains useful.
- Measure bytes, tokens, total continuation calls, capture/format latency and helper
  memory on the same small, HN-like and large fixtures. A smaller page that forces
  enough extra calls to increase total context is a regression.
- Real agent repeats the browsing task with a fresh test thread. Compare context
  growth and observation count without modifying the original user's history.

## Rollout and spec updates

Inspect current result consumers before choosing the cheapest negotiation boundary.
If removing fields or shortening references breaks old consumers, use one explicit
compact-observation format capability/request opt-in. New service + old daemon
keeps the existing result; old service + new daemon receives the existing format;
both new use compact output. Never send an unknown request variant to an old daemon.
Full effect requires service and daemon/helper upgrade. No production migration.
Existing stored results remain supported by new web/mobile clients; any required
mobile change is scoped to rendering and must be validated in that repo.

Specs/docs to update during implementation:

- `bud/browser-helper/browser-helper.spec.md`, `bud/src/browser/browser.spec.md`
- `service/src/browser/browser.spec.md`, `service/src/agent/agent.spec.md`
- `docs/proto.md` for negotiated result/reference contract
- Web tool-renderer spec; mobile equivalent if its decoding/rendering needs changes
- This phase and the roadmap with measured evidence and remaining acceptance

## Explicit won't-dos

- No snapshot diff protocol, hash-based unchanged replies, cross-call dedup cache,
  multi-snapshot archive or automatic observation reuse.
- No rewriting/evicting old tool results, browser-specific compaction or new token
  budget manager. Existing large threads do not shrink retroactively from this fix.
- No LLM summaries, HTML/Markdown extraction, full browser REPL or query language.
- No new mode matrix, verbosity knobs, fuzzy locators, mutation retries or automatic
  screenshots. Reuse scope, continuation, visible DOM and page metadata.
- No viewer-media/WebRTC work, control-lifecycle refactor, persistent profiles or
  unrelated debug logging. Performance measurements are bounded and omit private
  page contents from operational logs.


## Implementation evidence

See [validation and measurements](../../debug/browser-compact-observations.md).
The existing five tools negotiate `compact_observations` / `inspect.compact:true`.
Complete fixture output is 81.0% smaller in bytes and 84.3% smaller with the same
`o200k_base` tokenizer, without increasing continuation calls. The helper reserves
4 KiB of the 12 KiB budget for the final tool envelope; the executor enforces that
final limit independently. New web rendering supports node-only visible DOM.
Existing mobile snapshot text decoding requires no change. Old stored results are
not rewritten. Manual normal-agent/device and broad performance validation remain.
