# Implemented Contacts API (development)

This describes the current working tree, not a deployment or completed phase-4 gate.

## Expanded fields (phase 12)

Backend processing now accepts `contacts.record.v2`, `contacts.scan.v2` and their
`repair_record`/`repair_scan` equivalents with payload version 2 inside the same
v1 envelope. V2 requires structured `postal_addresses` and labeled `urls`; v1
remains strict. Missing rich fields in old revisions mean uncollected, while
empty v2 arrays mean observed empty. Staging excludes older publishers through
v2-specific internal states, mapped to ordinary pending/repair public status.
Normal composition now advertises `features.contacts_payload_v2: true` after
startup verifies migration 0035's field-permission column. A missing column fails
readiness before contact processing starts. `/api/data/status` is authenticated,
owner-scoped and `Cache-Control: no-store`. Injected repository fixtures default
to false unless they explicitly supply schema verification. This describes the
working tree; the running development service has not been restarted for it.

Agent grants now return saved `fields` plus `supported_contact_fields`.
PUT accepts optional `fields`; omission preserves saved choices, explicit empty
removes all field access, and supported values are names, organization, phones,
emails, postal_addresses and urls. Migration 0035 defaults existing grants to the
four legacy categories. Query search/projection/history share those restrictions;
first-party owner views retain collected fields. Both clients save field choices
immediately and show structured addresses and literal website text in history.
Postal addresses never substitute for sensor-derived location evidence.

V2 publication preserves contact identity and only emits additions for truly new
incremental contacts. Repairs/replay/enrichment do not repeat completed actions.
After publishing rich fields, any rollback must retain field-aware query policy;
pre-policy services are unsafe readers of rich projections.

All routes resolve the existing cookie/bearer viewer before reading. SQL filters by the authenticated owner; IDs never authorize access. Anonymous requests return 401; another owner's detail/history returns 404. These are first-party account reads. Agent grant state is editable and enforced by the four registered agent query tools; generated-app grants remain pending.

| Route | Query | Response |
|---|---|---|
| `GET /api/data/status` | None | Source receipt timestamps, pending raw jobs, recent scan status/error/generation/publication and projection state |
| `GET /api/data/contacts` | `search` up to 200 chars; `visibility=visible\|hidden\|all`; `limit=1..200` (50 default); `cursor` | `items`, `next_cursor`, coverage/time/identity labels |
| `GET /api/data/contacts/:id` | None | Current approved fields, visibility, source identity and observation times |
| `GET /api/data/contacts/:id/history` | Same bounded limit and cursor | Immutable published revisions with approved fields, visibility, observed time, scan ID and generation |
| `GET /api/data/location` | Explicit ISO `from`/`to`, at most 31 days; bounded limit/cursor | Normalized observations, source IDs, accuracy, occurrence/receipt and visit times; no continuous-coverage claim |
| `GET /api/data/contacts/:id/location-context` | Explicit `from`/`to`, at most 31 days | Nearest observation to first detection, signed offset seconds, or null evidence; explicit uncertainty |
| `GET /api/data/agent-grant` | None | Owner-wide scopes, current version, history days, fixed field/precision description |
| `PUT /api/data/agent-grant` | JSON `version`, unique `scopes`, `history_days=1..3650` | Updated canonical grant; stale version returns 409 |

Status includes additive `failed_processing_count` (failed/invalid raw jobs) and
`reconciliation_scan_count` (invalid scans or pending scans older than 24 hours).
These aggregate the entire owner scope, independently of the 200-scan detail
limit. `needs_reconciliation` takes precedence over `processing`; `ready` means
neither pending nor failed work was found. Unknown/unsupported processors do not
count as failures. These reads may observe adjacent committed states during work.

Each recent scan includes `source_id`, `received_at`, `reconciliation_required`,
`received_record_count`, nullable `expected_record_count`, and nullable
`waiting_reason`: `missing_predecessor`, `missing_manifest`, `missing_records`, or
`awaiting_publication`. Closed scans have no waiting reason. Age changes reporting
only: a pending scan remains eligible for normal ordered publication when its
original missing data arrives. No events or checkpoints are rewritten by status.
Mobile/web show up to ten recent unfinished scan diagnostics and guide the user
to retained/quarantined original uploads on the source phone. Source reset for
irrecoverable originals remains unfinished.

Search uses approved name, organization, phone and email values, with literal wildcard escaping and parameterized SQL. Page output is capped at 512 KiB; a smaller-than-requested page can still have a continuation. Cursors bind owner and filters and seek by stable row ID. Pagination is live ID order, not a frozen database snapshot; refresh the first page to see newly published state. Responses do not claim verified creation/meeting times or cross-device contact identity merging.

Contacts processing stages raw records independently of upload batches. A complete manifest and predecessor must match before current rows, revisions and `contact.added` domain work commit together. Owner publication locks precede source mutation. First baselines, permission-change scans, resyncs and rebuild mode do not emit live additions. A producer's newly-observed flag alone is insufficient: the server also requires no prior source contact. Late location enrichment cannot emit a contact event through this processor.

The service starts bounded processing during readiness and waits for active processing at close. Raw processing failures use durable 30-second retry delays and become failed after ten attempts. Unknown event versions/types remain raw with unsupported status. Supported v1 visit/significant-change jobs previously marked unsupported are requeued in bounded owner-locked passes. Location normalization never emits contact additions. Source repair and complete publication-failure/dead-letter controls remain outstanding.

Web `/data` (linked from Settings) and mobile Personal data (linked from Device & Debug) consume these same APIs for search, details, history and import status. Both distinguish observed time and source visibility. UI builds are verified; visual/device/live-auth checks remain.

Both clients now edit the same owner-wide agent grant, defaulting to no scopes; available scopes are `contacts.read` and `location.read`. Consent includes selected model providers and is distinct from collection and generated-app access. Both request nearest location evidence in a declared ±24-hour development window around first detection. Maps load on explicit Show pin (OpenStreetMap on web, MapKit on mobile). Refreshing evidence only queries and never reruns actions. The map does not verify meeting, creation, arrival or continuous presence.

Migration `0026_supreme_human_cannonball.sql` adds the observation and grant tables, generated/reviewed and applied locally. PostgreSQL tests cover upgrade recovery, bounded pagination, owner isolation, closest/missing evidence and grant revoke/version conflict; route fixtures cover anonymous reads/writes and foreign owner context. Agent query adapters enforce the grant history bound; live-model and cross-client validation remain open.

The service registers four grant-aware tools: `contacts_search`, `contacts_history`, `location_context` and `timeline_query`. The executor verifies thread/Bud ownership, reports consent errors with a Settings link, and passes bounded results through canonical tool transcripts and model replay. They remain available to manual offline chat without terminal setup. Current contact records require a latest observation within the grant history window; individual revisions are filtered independently by their observation time. Location queries reject windows before the cutoff. Contact-location joins require both scopes. All grants currently approve the fixed imported field set and as-collected location precision; no model can request extra fields or raw envelopes. Permissions are checked before reads and version-checked again before delivery. Previously delivered transcript data is not retroactively erased by revocation.

Validation: three pure contract tests, PostgreSQL reverse-arrival/incomplete/replay/concurrency/rebuild and query tests, anonymous/foreign-owner Fastify route checks, existing ingest tests and Drizzle metadata tests. Migration `0025_careful_trauma.sql` adds the six contact/domain tables and is applied locally; deployment is separate.

## Automation management reads

The working tree recognizes explicit complete-snapshot source-repair event
types and advertises `features.contact_source_repair: true`. Mobile checks that
capability after explicit confirmation, persists its request and captures a full
replacement. The bounded recovery pass requeues repairs an older service marked
unsupported. The
[repair contract](contact-source-repair.md) documents preserved identities,
superseded unpublished scans and no live action emission. Ordinary `resync` alone
still cannot skip a missing predecessor.

`GET /api/automations` returns up to the enforced 100-rule owner limit. `GET /api/automations/:id` returns the draft and active immutable definition separately from one SQL snapshot. `GET /api/automations/:id/deliveries` returns explicit delivery status/outcome and invocation IDs with `limit=1..100` (default 50) and an owner/rule-bound `cursor`; responses include `items` and `next_cursor`. These authenticated first-party reads do not activate or dispatch work. Mutation routes and mobile/web management screens are implemented below; status still advertises `automations: false`.

## Automation draft and pause mutations

- `POST /api/automations`: strict `{definition, idempotency_key}` creates a draft. Reusing an owner-bound key for the same unchanged draft returns the existing rule; changed payloads or retries after later edits/activation return 409. Never replace the key merely to retry an uncertain request.
- `PUT /api/automations/:id`: strict `{definition, expected_version}` saves the draft without changing its active revision.
- `POST /api/automations/:id/pause`: strict `{expected_version, cancel_pending, cancel_active}` records pause and selected cancellation requests atomically. Running requests retain reservations until acknowledgement; no claim is made that terminal commands have stopped.

All three require the authenticated viewer, stamp the owner/updater and reject foreign resources with 404. Activation and bootstrap writes remain gated off in server composition. Upload admission limits apply only to the ingestion endpoint, so draft management cannot consume upload slots.

Web `/automations` now consumes draft/update/pause and delivery APIs. History entries include a nullable `invocation` with current `status`, `outcome_code`, `thread_id` and `bud_id`, resolved by owner in SQL. Status includes at most 200 `contact_sources` (`source_id`, `installation_id`, `collection_epoch`, `revoked`) plus `contact_sources_truncated`. Source labels are inventory hints, not contact identity merging. Mobile also provides automation authoring; bootstrap client controls remain pending.

## Gated activation

`POST /api/automations/:id/activate` accepts strict `expected_version`, `expected_grant_version`, and `acknowledge_standing_work: true`. It authorizes the owner before checking availability; disabled activation returns 503. Status advertises `features.automation_activation`. The server composition has not enabled this capability. Both clients show saved-draft review and explicit standing-work acknowledgement, requiring unchanged draft and current loaded versions. No background scheduling is enabled by these UI changes.

## Existing-contact snapshot API

- `POST /api/automations/:id/bootstrap` captures an active revision's existing contacts.
- `POST /api/automations/:id/activate-and-bootstrap` accepts strict `{activation, bootstrap}` and commits activation and snapshot membership together. Both inputs must name the same `expected_version`; activation includes the grant version and standing-work acknowledgement.
- `GET /api/automations/:id/bootstrap/:bootstrapId` returns the persisted receipt.
- `GET /api/automations/:id/bootstrap/:bootstrapId/members` returns frozen `ordinal`, `group_index`, and `contact_revision_id` with `limit=1..100` (default 25), request-bound `cursor`, `items` and `next_cursor`.

Bootstrap input is strict: `expected_version`, `idempotency_key`, `acknowledge_existing_contacts: true`, `sources: {source_ids}`, `search`, `max_contacts=1..1000`, `mode=batched|per_contact`, `exclude_previously_delivered`, and `acknowledge_repeated_actions`. Disabling prior-work exclusion requires repeated-action acknowledgement. Receipts include `bootstrap_id`, `automation_id`, immutable `revision`, `publication_boundary`, `member_count`, `group_count`, `group_size`, `status`, `latest_start_at`, and `created_at`. Capture defaults to groups of 25; per-contact mode uses one. Retrying the same normalized request returns its original receipt even after later publication or editing; changing the request under its retry key returns 409.

Writes use the same disabled-by-default activation capability and authorize the rule before returning unavailable. Reads remain available for receipts and require the authenticated owner. Snapshot membership is capped and frozen under the publication lock. Later live events remain eligible; delayed matching cannot duplicate selected pre-boundary contacts. These endpoints currently persist snapshots only: group execution, cancellation, preview and mobile/web bootstrap controls remain unfinished.

`POST /api/automations/:id/bootstrap/:bootstrapId/cancel` requires the authenticated owner and remains available while activation is disabled. It marks pending groups canceled and requests cancellation of admitted invocations atomically. Repeated cancellation is idempotent; running reservations persist until acknowledgement and uncertain action evidence remains reviewable. Dispatch and query boundaries now enforce bootstrap revision permissions and current frozen-member availability. Group admission is implemented, but scheduling, aggregate progress, preview and client controls remain pending.

`GET /api/automations/:id/bootstrap/:bootstrapId/progress` returns `request_status`, `group_count`, `settled_group_count`, `settled`, effective-state `counts`, and bounded `items` with `next_after`. Query uses `limit=1..100` (default 25) and `after=-1..999` (default -1). Each item exposes group index, effective invocation/admission state, outcome, invocation/thread/Bud IDs and cancellation-request timestamp. A canceled request with a running or review-required invocation is not settled. Counts and page reads may reflect adjacent committed states during execution; refresh for current state. Rule pause choices now apply to both live and bootstrap work using the same queued-versus-started distinction.

`POST /api/automations/:id/bootstrap/preview` is read-only and available before activation is enabled. Strict input: `expected_version`, `expected_grant_version`, `use_draft`, `sources`, `search`, `max_contacts`, `mode`, and `exclude_previously_delivered`. It checks current permissions and uses the same bounded selector as capture in a read-only repeatable-read transaction. `use_draft: true` previews the prospective next revision without activating it; false previews the current active revision. Response includes rule/version/revision, grant version, contact/group counts and `snapshot_frozen: false`. It is an estimate at preview time; capture rechecks all conditions and freezes its actual set.

`GET /api/automations/:id/bootstrap` provides owner-scoped historical receipts with `limit=1..100` (default 25), owner/rule-bound `cursor`, `items` and `next_cursor`. A second device can recover receipts and progress without knowing the creating client's retry key.

Default prior-work exclusion follows pending/admitted group state, including admitted groups inside canceled requests. Canceling a receipt never implicitly authorizes repeating already-dispatched work; explicit rerun consent is still required. Mobile now implements preview, approval, stable retry, history, progress and cancellation against these APIs; simulator build passes, with tests and live interaction validation tracked separately.

Development composition can enable activation and scheduled processing with `AUTOMATIONS_ENABLED=1` plus `AGENT_INVOCATION_MODE=durable`; invalid/legacy combinations fail startup. Defaults are unchanged, and no environment was enabled by this implementation. `features.automations` and `features.automation_activation` follow this setting. All replicas must use consistent configuration; mixed legacy/durable mode remains blocked by the startup guard. Full integration validation is still pending.
