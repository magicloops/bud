# personal-data

`contacts.ts` additionally exports the phase-12 `ExpandedContactFields` type and
`parseExpandedContactFields` foundation: required structured postal-address and
labeled URL arrays, bounded components/list sizes and a 240 KiB encoded field
budget. `parseContactPayload` accepts v2 only with an explicit `allowExpanded`
option; the processor uses that option and normal route startup advertises
`contacts_payload_v2` only after checking the deployed field-permission schema. Scan verification
rejects mixed payload versions while preserving existing stored v1 payload shapes.
Tests cover international structure, empty vs uncollected values, private/extra
fields, size limits, version mismatch and repair/addition rules.

Contact queries default every server-supplied policy without a field list to the
legacy four categories. Explicit postal-address/URL permissions apply to SQL
search and current/history projection, with field-bound cursors. First-party
owner reads without a policy retain all collected fields. PostgreSQL coverage
verifies hidden address/URL searches, legacy grants, explicit rich-only reads and
cursor isolation. App policies and the request tool now accept the two new
categories through their existing immutable human approval flow; old keys keep
their stored allowlists. Agent-wide field consent and mobile collection remain
required before enabling rich capture. No schema change in this foundation.

`AgentDataQueries` now forwards the grant's explicit field choices to contact
search, history and the owner-contact lookup for location context, and reports
the effective choices in `permission.contact_fields`. Unknown categories grant
no access. Persistent grants default to the legacy four categories and accept
explicit field choices through the existing owner-bound update. Omitted fields
preserve saved choices for older clients; explicit empty lists remove all field
access. Every change advances the existing optimistic version. Grant responses
advertise `supported_contact_fields` for compatible client controls; web toggles
and mobile controls are connected. Adapter tests cover rich-only forwarding,
model-injected policy rejection and field revocation during a query. Automation
grant-version checks continue to fence any subsequent permission expansion.

- `grants.test.ts`: dedicated-connection PostgreSQL temporary-table fixture for
  persisted field choices, legacy defaults, old-client preservation, owner
  isolation, invalid categories, empty allowlists and stale versions.

Agent existing-contact selection is now also registered in
`automation-tool-contracts.ts` as `automations_request_existing_contacts`. It
shares the strict bootstrap review schema, rejects human authority fields and
remains separately gated from activation. Worker and agent-loop integration
preserve the repository's proposal/no-work distinction; startup and client review
enablement remain pending. See the agent bootstrap review plan for validation.

## Purpose

App issuance is now wired through the startup-only `APP_DATA_KEYS_ENABLED=1`
setting, which requires durable invocation mode. It controls the request tool,
human approval endpoint and shared `features.app_keys` capability together.
Default remains off; inventory, decline/revoke and installed-key queries remain
available independently. Runtime schema readiness is checked before execution.
Live end-to-end validation remains required.

Main-service personal-data ingestion, Contacts/location projections and first-party queries. Raw events belong to the authenticated user independently of Buds/threads. Agent query integration, automation and app credentials remain in progress under the [implementation plan](../../../plan/personal-data-ingestion-and-agent-triggers/implementation-spec.md).

## Files

- `wire-contract-v2.json`: synthetic shared expanded contact records and manifest with international structured addresses, multiple labels, original untrusted website strings and observed-empty arrays. Identical bytes are bundled into mobile tests.
- `wire-contract-v1.json`: synthetic shared v1 envelopes and ACK examples; identical reviewed bytes are bundled into mobile package tests.
- `wire-contract.test.ts`: pins both shared fixture hashes and checks v2 field preservation/manifest membership plus plain/gzip envelope preservation, baseline manifest validation and actual HTTP ACK serialization with injected persistence/authentication. See the [fixture catalog](../../../plan/personal-data-ingestion-and-agent-triggers/fixture-catalog.md).

- `example-app/` → [example-app.spec.md](./example-app/example-app.spec.md): private loopback contact search/history/location acceptance app using the approved backend helper, with fixed assets and read-only query forwarding. Live private-viewer/agent setup demonstration remains open.

- `app-key-backend.mjs`: standalone downloadable Node backend helper with only built-in imports. Generates/preserves an app-local RSA identity, pins API origin, exposes only public initialization metadata, retrieves/decrypts approved credentials, durably writes private state before signed receipt and retries lost acknowledgements without reminting. Backend query method reads credentials internally, restricts resource paths, rejects redirects and bounds timeout/response bytes. Default private state stays outside app worktrees; custom trusted state roots must not be served or checked into Git.
- `app-key-backend.d.mts`: TypeScript public contract for the standalone helper; private material is absent from return types.
- `app-key-backend.test.ts`: concurrent initialization, mode checks, symlink/unsafe-state rejection, tampered delivery, API-origin pinning, private persistence before receipt and lost-acknowledgement recovery.

- `app-key-routes.ts`: mounted owner-authenticated permission inventory/detail/decision/revoke, separately authenticated app-query routes and signed setup routes. Approval issuance follows the shared startup capability; durable agent continuation is connected. No-store responses, bounded setup/decision bodies, strict argument contracts and fixed error logging. See [API contract](../../../plan/personal-data-ingestion-and-agent-triggers/implemented-app-data-api.md).
- `app-key-maintenance.ts`: service-owned lazy bounded expiry polling, independent of clients/automation activation; clears timers and awaits in-flight work on shutdown. Started by normal personal-data registration and included in its composite stop handle.
- `app-key-routes.test.ts`: human/app/proof auth separation, disabled issuance with owner-first lookup, owner-bound arguments, body limits, no-store, secret-free logs and expiry-worker shutdown draining.

- `app-keys.ts`: owner-locked app permission repository. Fenced running invocation/action intents create immutable requests; human decisions atomically mint one verification/encrypted-envelope record. Strict ordinary serializers omit credential/delivery material. Signed app-only retrieval and installation support retries after restart; installation deletes ciphertext. Owner revoke and bounded expiry invalidate setup; installed-key authentication and post-read permission checks verify current key/request/private-site ownership without a positive auth cache. Routes and runner continuation are connected; issuance requires the explicit startup capability.
- `app-keys.test.ts`: PostgreSQL ownership/intent/lease checks, request/approval races, immutable retries, injected transaction rollback, encrypted recovery/decryption, receipt separation, ordinary serialization, installation, revoke, expiry and owner-bound pagination.
- `app-queries.ts`: query-key adapter for mounted contact search/detail/history and location timeline/context routes. Enforces app-specific scopes/history/field restrictions, SQL search/projection policy, key/version cursor binding, two-decimal or collected coordinate precision and post-query revocation checks. App grants are distinct from owner-wide agent permissions.
- `app-queries.test.ts`: scope/history/limit enforcement, SQL-policy forwarding, coordinate rounding without raw-source metadata, context evidence and revocation-during-read withholding.
- `contact-field-policy.test.ts`: PostgreSQL real-query validation using temporary projection tables: name-only grants cannot match hidden phone/email/organization values, current/history projections omit those fields, owner/history filtering holds, and contact/location cursors cannot cross policies or keys.

- `app-key-storage.test.ts`: executes the checked-in phase-7 migration in a rolled-back isolated schema, checking dependency order, owner/thread/site/action associations, duplicate calls/keys, decision attribution and encrypted-handoff state invariants.

- `app-key-contracts.ts`: strict phase-7 request/policy, decision, revoke and setup-proof schemas. Owner/execution identities cannot be supplied by tools; fields and location precision must match scopes; only a public installation key is accepted. Decisions cannot edit the reviewed request. The app-key repository enforces the same immutable policy.
- `app-key-contracts.test.ts`: injected authority rejection, recipient normalization, scope/field/precision consistency and explicit immutable human decisions.

- `app-key-crypto.ts`: app-key handoff primitives: 256-bit query credentials with verification-only hashes, strict RSA public-recipient validation, context-bound OAEP encrypted delivery and separate PSS retrieval/installation proofs. No routes or issuance permission are provided by these primitives; stored owner/state/expiry checks belong to the phase-7 repository. See the [handoff contract](../../../plan/personal-data-ingestion-and-agent-triggers/app-key-handoff.md).
- `app-key-crypto.test.ts`: wrong key/context rejection, private/weak/unsupported PEM rejection, credential verification, explicit envelope serialization and retrieval/installation proof separation.

- `automation-worker.ts`: explicitly started serial polling of matching, live admission and bootstrap admission, at most 25 rounds per poll by default. Each queue gets a turn despite another failing; logs only fixed error codes. Stop clears timers and drains the current transaction before any further admission.
- `automation-worker.test.ts`: lazy start, duplicate-start prevention, bounded/failure-isolated polling and stop-before-next-operation lifecycle tests.

`AutomationBootstrap.captureInTransaction` is the internal shared-transaction
boundary for future typed human decisions. Manual capture and combined activation
delegate through it, preserving owner locks, retry identity and group creation.
The contact processor PostgreSQL fixture injects failure after member/group writes
and verifies no bootstrap work survives the enclosing transaction rollback.
`freezeReviewInTransaction` selects bounded ordered revision IDs under the owner
lock and binds the active definition, rule/grant versions and publication boundary.
`captureReviewedInTransaction` revalidates only those IDs, rejects changed eligibility
instead of replacing members, and retains the original receipt on accepted retries.
These are internal repository operations; persisted proposal storage and human
decision authorization are not yet connected. The fixture covers foreign-owner
rejection, hidden-member invalidation, exact membership and retry after eligibility
changes, with rollback of the surrounding decision transaction.

- `bootstrap-admission.ts`: owner-locked admission of one frozen group into one durable invocation/thread, with current source/grant/target checks, receipt deadline and shared live/bootstrap daily limits. Group and invocation commit together. Scheduled only by the explicit development automation setting; integration gates remain open.

- `automation-bootstrap.ts`: owner-serialized, idempotent capture of at most 1000 frozen contact revisions with source/search/history filters, publication boundary and groups of at most 25. Default exclusion covers pending/admitted live deliveries and pending/admitted bootstrap groups, including admitted groups whose parent request was canceled. Owner-scoped receipt and bounded ordinal pages expose frozen evidence IDs with request-bound cursors. Shared gated capture/combined-activation routes and owner-only read routes are mounted. Combined activation shares one transaction and lock; failed membership capture rolls back activation, and retries preserve the original receipt without reactivation. Capture also materializes durable pending groups in the same transaction. Group admission is implemented separately; Dispatch checks and owner-authorized cancellation are connected; cancellation marks queued groups canceled and requests cancellation of admitted invocations while retaining running reservations until acknowledgement. Progress reads derive effective group states from canonical invocations with bounded group pages, status counts, conversation references and a settled flag distinct from request cancellation. Read-only repeatable-read preview uses the same bounded snapshot selector for saved drafts or active revisions, validates observed rule/grant versions and never activates or persists work. Owner/rule-bound request-list pagination supports recovery across devices. Client controls and scheduling remain pending.

- `automation-policy.ts`: live-delivery or bootstrap-group/revision/owner-bound dispatch authority lookup. Bootstrap checks every frozen group member against current source lineage, visibility and history permission; canceled requests fail closed. Validates immutable target/model, current grant version/scopes/history and non-revoked source lineage. Resolves per-turn data ceilings only for running, leased, uncanceled invocations, with immutable rule scopes/history and invocation/fence/revision cursor binding. Pause defers preflight using `retry_wait`; running checkpoints ignore pause but enforce revocation. Missing or foreign delivery associations fail closed.

- `automation-admission.ts`: owner-serialized delivery admission, current grant/source/target validation, pause/deadline handling and rolling 24-hour owner/rule budgets shared with bootstrap admission through `automationUsage`. Allocates a new thread or resolves the selected existing thread and commits input/invocation/delivery association together. No model calls; remains unscheduled until dispatch policy checks are connected. Contact processor fixtures cover concurrent admission, no duplicate thread, pause, expiry, limits and revoked grants.

- `automation-matcher.ts`: owner-locked durable domain-event matching with publication-time revision selection, source filtering, deadline classification and idempotent delivery insertion. Historical unsequenced events are marked matched without live deliveries. Selected bootstrap membership suppresses delayed live matching at or before the captured boundary, including after snapshot cancellation. Does not call models; the optional automation worker schedules matching and admission.

- `automations.ts`: owner-serialized draft create/update, explicit activation and pause repository. Exposes transaction-scoped create/update/pause for atomic agent mutation receipts and activation for proposal/bootstrap composition. Pause uses optimistic versions and separate queued/active cancellation choices for live deliveries and bootstrap groups, with shared invocation cancellation in the same transaction. Pending-only cancellation preserves started bootstrap continuations; active cancellation follows their input activation stamp. Rechecks owned sources/targets and exact model/reasoning, compares current grant version/scope/history, inserts a revision at the locked publication boundary, and preserves active revisions while editing drafts. Caps an owner at 100 rules so one event has bounded matching work. Owner-scoped list/detail and bounded delivery-history reads are mounted; create/update/pause mutations are mounted with owner checks and optimistic versions. Activation has an owner-authorized POST endpoint gated by a server-supplied capability (off by default). It records explicit standing-work consent with rule/grant version checks. Stable owner-bound creation retry keys dedupe unchanged drafts; a retry after subsequent edits returns conflict rather than overwriting. Detail reads expose draft and active definition from one SQL snapshot; history cursors bind owner/rule and seek by delivery ID. Bounded history adds owner-scoped invocation state and thread/Bud identifiers for transcript links.
- `automations.test.ts`: opt-in PostgreSQL cross-owner/source rejection, consent/version/revocation checks, concurrent activation, frozen boundaries, draft/revision separation, read ownership and invalid/foreign history cursors.

- `automation-proposals.ts`: owner-locked frozen proposal repository. Fenced human-origin invocation/action intents capture draft and grant versions, dedupe retries and enforce pending limits. Typed human decisions atomically activate the exact reviewed version, preserve decision retries and reject cross-owner access. Reads reconcile expired, abandoned and stale proposals; bounded expiry is available for service maintenance. Runner parking/continuation, routes and maintenance scheduling remain pending.
- `automation-proposals.test.ts`: PostgreSQL intent/fence/origin and owner rejection, concurrent creation/approval, conflicting decisions, restart retries, draft/grant invalidation, explicit/automatic cancellation, expiry, cursor binding and injected decision-write rollback of activation.
- `automation-proposal-routes.ts`: mounted encapsulated human-only inventory/detail/decision/cancel routes, with explicit bearer precedence, owner resolution, no-store responses, bounded decision bodies and redacted errors. Approval gate follows owned lookup; decline and cancel remain available independently. `routes.ts` shares the `features.automation_proposals` capability and requires both automation activation and the proposal composition option; production does not enable that option yet.
- `automation-proposal-routes.test.ts`: unauthenticated/app-key rejection, foreign-owner lookup before approval gating, strict decision/query bodies, bounded payloads and owner forwarding. Actual auth integration is separate.
- `automation-proposal-maintenance.ts`: bounded serial expiry polling started by normal route registration, independent of open clients. Stops timers and drains active expiry before database shutdown through the shared stop handle and preClose hook.
- `automation-proposal-maintenance.test.ts`: explicit/idempotent start, shutdown draining, no subsequent batch work after stop and error reporting. Route tests additionally verify mounted inventory precedence and approval/capability agreement.
- `automation-proposal-contracts.ts`: strict initial agent draft/default, activation proposal request and human decision/cancel schemas plus bounded expiry/inventory constants. Agent bodies cannot carry owner, approval, grant or bootstrap authority. Shape normalization preserves server-selected defaults; repository checks supply execution and decision authorization.
- `automation-proposal-contracts.test.ts`: default preservation, explicit target selection, injected authority rejection, unsupported trigger/limit rejection and immutable decision body coverage.
- `automation-tool-contracts.ts`: strict schemas and name guard for seven automation management operations. Optional top-level provider nulls normalize only for known optional fields; injected authority and unknown fields remain rejected. Full replacement draft edits and explicit pause cancellation scopes are required. Agent runtime execution remains pending.
- `automation-management.ts`: fenced human-origin list/get/history and draft/create/update/pause execution. Reads require the matching live action intent and recheck invocation authority before returning. Owner and invocation locks precede writes; transaction-scoped rule mutations and frozen JSON action receipts commit together. Same-lease retries return the stored result without repeating writes and changed arguments fail. Omitted or provider-null create targets use the server-owned originating invocation thread; explicit targets and stored receipts remain unchanged. Defaults use the exact invocation Bud/model/reasoning and bounded requested data access without creating consent. Worker hooks supply server-owned context; agent-loop dispatch remains pending. Isolated invocation proposal tests cover read authority, receipt dedupe, defaults, origin/fence rejection and receipt-write rollback.
- `automation-proposal-storage.test.ts`: executes migration `0033` in a rolled-back isolated PostgreSQL schema; verifies owner/rule/thread/Bud/action associations, duplicate proposal and decision rejection, complete human attribution, expiry/version bounds and same-rule approved revision linkage. Runtime proposal lifecycle remains pending.

- `automation-contracts.ts`: strict snake_case draft/revision, activation, pause and existing-contact processing schemas. Explicit target/model/grant settings, bounded work and separate standing-work/rerun acknowledgements; shape validation does not authorize targets or activate rules.
- `automation-contracts.test.ts`: both thread targets, bounded settings, rejection of injected owner/activation/fallback fields, and explicit activation/rerun consent.
- `automation-bootstrap-review-contracts.ts`: separate agent-requested existing-contact selection and review-kind schemas. Reuses bounded source/search/mode limits; rejects human acknowledgement, owner/grant and frozen membership arguments. These contracts do not yet expose a tool or capture work; see the [review design](../../../plan/personal-data-ingestion-and-agent-triggers/agent-bootstrap-review.md).
- `automation-bootstrap-review-contracts.test.ts`: explicit repeat intent, bounded selection, injected authority/evidence rejection and separation from activation requests and human decisions.
- `automation-bootstrap-proposal-storage.test.ts`: isolated execution of migration 0034, verifying proposal context/owner, contact membership, call/member dedupe, bounded count/fingerprint, complete decision attribution and approved receipt ownership. Runtime transitions remain separate.
- `automation-bootstrap-proposals.ts`: fenced human-origin review creation with bounded frozen membership, canonical fingerprint and relational evidence. Owner-locked decisions verify originating action/reservation, expiry, versions, target and evidence integrity before capturing exactly reviewed contacts in the same transaction. Empty selection returns no work without a proposal. Approvals preserve one receipt; decline/cancel/expiry start no work. Inventory and expiry are bounded and owner-scoped. No routes or runner hooks expose this repository yet.
- `automation-bootstrap-proposals.test.ts`: isolated PostgreSQL indexed-table fixture covering no matches, request/decision dedupe, lease/origin/intent rejection, foreign reads, no reactivation, default prior-work exclusion, explicit repeat reviews, decline/cancel/expiry, lost intent, membership staleness and decision-write rollback. FK behavior is covered separately by the migration fixture.
- `automation-bootstrap-proposal-routes.ts`: mounted human-only existing-contact review inventory/detail/decision/cancel routes. Bearer precedence, owner-first decisions, no-store, bounded request bodies and fixed error logging mirror activation reviews while using separate paths/storage. Approval requires the dedicated composition option as well as automation/proposal enablement. Service-owned expiry uses the existing bounded maintenance class and shared stop handle.
- `automation-bootstrap-proposal-routes.test.ts`: anonymous/app-key rejection, owner forwarding, strict decisions/query fields, body bounds, static inventory-route precedence, separate decline/cancel and mounted capability/approval agreement for all gate combinations.

`Automations.validateTargetsInTransaction` is the shared internal target/model/source
validator used by both activation and existing-contact proposal decisions. It
checks owned targets and exact model selection without publishing a revision.

- `agent-queries.ts`: server-owner-bound adapter for `contacts_search`, `contacts_history`, `location_context` and `timeline_query`. Checks current scopes before reads and the same grant version before delivery; automation queries additionally intersect the immutable rule scope/history ceiling and require its approved grant version; applies SQL contact/revision history bounds, binds contact cursors to policy version, and rejects location windows older than consent. Context requires both scopes. Registered through the agent's personal-data executor.
- `tool-names.ts`: dependency-free tool names and discriminated type shared with agent contracts.
- `agent-queries.test.ts`: scope isolation, attempted owner argument rejection, history-bound forwarding, location-window denial and concurrent permission-change result withholding.
- `location.ts`: validates existing visit/significant-change payloads; SQL owner-scoped bounded time queries and nearest observation to contact detection, preserving accuracy, source and receipt times and explicit uncertainty. Timeline pagination accepts an optional server-only cursor binding for app key/version isolation; default first-party cursor encoding remains unchanged.
- `location.test.ts`: coordinate/accuracy/visit validation and explicit bounded time-window fixtures.
- `grants.ts`: owner-wide agent read permission state, default-deny scopes, history-days setting and owner-locked compare-and-swap updates. Explicit nullable timestamp response matches absent-grant behavior. `verifyFieldSchema` performs a zero-row column check before expanded capture readiness.
- `location-grants.test.ts`: opt-in PostgreSQL projection/backfill, pagination, nearest/missing evidence, revocation/version conflict and Fastify anonymous/foreign-owner checks.
- `contacts.ts`: processing-only Contacts payload/manifest validation and canonical event-set digest verification. Selects approved fields explicitly; allows up to 1,000 phone/email entries per array within the raw ingestion byte cap, including large real-device contact lists.
- `contacts.test.ts`: baseline-action suppression, approved-field validation, complete/unique manifest membership and empty scan fixtures.
- `contact-processor.ts`: transactional raw-job staging and owner-serialized generation publication; complete scans update contacts/revisions and emit only incremental first-observation domain events. Rebuild mode suppresses events. Raw work failures retry after 30 seconds and become failed after ten attempts; database transactions recover interrupted processing.
- `contact-processor.test.ts`: opt-in PostgreSQL reverse-arrival, missing-member/predecessor, concurrent publication, replay and rebuild tests.
- `contact-repair.test.ts`: PostgreSQL complete-replacement repair across missing generations, incomplete/reversed upload, concurrent publication, retained contact IDs/history, absent-contact visibility, late/stale old events, empty replacement and non-repeated domain actions. Uses indexed table copies in a disposable isolated schema so a running service cannot consume fixture work; FK migration coverage remains separate.
- `contracts.ts`: bounded v1-compatible envelope validation, canonical JSON hashing, batch/error types and byte/count limits. Optional top-level `collection_epoch` matches `X-Collection-Epoch`; absent values map to `legacy`.
- `parser.ts`: bounded plain/gzip NDJSON decoding before persistence, fatal UTF-8 handling and per-line redacted rejections. Entire request is parsed before DB writes; corrupt gzip cannot ACK a subset.
- `repository.ts`: Postgres transaction for owner-bound installation/epoch registration, quotas, immutable events and one processing job per event. Intra-batch or stored-payload identity conflicts are rejected. Status queries filter by owner in SQL, including a bounded contact-source inventory with installation/epoch labels, revoked status and truncation flag for rule authoring.
- `contact-queries.ts`: owner-scoped contact list/search/detail/history with owner/filter/policy/field-bound cursors, literal wildcard handling, bounded page count/output bytes and optional server-supplied observation cutoff. Optional app field restrictions apply to both SQL matching and SQL current/history projections. First-party routes do not accept policy from requests and retain their full approved-field view.
- `routes.ts`: encapsulated Fastify parser and authenticated `POST /v1/events/batches`, plus `GET /api/data/status`, contact list/detail/history, automation list/detail/delivery history, and processor lifecycle. Returns an idempotent async `stop` handle that the composition root awaits before pool shutdown; also drains at `preClose`. Explicit supplied bearer takes precedence over cookie identity. No standalone ingest development-user fallback. Normal composition verifies the field-permission schema before starting its processor or advertising expanded capture; status responses are no-store. Injected repository fixtures default to no expanded capability unless they supply a readiness check.
- `parser.test.ts`: old/unknown envelope compatibility, deterministic hashes, partial rejection, ownership mismatches, invalid data/gzip and all byte/count limits.
- `repository.test.ts`: opt-in local PostgreSQL integration tests (`BUD_DATA_DB_TEST=1`) for concurrent dedupe, conflicts, owner isolation, rollback and revocation. Passed after explicitly supplying the Better Auth fixture email-verification flag; see the [debug note](../../../debug/personal-data-ingestion-db-test-failure.md).
- `routes.test.ts`: Fastify injection coverage for auth, owner context, explicit ACK, parser isolation, no ACK on repository failure and draining held processing before database finalization. PostgreSQL durability validation is separate.

## Ownership and persistence

Status now aggregates owner-wide failed/invalid jobs and invalid/day-old pending
scans independently of its bounded detail page. Repair state takes precedence over
pending work. Scan details identify missing predecessors/manifests/records and
include received/expected counts; age never advances or abandons a checkpoint.
Repository PostgreSQL fixtures cover diagnostics, foreign-owner isolation, failures
outside the recent-page limit and restored ready state. No schema change.

Five schema records: `data_owner_state`, `data_installation`, `data_collection_epoch`, `data_event`, `data_processing_job`. All have `created_by_user_id` and nullable `tenant_id`; composite FKs prevent cross-owner installation/epoch/event/job relationships. A physical installation may have separate partitions for different authenticated users. Owner identity never comes from its envelope.

First authenticated ingestion registers its owner/source/epoch. Revoked sources/epochs cannot upload. A locked owner-state row serializes registration and quota accounting. Same `(owner, event_id)` plus identical canonical hash is a duplicate ACK without another job; conflicting content is rejected and original preserved. All new events/jobs and quota changes commit together before success. Contacts jobs are staged and published by the background processor; supported v1 location jobs normalize independently. Previously unsupported v1 location jobs requeue in bounded owner-locked batches; invalid/failed/processed jobs are not requeued. Unknown/health types remain raw with unsupported status. Status reports pending/invalid scans and source freshness.

Limits: 5 MiB encoded, 25 MiB decoded, 256 KiB per line and 500 nonempty lines. Per-process admission permits four uploads, at most one per owner; DB accounting limits an owner to 60 committed batch requests/minute and 1 GiB canonical raw content (constructor-overridable for development/tests). These are operational budgets, not retention/deletion promises. Error logs omit database parameters and raw payloads.

## Dependencies

Fastify, existing bearer/cookie viewer helpers, Drizzle/PostgreSQL, ULID, Node crypto/zlib/util. No added package dependency, LLM call, daemon wire change or external ingest service.

## Validation / remaining phase gates

Focused tests and schema/build validation must be recorded in the implementation checklist. Real OAuth/public-origin/device delivery, PostgreSQL failure injection and deployment migration verification are required before marking phase 1 complete. Later phases add projections/queries, Contacts producer, durable agent invocation and approved app keys.

## Contact publication foundation

V2 records/manifests now publish through the same owner-serialized pipeline,
using `v2_pending` / `v2_repair_pending` staging states that older publishers
cannot consume. Status maps those states to the existing public pending/repair
vocabulary and includes them in backlog/reconciliation counts. Supported raw
recovery includes v2 types. Enrichment preserves identities/history and emits
only genuinely new incremental additions; repairs and replay remain suppressed.
`contact-v2.test.ts` covers reverse arrival, unsupported-job recovery, concurrent
publication, legacy query restrictions, empty fields, repair and v1 fallback in
an isolated PostgreSQL schema. Rich mobile capture remains disabled until consent,
capability and upload compatibility are connected. After rich publication,
rollback must retain field-aware query filtering; pre-field-policy services are
not a safe rollback target because they could expose stored rich fields.

Distinct `contacts.repair_record.v1` / `contacts.repair_scan.v1` events parse as
resync-only complete replacements with an internal repair marker. Staged repairs
use `repair_pending`, preventing an older publisher from
consuming a staged repair during rollback. New status queries include this state
in pending/overdue counts and report missing members instead of skipped predecessors.
Only verified
complete repairs may skip predecessor/observation linkage. Publication retains
source/contact IDs, hides absent prior contacts with revisions, supersedes earlier
unpublished scans and advances the source atomically without domain events. Late
records covered by a published repair receive a superseded processing status.
Existing published scans and action history remain untouched. Ordinary v1 scans
still require exact predecessor linkage. Mobile durable capture/explicit consent and the shared capability are connected.
The existing bounded unsupported-job recovery also requeues repair types;
see [repair contract](../../../plan/personal-data-ingestion-and-agent-triggers/contact-source-repair.md).

Migration `0025_careful_trauma.sql` adds source, scan, staged record, current contact, revision and domain-event tables. All associations carry composite owner foreign keys. Publication uses the existing `data_owner_state` row lock before any source mutation; future rule activation/bootstrap must use the same lock. Processing contains no network/model calls, so transaction rollback recovers interrupted work. Raw ACK is separate from publication. The routes module starts bounded background processing at server readiness and drains active work at shutdown. Query routes use cookie/bearer viewer ownership and SQL filtering. Migration `0026_supreme_human_cannonball.sql` adds location observations and versioned agent grants. First-party self reads need no agent grant; agent tools use the grant-aware adapter and independently authorize thread/Bud ownership. Generated-app access remains pending. The [implemented API](../../../plan/personal-data-ingestion-and-agent-triggers/implemented-contact-api.md) documents routes and current limitations.

## Commit-safe automation boundary

Contact publication now increments the owner counter and stamps each live domain
event in the same owner-locked transaction. Baseline/rebuild/replay do not advance
it. Activation and bootstrap must use this same lock and counter; legacy null
sequences remain historical. The processor PostgreSQL fixture verifies this and
the new automation revision/delivery ownership and dedupe constraints.

## Automation deletion (phase 14)

`automations.ts` adds human-authorized versioned deletion. Under the owner lock it
uses existing pause/cancellation transitions, cancels pending bootstrap requests,
marks pending activation/bootstrap reviews stale and sets terminal `deleted`.
Queued invocations cancel immediately; running invocations retain reservations
until acknowledgement; uncertain `needs_review` runs require their existing review.
List and quota queries exclude tombstones in SQL; owner-only detail/history retain
revisions and conversations. Mutable loads reject tombstones, bootstrap preview,
review and fresh capture reject them, and activation proposal creation rejects them.
Matcher excludes deleted rules, admission fails closed and dispatch/data policy
rejects deleted authority even at running checkpoints that otherwise ignore pause.

`routes.ts` mounts `POST /api/automations/:id/delete` with a strict
`expected_version` body, 1 KiB limit, no-store response and existing human viewer
resolution. No agent deletion tool or app-key authority is added.
`automation-delete.test.ts` executes migration 0036 in an isolated indexed schema
and covers injected HTTP auth, ownership/version/body bounds, concurrent retries,
transaction rollback, live/bootstrap cancellation, retained history/review
reservations, stale proposals, dispatch denial, delayed matching and freed quota.
See [phase 14](../../../plan/personal-data-ingestion-and-agent-triggers/phase-14-automation-deletion-and-chat-status.md).


## Automation context filters (phase 15)

Agent draft creation retains the current invocation's resolved model/reasoning
for omitted or provider-null arguments. Unsupported explicit create selections
return the attempted pair and inherited pair with omit/null recovery guidance;
they are never silently substituted. The isolated invocation proposal fixture
covers both default forms and failed-override rollback. See
[debug note](../../../debug/automation-model-defaults.md).

`GET /api/automations` accepts optional `bud_id`, `thread_id` (requires Bud),
and `state=enabled|paused|draft`; unknown query keys are rejected. The human
viewer is resolved first. Bud/thread ownership and matching Bud are checked
before the owner-filtered list. SQL predicates use the active revision when one
exists and the draft otherwise, before the existing 100-rule bound; deleted rules
remain excluded. Response adds `context_filter: true` and per-item
`active: { revision, definition } | null`, retaining all old fields. No rows are
stamped by these reads. Existing clients/daemons require no changes.
`routes.test.ts` covers auth and strict filter forwarding;
`automations.test.ts` verifies foreign context rejection and active-target
selection despite draft edits. Full contract and rollout: [phase 15](../../../plan/personal-data-ingestion-and-agent-triggers/phase-15-data-navigation-and-workspace-style.md).

## Thread-scoped agent authoring

`automation-tool-contracts.ts` accepts optional `scope: thread | all` for listing;
omission/provider-null defaults to thread. `AutomationManagement` resolves the
Bud/thread from the live fenced human invocation and reuses `Automations.list`
SQL owner/active-target filters. Explicit all remains owner-wide; reads recheck
invocation authority before returning. Results include scope/current_thread_id.
New-thread-per-run rules are visible through all scope, not attached-thread scope.

Automation proposal detail/list/decision serializers add `review_operation`
(create/update), derived from immutable revisions at or before draft_version,
and `destination_thread_title` from an owner/Bud-scoped nondeleted thread lookup.
Initial tool/snapshot payloads retain their original shape; clients fetch details
before approval and use neutral wording on older services. Titles are current
presentation metadata; the frozen definition's target ID remains authoritative.
No schema, grant or standing-rule mutation is introduced by this feature.
See [plan](../../../plan/thread-scoped-automation-authoring.md).

## Contact trigger evidence (phase 18)

- `automation-contact-context.ts`: first-start, owner-locked evidence builder for
  admitted live deliveries and bootstrap groups. Resolves authoritative revision
  references from relational tables, intersects current fields/history with the
  approved automation scope, and serializes exact observed revisions as explicitly
  untrusted JSON. At most 25 contacts and 64 KiB of fields; oversized records keep
  IDs/times with an explicit omission reason and contacts_get recovery guidance.
- `ContactQueries.getRevision` reads an exact owner/contact/revision association,
  including historical fields/visibility and source/observation information, with
  the existing SQL field projection and revision-time history bound.
- `AgentDataQueries` and `tool-names.ts` expose contacts_get(contact_id, revision_id?)
  with the normal scope/ceiling and post-read grant checks. Omitted/null revision
  selects current contact; specified revision never substitutes current fields.
- Tests cover foreign/mismatched IDs, old revisions, field filtering, query-time
  revocation, live/bootstrap startup evidence, later edits, oversized fields and
  unchanged admission retry identity after context enrichment.

Evidence is written to owner-scoped conversation history only at first start;
revocation stops subsequent automated execution/read access, not historical text.
No schema migration or mobile/daemon change is required.

## Automation model inheritance (September 2026)

This supersedes the earlier copied-model default. `automation-model.ts` resolves
`model_mode: inherit | explicit` using owner/Bud-scoped source reads. Existing
thread targets follow their destination; new-thread targets follow the immutable
`origin_thread_id` in the definition, or the service default. Agent origins come
from the fenced invocation; updates preserve origin (changing Bud clears it).
`automation-model.test.ts` covers source changes, retirement/reasoning fallback,
local-model exclusion, owner isolation, deleted origins and migration replay.

Definitions retain top-level model/reasoning fields; only explicit mode uses
them as overrides. Agent omission creates inherited policy rather than copying
the current invocation. Fresh explicit choices are validated; persisted retired
cloud choices fall back without changing the saved policy. Activation and
existing-contact reviews permit this documented fallback. Provider outages and
missing local capabilities are not retirement.

Both admission paths freeze the resolution in input-message
`metadata.model_resolution` and the existing invocation model/effort columns.
Dispatch checks snapshot integrity, target and permission, never the source's
newer model. Bad default configuration fails delivery with
`default_model_unavailable`. Pre-cutover invocations retain their saved models.
Lists/details return `model_resolution` for active behavior and
`draft_model_resolution` separately; review detail resolves the reviewed policy.
Delivery history returns actual invocation model/effort and its recorded resolution.
Reads do not change preferences or grants. Migration 0038 marks prior definitions
inherited; see [implementation plan](../../../plan/automation-model-inheritance-and-fallback.md).
