# Implementation phases and acceptance

Status: phases 1–2 implemented; phase 3 cloud-provider smoke tests passed and
manual validation remains. Phase 4 is deferred. See [validation.md](validation.md).
Contracts and initial limits are in [implementation-spec.md](implementation-spec.md).

## Phase 1 — Retrieval foundation

- [x] Create backend interfaces with independently selectable search/read.
- [x] Add optional secret configuration and explicit feature flag.
- [x] Implement bounded Firecrawl search and Markdown read adapters.
- [x] Add owner/thread-scoped artifact persistence, migration and TTL cleanup.
- [x] Implement public-URL policy, immutable pagination and output byte bounds.
- [ ] Add fixtures for empty results, malformed responses, 429, timeout, abort,
  oversized bodies, Unicode offsets, cache provenance and domain/time mapping.
- [x] PostgreSQL tests prove cross-owner/thread isolation, expiry, cleanup and
  stable references after service restart. Apply and generate migrations.

No live personal-data queries are needed to validate the adapter.

## Phase 2 — Main agent and client integration

- [x] Add `web_search` and `web_read` to canonical schemas, parser, executor,
  transcript serialization and durable action recovery.
- [x] Enforce provider-call budgets across continuations/restarts; test crash
  ambiguity and Stop without late result publication.
- [x] Keep search available for manual cloud chat with an offline Bud; preserve
  local-model and automation admission rules.
- [x] Add search/citation/external-data guidance to the default prompt.
- [x] Render concise activity inside Worked for on web/mobile with generic
  fallback; preserve clickable citations and user-controlled source opening.
- [ ] Test provider schema lowering, tool-result replay, provider switches,
  compaction, source retention and client reload without duplicate execution.
- [x] Update all affected specs and tool payload protocol documentation.

## Phase 3 — Live validation and enablement

- [x] Verify configuration presence without printing the key; perform one public
  search and one selected-page read using the real provider.
- [ ] Exercise GPT-5.6 Luna search → read → cited answer, then follow-up reading
  after reload. Repeat with another configured provider and a capable local model.
- [ ] Check public developer documentation lookup, recent-news query, no results,
  blocked/unreadable page, unknown/expired reference and hostile page instructions.
- [ ] Check web/mobile grouping and source-link opening; no credentials or raw
  provider errors appear in UI, transcript, debug output or logs.
- [ ] Record latency, provider credits, model token use and citation correctness.
  Tune defaults based on evidence, not provider headline benchmark claims.
- [x] Verify disabled/missing-key behavior, migration rollout and feature rollback.

Acceptance: the selected main agent can discover public sources, read bounded
evidence and cite it; restart and provider changes preserve prior evidence;
isolation and budgets hold; unsupported operations fail visibly.

## Phase 4 — Bud-hosted retrieval (future)

- [ ] Choose the concrete local implementation: HTTP extraction, managed browser,
  or a configured search provider running on the Bud. Do not assume these have
  identical network or authentication capabilities.
- [ ] Add advertised search/read capabilities and authenticated, bounded,
  cancellable transport operations with mixed-version tests.
- [ ] Define explicit execution-location policy, private-network permissions,
  browser profile/cookie ownership and what retrieved data leaves the machine.
- [ ] Support Firecrawl search plus Bud reading through the same service-owned
  reference store. Preserve provenance; existing references never silently change
  backend or snapshot. Cloud fallback for local/private retrieval requires an
  explicit policy and cannot be inferred from Bud unavailability.
- [ ] Keep Firecrawl credentials service-side. Device-owned provider credentials,
  if needed, use a separately designed credential boundary.

Open future choices: private authenticated browsing, a user-facing backend
selector, image/PDF support, shared caching, production retention, and explicit
permissions for automated external enrichment of personal data.
