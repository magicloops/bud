# Phase 12: Expanded contact fields

Status: field validation, opt-in v2 parsing, restricted queries and explicit app
field choices, persistent agent consent and both-client display implemented;
production v2 processing and mobile capture/capability controls are connected;
schema-gated service capability is implemented; live validation remains pending. Dependencies: phases 3–4 and phase-7 grant
contracts; phase 9 exposes field coverage. Parent: [implementation spec](implementation-spec.md).

## Implementation decisions

- Rich capture will use `contacts.record.v2` / `contacts.scan.v2` (and matching
  repair types), with `payload_version: 2`; the outer event envelope stays v1.
  The v1 validator continues to reject additional contact keys.
- V2 contact fields contain all v1 fields plus required `postal_addresses` and
  `urls` arrays. Missing arrays mean uncollected only in v1; empty v2 arrays mean
  observed empty. Addresses preserve label and structured `street`, `city`,
  `sub_administrative_area`, `state`, `postal_code`, `country`, `iso_country_code`.
  URLs preserve label and original string; storing a URL never fetches it.
- Each list permits up to 1000 entries and each component up to 4096 UTF-16 code
  units, consistent with existing contact text limits. Encoded contact fields
  additionally fit within 240 KiB, leaving space inside the existing 256 KiB event
  line limit. The producer must validate the actual complete encoded envelope;
  oversized capture fails visibly without advancing its checkpoint or truncating.
- Roll out backend support before advertising `contacts_payload_v2`. Rich mobile
  collection requires that capability and an account-scoped explicit expanded
  collection choice. Loss/absence of capability keeps v1 capture and reports
  reduced coverage; queued v2 events remain immutable and must await compatible
  upload handling. Do not silently downgrade queued rich payloads.
- Add explicit `postal_addresses` and `urls` field permissions for agent reads
  and generated app keys. Existing permissions default to the legacy field set.
  Current/history serializers, SQL search and cursors must share these limits.
- Enrichment uses the existing incremental identity checkpoint: existing IDs
  produce changed revisions with `newly_observed: false`, while IDs first present
  in that same scan retain normal new-observation eligibility. Permission gaps,
  limited-access changes and repair retain their conservative existing semantics.
  Version transition alone must not force a blanket resync.

These decisions are not capability enablement. Validator, processor, consent,
capture and query integration must all land before advertising v2.

`parseExpandedContactFields` validates the proposed rich field set without adding
it to v1 processing. Tests cover structured international values, explicit empty
arrays, missing/extra/private fields, component/list bounds and aggregate UTF-8
size (`/tmp/bud-expanded-contact-fields-tests.log`). Service build evidence:
`/tmp/bud-expanded-contact-fields-build.log`.

The parser now accepts v2 behind `allowExpanded`; ordinary production processing
now opts into it. V1 staged shapes remain unchanged, and manifests cannot mix
versions. Tests cover version mismatch, required rich arrays and conservative
repair/new-observation rules (`/tmp/bud-contact-v2-parser-tests.log`).

Server-supplied query policies without explicit field choices now default to the
legacy set. SQL matching and current/history output restrict addresses and URLs
together; first-party owner reads retain collected fields. The PostgreSQL policy
test verifies both denied matching and explicitly approved rich-only queries,
including cursor separation (`/tmp/bud-contact-v2-policy-tests.log`).

App request contracts and `data_request_api_key` now accept the two new field
choices through existing immutable user approval. Existing keys retain their
exact stored allowlists. Nine contract, tool and adapter tests pass in
`/tmp/bud-expanded-app-policy-tests.log`; service build passes in
`/tmp/bud-expanded-app-policy-build.log`. This does not enable mobile collection,
agent-wide field consent or advertise the capture capability.

Agent queries now consume the grant's explicit `fields` for SQL search/history
and contact-context lookup, return effective `permission.contact_fields`, and
withhold results if the grant version changes during the read. Unsupported field
names confer no access. Persistent grants now store explicit choices in
`agent_data_grant.contact_fields`, defaulting existing rows to the legacy
categories through generated migration `0035_flippant_killmonger.sql`. The
existing owner-authenticated grant update accepts optional `fields`; omission
preserves saved choices, an empty list removes field access, and changes use the
existing version/owner lock. Web controls now offer the six categories, save
immediately and preserve the existing serialized save/reload handling. The grant
response's optional `supported_contact_fields` prevents new clients offering
unsupported choices against an older service. Mobile now mirrors the supported
field choices in Agent data access with the existing immediate serialized save
flow, owner checks and reload after uncertain saves. Its encoder excludes server
capability metadata and preserves older-service behavior. Simulator app/test
build and six contract tests pass (`/tmp/bud-mobile-agent-fields-tests.log`).
Live cross-device interaction remains unverified.

Web/mobile contact detail and expandable history now display structured postal
addresses and labeled websites, with distinct uncollected/observed-empty states.
Imported URL strings render as selectable plain text without fetching or
navigation. Postal addresses remain separate from location observations.
Production collection/processing capability remains disabled; these views also
handle existing v1 observations honestly.

Display validation: web build passes (`/tmp/bud-rich-contact-web-build.log`);
simulator app/test build and all seven contact/permission DTO tests pass
(`/tmp/bud-rich-contact-mobile-tests-final.log`). Visual interaction and actual
rich-source ingestion remain unverified.

Backend v2 processing now uses separate `v2_pending`/`v2_repair_pending` staging
states, preserving older-publisher exclusion. Public status maps them onto the
existing pending/repair vocabulary, including backlog and overdue counts.
Unsupported v2 raw jobs requeue through bounded owner-locked recovery. Ten parser,
repair and isolated PostgreSQL v2 tests pass
(`/tmp/bud-contact-v2-processing-tests-final.log`); service build passes
(`/tmp/bud-contact-v2-processing-build.log`). Coverage includes reverse arrival,
concurrent publication, ID/history preservation, one concurrent new-contact event,
replay suppression, empty values, repair, legacy field filtering and v1 fallback.

Before advertising capture, all query-serving replicas must enforce explicit
field policies. Once rich records are published, rollback to a pre-field-policy
service is unsafe: it could expose those stored fields under older grants. Keep
the field-policy patch when rolling back processing. No daemon change is needed.

Mobile producer/scan planning now supports v2 under an explicit constructor
choice (default off). It collects structured addresses and original website
values and preserves the existing identity/checkpoint through enrichment and
fallback. Actual encoded envelopes and field/component/list budgets are checked
before the atomic queue/checkpoint commit; failure never truncates or advances.
App-level expanded collection consent, capability refresh, compatible queued
upload and field-coverage UI still need connection before enabling that choice.

The upload engine now checks an injected asynchronous capability before enqueue
for any batch containing v2 Contacts events. Default denies v2. Failure releases
the batch for durable retry, preserving original event bytes and the source
checkpoint; stop/cancellation is rechecked after the await. The app still needs
to supply the authenticated lookup and account consent. Background tasks already
enqueued cannot be retroactively preflighted; keep compatible ingestion available
while they drain during deployment/rollback.

Ten scan/upload-gate simulator tests pass
(`/tmp/bud-contact-v2-upload-gate-tests-final.log`), including denied capability
with unchanged event IDs/bytes/checkpoint and no credential request. Physical
background retry remains unverified; the test host cannot schedule app BGTasks.

The manager now connects capture/upload gates to `ContactsServiceCapability`, an
authenticated uncached status lookup at the configured origin with redirects
rejected. A per-partition expanded collection choice defaults off and is checked
before/after the capture lookup. Missing capability or lookup failure selects
legacy capture; queued v2 upload checks still retain immutable originals. The
setter validates capability before opting in and preserves incremental identity.
Visible collection controls and receipt-based coverage are now connected; server
advertisement remains pending. Two capability request/decoding tests pass
(`/tmp/bud-contact-capability-tests.log`); live HTTP validation remains open.
Simulator app build passes (`/tmp/bud-contact-capability-app-build.log`).

Nine mobile scan/checkpoint tests and the simulator app build pass:
`/tmp/bud-mobile-rich-capture-tests.log` and
`/tmp/bud-mobile-rich-capture-app-build.log`.
Ownership follows the existing authenticated grant endpoint and owner-keyed view;
the server resolves and stamps the acting user without accepting an owner field.

Reviewed migration applied locally after canceling the unrelated invocation
constraint prompt in `db:push`. Eight storage, adapter and metadata tests pass
in `/tmp/bud-agent-fields-storage-tests-rerun.log`; service build passes in
`/tmp/bud-agent-fields-storage-build-rerun.log`. See
[fixture correction](../../debug/agent-fields-storage-fixture.md). No deployment.
All 13 adapter and agent-tool tests pass in
`/tmp/bud-agent-contact-field-tests-rerun.log`; service build passes in
`/tmp/bud-agent-contact-field-build-rerun.log`. The initial build exposed an
outdated test fixture, corrected as documented in
[the debug note](../../debug/agent-contact-field-fixture.md).

Mobile Data sources now provides an immediate-save expanded collection choice,
remounted by signed-in owner and serialized with basic collection changes. A
failed refresh reloads the actual saved preference and reports whether saving or
capture failed. Sync and troubleshooting display the captured receipt's optional
payload version, including unknown coverage for older receipts. Coverage is not
inferred from today's toggle. Disclosures distinguish upload consent from agent
and app access, retained history/queued data, and excluded photos/notes.

Validation: all 10 ContactsSnapshotTests pass, including receipt/checkpoint version
round-trips and old-receipt compatibility (`/tmp/bud-contact-coverage-tests.log`).
The Debug simulator app build passes (`/tmp/bud-contact-coverage-app-build.log`).
Actual toggle interaction, service advertisement and physical-device capture
remain unverified.

Service startup now verifies the deployed grant field column before starting
contact processing or advertising `contacts_payload_v2`. A missing migration
fails readiness. Status stays owner-authenticated and now sends no-store.
Eight focused tests pass, including readiness failure before worker start,
unauthenticated status rejection, owner forwarding and execution of migration
0035 against an existing legacy grant in temporary tables. The migration retains
its original scopes/version and adds only legacy field defaults.
Logs: `/tmp/bud-contact-capability-service-tests-final.log` and
`/tmp/bud-contact-capability-service-build-final.log`. No service restart or live
capture has been performed for this change. All query-serving replicas must still
retain field-policy enforcement before enabling collection against shared data.

## Scope

Add labeled postal addresses and website URLs across mobile capture, event
validation, projection/history, first-party views, agent tools and app-query
policies. Current v1 only collects names, organization, phones and emails; the
missing fields were never uploaded. Preserve original structured address values
and labels, with bounded normalization for display/search. A postal address is
not observation evidence for a meeting, home location or physical presence.
Website display does not fetch the URL; permit safe link schemes and treat all
imported content as untrusted.

Photos and notes remain excluded. Decide a separate thumbnail contract before
implementing pictures: UI-only versus model access, dimensions/bytes, asset
storage and owner-authorized retrieval, change/deletion semantics, caching and
permission policy. Do not inline full-size images into existing event batches.
No Apple Contacts write-back or editor is added.

## Contract and permission migration

Use an explicit versioned Contacts payload plus advertised capability (or prove
an additive equivalent before coding). Preserve v1 readers/processing. Existing
strict field validation means merely adding keys to v1 is not compatible. Old
services must not ACK new fields as successfully projected while dropping them;
new clients should retain supported legacy capture until the richer contract is
available and report actual field coverage.

Define bounds for addresses/URLs and total event size, including large real-world
labeled lists. Do not silently truncate a contact and claim complete synchronization.
Distinguish absent/uncollected fields from observed-empty or deleted values.
Extend cursor/search/projection policies and current/history serializers together.

Do not reinterpret existing grants as permission for new fields. Existing app
keys retain their exact field allowlist; add explicit field choices to agent
consent if needed and obtain expanded consent before supplying the new fields
to models/apps. Clearly disclose the expanded upload field set. Decide the precise
client consent migration before enabling capture, preserving separate OS,
collection, agent/model and generated-app authorization.

## Re-enrichment without new-contact actions

Refresh existing source identities to capture the richer fields and publish
history without generating `contact.added`. Preserve IDs, prior history and
completed actions. Define a checkpointed enrichment/cutover procedure so a
concurrent genuinely new contact is neither duplicated nor silently suppressed.
Do not use a blanket resync as a shortcut without documenting that boundary.
New observations after the enrichment boundary use normal live-addition rules.

## Acceptance and rollout

- [ ] Old mobile/new API and new mobile/old API retain valid capture and honest field coverage.
- [ ] Structured international addresses, multiple labels, empty/removal and large lists round-trip.
- [ ] Unauthorized fields cannot leak through search matches, history, tools, app queries or cursors.
- [ ] Existing contacts gain fields without rerunning actions; concurrent new additions retain correct eligibility.
- [ ] Postal address is never presented as sensor-derived location; unsafe URLs do not execute/fetch automatically.
- [ ] Photos/notes remain excluded until separately specified and approved.

Update shared wire fixtures, TimelineCore event/producer docs, API/agent field
policy, mobile/web displays, DB/migrations if required, protocol and auth
checklists. Keep old stored envelopes immutable. No daemon release required.
Validation: CF1–CF5 plus C1/C3/C4/Q1/Q2/Q5/K6.

Shared v2 validation passed: two service wire tests
(`/tmp/bud-v2-shared-service-tests.log`), service build
(`/tmp/bud-v2-shared-service-build.log`), and two Swift wire tests
(`/tmp/bud-v2-shared-mobile-tests-final.log`). Both fixture copies are byte-identical.
Swift required fresh test packaging after an incremental build retained an older
embedded resource bundle; see `debug/contact-v2-fixture-resource.md` in the main
repo. This proves codec/planner/parser compatibility, not physical capture.

Web Data sources now points to the mobile expanded-collection toggle and search
uses collected-field wording. Web build passes at
`/tmp/bud-expanded-source-web-build.log`. Browser setup still fails before page
access, so this build does not establish rendered/interactive acceptance.

Capability transport validation now passes four Swift tests including a real
loopback HTTP server (`/tmp/bud-capability-http-tests.log`). The client obtains a
fresh bearer per lookup, observes a capability changing true → false despite
cache headers, does not reuse response cookies, rejects HTTP 401, and rejects
302 without requesting its target. No URLProtocol transport substitution is used.
Actual OAuth/account-switch and public-origin behavior remain separate gates.
