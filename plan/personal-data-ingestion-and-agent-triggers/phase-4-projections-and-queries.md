# Phase 4: Personal-data projections, APIs and agent queries

Status: contact/location projections, owner/grant-aware queries and both-client evidence views implemented; live agent and cross-client acceptance remain open. Dependencies: phase 1; phase 3 for live-device acceptance. Parent: [implementation spec](implementation-spec.md).

## Normalization and publication

Implement versioned processors with durable claim/retry/dead-letter state. Commit projection mutations and domain-event/matcher work atomically. Repeated processing is idempotent. Rebuild mode reconstructs projections without reissuing live domain actions.

Stage contact deltas by scan. Publish only complete, digest-verified scans with the expected predecessor, under the phase-0 owner publication lock. Baseline/access-change/resync update current accessible state and revision history without live additions. An incremental new source object produces one stable `contact.added` domain event. Preserve no-longer-visible tombstones; late old generations cannot resurrect source objects. Missing/inconsistent scans remain visible, not silently skipped.

Project existing supported location/visit payloads with coordinate validity, source time, receipt time, horizontal accuracy and available time interval. Unknown versions remain raw with unsupported status. Health envelopes remain stored but have no new health projection/tool/trigger in this phase.

## Shared query service

Implement one owner/grant-aware repository/query layer for REST and agent adapters. Implemented interfaces (see [exact API semantics](implemented-contact-api.md)):

| Interface | Request / response intent |
|---|---|
| `GET /api/data/status` | Source capability, permission report, collection/import/processing status and freshness |
| `GET /api/data/contacts` | Search, approved field selection, visibility filter, bounded limit and opaque cursor |
| `GET /api/data/contacts/:id` | Current source-backed contact with identity/time uncertainty |
| `GET /api/data/contacts/:id/history` | Bounded revisions/observations, source provenance and tombstones |
| `GET /api/data/location` | Required bounded time interval, page limit, evidence timestamps/accuracy |
| `GET /api/data/contacts/:id/location-context` | Immediate available context and explicit relationship to detection time |
| `contacts_search`, `contacts_history`, `location_context`, `timeline_query` | Bounded tools over the same query service; contacts/location only |

Canonical cursors include stable tie-break IDs and owner/query binding; reject cursors used with another owner's query. Live change polling, if exposed, uses the commit-safe publication cursor; ordinary history pagination must document snapshot/update semantics. No phone wakeup or LLM invocation is required to query stored data. Do not add raw-envelope export or health placeholder endpoints that imply support.

Resolve owner from viewer or invocation, apply SQL owner filtering and active data grant, enforce field/precision/history bounds and cap output bytes. Add first-party controls for agent-data consent/grants; collection consent alone does not automatically authorize sending data to a model. Tools return a permission-required result if no applicable grant exists. Both clients read/write the same consent state; the service agent cannot approve it.

## Best-effort location and presentation

For development, select the nearest valid available observation to the contact detection time within the caller's bounded query, using stable time/ID tie-breaks; show its actual age, accuracy and provenance. Invalid/missing coordinates yield no pin. This is context for detection, not verified meeting/creation location. Do not introduce an enrichment wait, named-place inference or accuracy-window settings.

Persist annotation evidence IDs/version when useful. Later evidence can update the displayed annotation and invalidate caches, but must not emit another `contact.added` or automatically repeat an already-completed action. Both mobile and web provide contact list/detail/history, source freshness and map context with the same status labels. Avoid projecting unknown state as an empty address book or continuous location coverage.

## Acceptance and documentation

- [ ] Q-series owner/grant/pagination tests cover every REST/tool adapter, including revoked grants.
- [ ] Completed baseline becomes queryable with zero live deliveries; incomplete scans show pending status.
- [ ] Location uncertainty/no-pin paths and late annotation updates match on mobile/web.
- [ ] An agent can search existing contacts/history asynchronously with explicit consent and no automation.

Update service data child specs, DB/migrations, routes/auth/agent tool specs, both clients' feature specs and the auth validation checklist. Document new SSE shapes only if a stream is actually added; polling plus canonical fetch is sufficient initially.
