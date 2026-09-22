# Phase 3d: explicit agent observations and semantic targeting

Status: implemented locally; normal-agent acceptance and performance comparison pending. 2026-09-15.

## Objective

Give the actual Bud agent a useful, requested snapshot of its browser, followed
by reliable actions on what it observed. Text is the default; screenshots are an
explicit alternative. The agent does not continuously watch the human viewer.

The user's `tab.playwright.domSnapshot()`, `getByRole(...).click()`,
`tab.screenshot()`, `get_visible_dom()`, `title()` and `url()` examples describe the
experience we want. They are not APIs currently implemented by Bud, nor a promise
that stock Playwright exposes that exact SDK. A REPL is one possible later client
of the same capability, not a prerequisite for this phase.

Related documents and implementation:

- [Delivery roadmap](phases.md), [Phase 1](phase-1-agent-browser.md)
- [Daemon browser spec](../../bud/src/browser/browser.spec.md)
- [Service browser spec](../../service/src/browser/browser.spec.md)
- [Agent spec](../../service/src/agent/agent.spec.md)
- [LLM spec](../../service/src/llm/llm.spec.md)
- [Web viewer spec](../../web/src/features/browser/browser.spec.md)
- [Wire contract](../../docs/proto.md)
- [Observation failure](../../debug/browser-observation-layout-truncation.md)

## Why the current approach is insufficient

The original observation flattened Chrome's AX response and truncated it after
100 nodes. Hacker News exhausted that limit on layout rows before story links.
The local follow-up orders and filters AX nodes, with 256 elements and a 64 KiB
budget. That is a stopgap, not the complete observation contract for this phase.

Current observations expose flat role/name/reference objects, with no hierarchy,
continuation, scoped query or image available to the model. Actions support opaque
references and a separate focus/insert sequence, but not semantic locators.
Increasing the node limit again would leave long pages, duplicate names, tables,
dynamic documents and visual inspection unresolved.

The current human screenshot stream is independent: its canvas frames are not
provider-visible images. A successful image transfer or JSON field containing
base64 is not proof that the model received an image.

## Product contract

1. Open or reuse this thread's browser and select a returned tab/target.
2. Request one representation: structured text snapshot, viewport screenshot,
   visible DOM, or small page metadata query.
3. Receive that observation as explicit model-visible tool output.
4. Act through a unique semantic locator or a reference from that observation.
5. Request a fresh observation when needed to establish the result.

Opening the human viewer does not feed frames to the model. An action returns an
acknowledgement and relevant navigation/state metadata, not an unsolicited snapshot
or screenshot. Navigation acceptance does not mean the page has finished loading.

Example text output, illustrative rather than a fixed serialization:

```text
page "Hacker News"
  navigation
    link "Hacker News" [ref=n1]
    link "new" [ref=n2]
    link "past" [ref=n3]
  main
    row
      text "3."
      link "Example third story" [ref=n19]
```

Text snapshots describe page structure, roles, accessible names and relevant text.
They are neither raw HTML nor an article-to-Markdown extraction. Preserve useful
hierarchy and context such as story ranks and table/list relationships. Remove
layout-only noise and redundant labels without deleting meaningful descendants.
Never return form values or hidden credential contents just to make a snapshot
more complete. Ordinary page text can still be sensitive and untrusted.

## Recommended API: retain five tools, improve their contract

Keep `browser_open`, `browser_observe`, `browser_act`,
`browser_request_handoff`, and `browser_close`. Avoid introducing a second
orchestration path simply to obtain Playwright-like behavior.

| Surface | Proposed additions |
| --- | --- |
| `browser_open` | Existing session reuse and returned tab identities; no implicit observation |
| `browser_observe` | `mode`: `snapshot` (default), `screenshot`, `visible_dom`, `page_info`; optional returned target ID |
| Snapshot | Structured text plus observation ID, target/document identity, completeness/continuation metadata; optional bounded scope |
| Screenshot | Viewport only initially (`full_page:false`); actual provider image plus capture metadata |
| Visible DOM | Visible rendered nodes with observation-scoped IDs and geometry; no implied screenshot |
| Page info | Title and URL without taking a snapshot or screenshot |
| `browser_act` | Existing navigation/reference actions plus exact role/name locators and atomic locator fill; explicit scrolling for further inspection |

Proposed role action, equivalent in intent to the user's example:

```json
{
  "action": "click",
  "target_id": "returned-tab-id",
  "observation_id": "returned-observation-id",
  "locator": {"role": "link", "name": "Example third story"}
}
```

These fields are now callable; role/name matching is always exact. Keep
provider schemas simple and normalize nullable optional fields centrally. Reject
incompatible combinations (for example a reference and locator together).

### Observation completeness and targeting

- Use stable tree order, not the order of a raw CDP array. Preserve headings,
  lists, table context, links, labels and unnamed interactive controls.
- Return explicit `truncated` and a usable next step. Initial snapshot pages have
  a bounded text budget; a continuation reads the same bounded, short-lived
  snapshot, not an unrelated live page appended to old output. Scope reads to an
  observed container for large pages. Bound retained bytes and expire old snapshots.
- Oversized captures that cannot be retained report that limit honestly and offer
  scoped/visible inspection. No requirement to cache an arbitrarily large DOM.
- Snapshot continuation must reauthorize owner, generation, document and epoch;
  navigation or takeover invalidates it. New observation replaces old reference
  authority. Do not silently mix multiple points in time.
- Resolve role/name locators against the current page. Exact matching is default;
  zero or multiple matches return actionable errors, never an arbitrary first hit.
  Narrow through an observed container or use a specific observed node reference.
- A locator is not permission to retarget a different document after navigation.
  Check expected target/document and authority before dispatch. Same-document
  mutations may cause a missing/ambiguous/detached result; request another snapshot.
- Use bounded visibility/enabled/actionability waits. Never retry an uncertain
  click, fill or submission. A wait before dispatch is distinct from action replay.
- `fill` targets and replaces the selected field atomically. Preserve existing
  focus/insert behavior for compatible callers; private sign-in still uses handoff.
- Visible DOM IDs are observation-scoped, not persistent CSS selectors. Geometry
  includes viewport/scroll context. Defer coordinate actions until their freshness
  checks are explicit; screenshot support alone does not authorize pixel clicks.

## Implementation choice: prefer an established semantic engine

Evaluate a private Node/Playwright helper owned by the daemon, connected only to
its managed Chrome, as the recommended implementation for snapshots and locators.
Verify available Playwright snapshot APIs and semantics during implementation;
do not assume the reference SDK's `domSnapshot` is an upstream method.

The helper receives typed operations, not model-supplied JavaScript or CDP calls.
The daemon remains the owner of process identity, admission, privacy and serialized
page access. The helper must not race the Rust adapter for mutations, resize or
capture: route page operations through one per-browser execution boundary.

Before adopting the helper, validate packaging/startup on our development machine,
Chrome compatibility, interruption behavior, and a real HN-like page through the
normal agent. If dependency/distribution costs are unacceptable, explicitly review
a narrower CDP implementation; do not quietly build an incomplete Playwright clone.

Keep only one snapshot/locator implementation after migration. Reuse the working
lifecycle, ownership and media pieces. Adapter refactoring must preserve live
viewer capture, human input and service-restart recovery tests. An additional
runtime is justified only by the semantic behavior it provides.

## Explicit screenshot delivery to the model

A screenshot request captures the selected tab once and returns that image to the
requesting invocation. It neither subscribes the agent to viewer frames nor borrows
a private viewer frame. No default screenshot after each action.

- Reuse capture/encoding primitives, but keep agent capture requests and human
  viewer subscriptions separate. Serialize capture with page operations and
  authorize before capture and before delivery; discard late revoked images.
- Carry image bytes on a bounded subordinate transfer, separate from the shared
  control writer. Reuse media authentication/transport primitives where practical,
  without requiring a human viewer or private-controller grant.
- Correlate transfer to owner, Bud, thread, invocation/call, session/generation,
  target/document and control epoch. A completed transfer cannot be reused by
  another invocation without normal history authorization.
- Extend the canonical tool-result model to include an image artifact, then map
  it to real image content for OpenAI, Claude and supported local-model adapters.
  Test actual request serialization for each; base64 in a text string is not enough.
- Gate screenshots on both daemon capture and selected model image-input support.
  Text-only models receive a clear unsupported result and can request text instead;
  do not silently switch models, run OCR or claim the model saw the image.
- Keep encoded image bytes out of ordinary tool JSON, SSE, debug logs and text
  token estimation. Use owner-scoped artifact storage with explicit size/expiry
  and access checks. Never publish a public screenshot URL.
- Persist artifact references and tool pairing so history refresh, provider
  continuation and replay retain the original observation. Expired artifacts are
  explicitly unavailable; never recapture today's page as yesterday's result.
- Reuse an existing authenticated attachment/artifact path if it meets these
  requirements. Confirm storage and provider mapping before advertising screenshots;
  any new DB records require owner/tenant stamping and checked-in migrations.

A future REPL client must explicitly return text or emit images to model context,
like `write`/`emitImage` in the example. This phase's ordinary tool result is that
explicit output boundary; daemon stdout or helper return values alone are not.

## Ownership, privacy and recovery

The resource remains the owner/Bud/thread browser session and selected target.
The agent acts as the authenticated invocation owner; a human artifact reader acts
as the authenticated web/mobile viewer. Resolve ownership before reads, capture,
artifact access and subscriptions. No model-supplied owner or raw CDP endpoint.

All representations, including title/URL and screenshots, respect private control.
Takeover during a snapshot, actionability wait or transfer fences late results.
Closing the pane does not return the browser to the agent. Service restart preserves
private intent; confirmed daemon restart retires the destroyed ephemeral identity.
Do not resume a private page or replay input as an observation recovery strategy.

Page text, accessible names, URLs and screenshots are evidence, not instructions.
Keep the existing concise trust guidance; do not add a large browser prompt manual.

## Delivery slices and acceptance

### 3d.1 — structured text and semantic actions

Implement the adapter decision, snapshot contract, bounded continuation/scope,
page metadata and exact role/name actions through the existing agent tools. Remove
superseded flat-AX selection logic rather than keeping multiple default formats.

Acceptance: normal agent chat opens Hacker News, identifies stories 3, 4 and 16
from the page, clicks the requested observed link, and verifies its destination.
Use a stable local HN-like fixture for assertions; live HN is supplementary because
rankings change. Include long pages, duplicate names, unnamed controls, dynamic
DOM, Unicode, stale snapshots, navigation, frames and shadow DOM. Unsupported
frame/shadow boundaries must be explicit, not silently reported as a complete page.

### 3d.2 — on-demand image results

Implement bounded capture transfer, artifacts and provider image serialization.
Verify with the actual agent on a visual-only fixture that it can identify a
rendered feature not present in the text snapshot. Verify text-only fallback,
restart/replay, expiry and takeover during transfer. A human seeing the image in
the pane is not acceptance for model image input.

### 3d.3 — visible DOM and client presentation

Add visible DOM with scoped node IDs/geometry using the same observation authority.
Web/mobile show a compact tool summary and optional text/image detail using their
existing transcript grouping. No automatic pane opening, continuous agent capture,
or per-frame transcript rendering. Test long tool output and expired artifacts on
both clients. Basic text operation must not require a mobile upgrade.

## Performance and failure checks

Measure requested observation latency, output bytes/model tokens, capture/encoding
cost, helper memory and terminal/control latency alongside an open human viewer.
Record p50/p95 against the existing implementation on defined small/table-heavy/
large fixtures and the same machine. Set budgets from those measurements before
expanding scope; do not claim a latency target without evidence.

Keep one bounded page-operation queue, bounded waits and at most one outstanding
agent observation per session. Metadata queries must not build a full snapshot.
No helper activity or capture solely to keep an idle agent supplied with updates.
Private renewal and terminal heartbeats must remain responsive under large reads.
Test output-budget limits, helper crash, disconnect during capture, partial image
transfer, cancellation, changed target/document, and concurrent viewer resizing.

## Explicit won't-dos

- No full Node REPL, arbitrary evaluate/JavaScript, raw CDP forwarding or broad
  Playwright API exposure in this phase.
- No continuous model vision, viewer-frame ingestion or automatic observation loop.
- No raw HTML dump, article extraction service or another ever-growing node cap
  as the primary solution to incomplete snapshots.
- No `.first()` ambiguity fallback, fuzzy surprise clicks or replay of mutations.
- No full-page/stitching screenshots, OCR fallback or pixel actions in the first
  image slice; no WebRTC dependency (that remains Phase 5).
- No personal Chrome attachment, extension, persistent-profile change, new agent
  scheduler, duplicated ownership system or unrelated transport rewrite.

## Specs, protocol and rollout

Update daemon/browser, service/browser, agent, LLM/provider and client rendering
specs where implementation changes their contracts. Update docs/proto.md and the
owner-isolation checklist for new requests/transfers/artifact endpoints. Read the
actual provider/artifact implementations before choosing migrations.

Advertise additive capabilities for structured snapshots/locators, visible DOM and
agent screenshots. New service + old daemon keeps existing supported tools and
never sends new Rust enum variants. Old service + new daemon uses the legacy
request shape; keep only the minimal boundary adapter needed for that pairing,
not a second semantic engine. New web/mobile tolerate old text-only tool results.
If a selected backend lacks a representation, say so rather than simulate it.

Full functionality requires daemon upgrade plus service/provider support. No
schema change is decided by this document; artifact persistence may require one.
Phase completion requires normal-agent acceptance, mixed-version coverage and
explicitly removing superseded code, not just a working helper demonstration.

## Implementation and local validation — 2026-09-15

The five tools now expose snapshot (default), visible_dom, page_info and screenshot.
Playwright Core 1.63.0 is the single semantic engine; its public
[`ariaSnapshotJSON`](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot-json)
API supplies hierarchy/refs. A private Node helper attaches to Rust-owned Chrome.
The flat AX implementation is removed; an old-service response adapter remains.

- One retained observation per browser, 60 seconds, 2 MiB, 24 KiB node pages plus
  rendered text; traversal bounded at 128 levels/20,000 nodes. Continuation never
  fetches a different live snapshot. Closed shadow/inaccessible frame limits are
  included in results. Field values are excluded.
- Exact role/name click and fill, reference actions, scope and scrolling share
  the existing serialized browser lock and authority fence. The helper has an
  eight-second deadline and is killed on interrupted calls; no mutation replay.
- Screenshot is viewport-only, capped by existing capture encoding (1.4M base64
  chars). A one-use authenticated HTTP upload binds the invocation/carrier/epoch;
  bytes do not travel through control messages or chat events.
- Immutable image files are owner/thread/call bound, retained for seven days,
  capacity 128. Cleanup runs on writes. This uses single-instance filesystem
  storage, not a new database table. No migration is needed. Persistent storage
  is required to retain screenshots across container/deployment replacement.
- Immediately before provider invocation, artifact references become actual image
  blocks alongside the paired tool result. Only the newest eight images hydrate;
  other references are explicitly unavailable. OpenAI and Claude serializers are
  covered; currently text-only local providers reject screenshot requests.
- Web/mobile summaries use existing collapsed tool groups, expandable snapshot
  text and on-demand authenticated image fetch. No pane automatically opens.

### Setup

From the main repository root:

```sh
npm ci --ignore-scripts --prefix bud/browser-helper
cargo build --manifest-path bud/Cargo.toml
```

Keep `BUD_BROWSER_EXECUTABLE` pointing to Chrome for Testing. Node 22+ must be on
PATH (or set `BUD_BROWSER_NODE`). Source builds locate the helper automatically;
installed builds must deploy the helper/dependencies and set `BUD_BROWSER_HELPER`.
Installer bundling remains Phase 4 work. Missing helper fails the readiness probe
without affecting terminal capability. Restart the single user-run daemon to
advertise the new capabilities; do not run two daemons with the same identity.

Service image upload uses the configured `BETTER_AUTH_URL` origin. The daemon
must be able to reach it and trust its TLS certificate. For persistent service
storage set `BUD_BROWSER_ARTIFACT_DIR` to a mounted private directory. The default
`.bud-data/browser-images` is suitable for local testing. An ephemeral deployment
can lose artifacts; history then explicitly reports unavailable, never recaptures.

### Remaining acceptance (not claimed by automated fixtures)

- [ ] In ordinary chat, ask the rebuilt Bud to identify and visit stories 3, 4
  and 16 using only browser snapshots/actions; confirm results in tool output.
- [ ] Ask a vision-capable model to inspect a visual-only fixture via screenshot;
  verify its answer depends on the image rather than text. Check web/mobile image
  details and unavailable behavior after artifact expiry.
- [ ] Repeat real two-account cookie/bearer authorization and takeover during
  capture through the deployed edge. Artifact routes use existing auth helpers.
- [ ] Record p50/p95 observation/capture latency and memory alongside terminal and
  viewer traffic against the prior implementation; no performance claim yet.
- [ ] Broader frame/shadow and dynamic-page site matrix, plus installed runtime
  packaging. The explicit coverage limitations remain even where fixtures pass.

Automated and build evidence: [validation note](../../debug/browser-phase-3d-validation.md).
