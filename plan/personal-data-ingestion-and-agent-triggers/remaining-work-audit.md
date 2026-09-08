# Remaining implementation and acceptance audit

## Current handoff — September 7, 2026

The development feature is implemented through phases 1–7 and 9–14, including
agent-managed reviews, originating-conversation defaults, deletion, single-action
Stop, and the mobile viewer follow-up. Phase 8 remains the integration and rollout
gate. This is development evidence, not production acceptance.

User testing confirmed contact queries, improved Sync now feedback, agent-created
automations, automation deletion/UI cleanup, private contact-app queries, denial
of unauthenticated public access, and revocation blocking subsequent queries.
Mobile preview testing covered navigation, reduced bounce, floating controls and
the larger drag-dismiss area. The latest stable named-loading fix built and was
installed; its specific visual retest is still outstanding.

The remaining conditions of the six phase-8 demonstrations are still open:
opposite-client conflict/denial/recovery, existing-contact cutover and retry,
selected-Bud/model offline and dispatch-crash recovery, physical background and
account-switch cases, signed-in second-user isolation, complete credential-channel
audit, operational measurements, and deployment/mixed-version evidence. Passing
a happy path does not establish these conditions.

Track actionable follow-ups in [TODO.md](../../TODO.md), with exact scenarios in
[the validation matrix](validation-checklist.md). Health enhancements, regions,
the viewer-authenticated broker, production retention/encryption and shipped
queue disposal remain deliberately deferred. Keep existing HealthKit code.

Current local development has the feature flags enabled and an unlocked iPhone
has been used successfully. Earlier disabled-flag, unavailable-phone and blocked
acceptance notes below describe historical observations, not current blockers.
Browser/desktop automation tooling remains deferred; user device observations
are recorded separately from automated tests.


Working-tree audit, September 4–5, 2026. Full-plan completion is **not proven**.
No phase acceptance checkbox is closed by this audit. Tests below establish only
their named boundaries; simulator tests do not establish physical-device behavior.

Consolidated regression: `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test
src/personal-data/*.test.ts src/agent/invocation*.test.ts
src/agent/app-permission-tool.test.ts src/agent/personal-data-tools.test.ts
src/invocation-startup.test.ts` from `service/` passed **75 tests, zero failures,
zero skips**. Log: `/tmp/bud-personal-data-consolidated-tests.log`. This covers
the named local fixtures, not the six real-client/provider/device demonstrations.

Local legacy inventory is recorded in [legacy-inventory.md](legacy-inventory.md):
six standalone `dev` rows remain unmapped and untouched; two inspected legacy
simulator queues are empty. Remote deployment/database and physical-phone queue
inventory remain unverified. Browser bootstrap again failed before browser
initialization; the physical iPhone remained unavailable.

## Current runtime evidence

- `xcrun devicectl list devices`: iPhone 17 Pro Max
  `B919B7B9-512F-5AD2-B247-46A46666BCFB` is unavailable. Physical Contacts,
  first-unlock, BGTask and OS-driven relaunch checks cannot run yet.
- `lsof -nP -iTCP -sTCP:LISTEN`: local service listens on 3000, web on 5173,
  Caddy on 3443. Listening ports do not prove current feature flags, authenticated
  client state, provider availability or public-origin behavior.
- Main-service opt-ins are `AGENT_INVOCATION_MODE=durable`,
  `AUTOMATIONS_ENABLED=1`, and `APP_DATA_KEYS_ENABLED=1`. App-key/automation
  enablement requires durable mode. Runtime flags have not been inferred from
  source defaults or changed by this audit.

## Validation matrix coverage and missing proof

| Cases | Current evidence | Still required |
|---|---|---|
| I1–I9 | Parser/repository/route fixtures and local migration work exist | Re-run consolidated suite; public-origin old location/health delivery; failure boundaries and deployed compatibility evidence |
| M1–M9 | 18 TimelineCore tests pass; strict ACKs, queue identity, SQLite retry deadlines/413 limit, quarantine, callback-only recovery and resync fixtures; app Debug build passes | Full kill-point matrix, actual A→B/environment UI lifecycle, first-unlock/storage-full behavior, orphan file inventory, legacy downgrade, OS-driven cold callbacks and backlog timing |
| C1–C7 | Snapshot/manifest/publication fixtures; explicit durable resync; relink opt-in saves resync first; observed OS denial persists resync before regrant; owner-bound local scan/permission/failure UI and committed-status restoration test; limited membership changes suppress live events with UI disclosure | Device validation of limited/denied/regranted access, source-reset repair, rendered status UI, permission interruption/coalescing and physical-device observations |
| Q1–Q7 | Owner/grant/query/field/precision fixtures and first-party clients exist | Consolidated multi-user checks across adapters, stale/offline UI, evidence enrichment demonstration and any stream authorization verification |
| A1–A10 | Durable repository/worker/executor fixtures, question and permission continuation, reservation/fence/review logic | Real provider + daemon dispatch/restart demonstrations, interrupt/TUI interaction, exact-model reconnect/expiry, compaction/untrusted-data demonstration and mixed-version regression |
| T1–T8 | Matching/bootstrap/limits/activation/pause repositories and client authoring exist | Both thread-target demonstrations with clients closed, opposite-client edits/conflicts, actual cutover/retry/relink/cancel interaction and measured outcomes |
| K1–K8 | HTTP approval → encrypted helper install → restart → private example backend querying ingested contact/history/location → HTTP revoke fixture passes. Names-only matching/projection and rounded coordinates retain uncertainty; baseline emits no live event. Service build passes | Opposite-client approval, live agent-built private preview, unauthorized private viewer, denial/interrupted setup and full ordinary-channel/frontend secret audit |

Recent logs: `/tmp/bud-contact-reconcile-tests.log` (18 package tests),
`/tmp/bud-contact-relink-app-build.log` (app build),
`/tmp/bud-permission-http-flow-build.log` (service build).
The real PostgreSQL/HTTP handoff fixture is
`service/src/agent/invocation-app-data.test.ts` and runs with
`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-app-data.test.ts`
from `service/`.

Latest verification: populated-data HTTP fixture passes, service build passes
(`/tmp/bud-populated-app-flow-build.log`), 18 TimelineCore tests pass
(`/tmp/bud-contact-permission-gap-tests.log`), and full Debug simulator app build
passes (`/tmp/bud-contact-permission-gap-build.log`). These package tests exercise
the existing resync mechanics; OS permission notification/regrant is still a
device validation item. The physical iPhone remains unavailable on recheck.

## Required deliverables still open

1. Finish Contacts permission/source-repair/status gaps without expanding Apple
   write-back, health, regions or broker scope.
2. Demonstrate the implemented private example contact search/history/location app
   through existing private preview authentication. Its real HTTP/PostgreSQL fixture
   proves scoped reads/revoke; browser rendering and private-viewer checks remain.
3. Run all six phase-8 demonstrations with actual clients and selected Bud/model.
4. Reconcile protocol docs, parent phase status, fixture catalog and auth checklist
   against the final implemented contracts. Chronological progress entries are
   not a substitute for a final matrix of evidence.
5. Inventory standalone ingest databases/deployments and legacy queues using
   metadata only; document owner mapping/quarantine before any migration/retirement.
6. Verify migration coverage, additive rollback/downgrade and mixed-version
   pairings. Deployment/staging writes, commits and PRs still require express
   user intent under the repository rules.
7. Record queue age, capture-to-receipt, projection lag, receipt-to-action,
   quarantine/retry and rule consumption measurements without personal payloads.

Continue implementation and local/service/simulator verification while waiting
for device availability. Do not declare the objective blocked merely because one
device-only gate is unavailable while this work remains actionable.

Local scan status follow-up: 19 TimelineCore tests pass, including reopening a
committed snapshot for status without collection, token requests or ACKs
(`/tmp/bud-contact-local-status-tests.log`). The full Debug simulator app build
passes (`/tmp/bud-contact-local-status-build.log`). Status success metadata persists
in the existing checkpoint; transient failures are explicitly runtime-only.

Limited-access follow-up: 20 TimelineCore tests pass
(`/tmp/bud-contacts-limited-tests.log`) and the Debug simulator app build passes
(`/tmp/bud-contacts-limited-build.log`). Added tests cover expanded/reduced/replaced
limited membership, field-only revisions and retained full-access live detection.
Snapshot-only limited access cannot distinguish new creation from newly shared
existing records; it imports both without live triggers and supports explicit
bootstrap. Device observations and rendered UI acceptance remain open.

Import recovery diagnostics: owner-wide failed/invalid job and invalid/day-old
pending-scan aggregates no longer disappear behind the latest 200 scans. Detail
reasons identify missing predecessor/manifest/records; mobile and web show bounded
diagnostics with original-upload recovery guidance. The repository PostgreSQL
fixture passes, including cross-owner isolation and old failures beyond the page.
Service/web/mobile builds pass (`/tmp/bud-contact-import-status-build.log`,
`/tmp/bud-import-status-web-build.log`, `/tmp/bud-import-status-mobile-build.log`).
This is reporting plus retained-original recovery guidance, not an implemented
reset of an irrecoverable source chain.

Source-repair server foundation: distinct repair event types now support verified
complete replacements under the existing owner transaction lock. Five focused
parser/PostgreSQL tests pass for missing generations, reversed/incomplete arrival,
concurrent publication, stable IDs, hidden absent contacts, empty repair, late old
events and retained subsequent live detection. Service build passes
(`/tmp/bud-source-repair-service-build.log`). Mobile capture/consent, capability
advertisement and recovery of repairs marked unsupported by older services remain
unfinished; this does not close the end-to-end source-reset acceptance gate.

Source-repair follow-up: mobile now persists a repair marker and consumes it once
with a complete snapshot and queued events. Device & Debug requires explicit
confirmation and an authenticated fresh `contact_source_repair` capability read.
The service advertises the capability and recovers repair events marked unsupported
by older processors. Repair/location PostgreSQL and route tests pass, 21 mobile
package tests pass (`/tmp/bud-repair-request-tests.log`), service and corrected
mobile builds pass (`/tmp/bud-repair-capability-service-build.log`,
`/tmp/bud-repair-mobile-final-build.log`). Physical capture/upload/repair UI and
fully lost local-store identity recovery remain unverified/incomplete.

Repair rollback hardening: staged repairs now use `repair_pending`, excluded by
the old publisher's pending selector. New status includes repair work and avoids
claiming that its intentionally skipped predecessors are missing. Mobile/web
exclude closed superseded scans from unfinished diagnostics and point to explicit
repair when original data cannot be recovered. The three PostgreSQL repair,
publication and repository tests pass; service/web/mobile builds pass at
`/tmp/bud-repair-status-{service,web,mobile}-build.log`. This covers the selector
boundary, not a full deployment rollback demonstration.

## September 6 runtime recheck and phase-12 progress

At 01:17 UTC September 7, the local service `/readyz` returned database/auth-schema
checks OK. PID 47575 had started at 18:16:53 local time through the existing tsx
process; no manual restart was performed. This is readiness evidence, not proof
of authenticated capabilities or live model execution. The same physical iPhone
remained unavailable in `devicectl list devices`.

Phase 12 now has persistent field consent, both-client displays, v2 processing,
mobile opt-in/capture/upload gates, receipt coverage and schema-gated service
advertisement in the working tree. Shared v2 fixtures are cataloged separately.
Live authenticated collection, opposite-client interaction and physical delivery
remain open. Earlier chronological descriptions of those code pieces as pending
are historical; they do not override current implementation or close live gates.

Latest consolidated September 6 validation: 119 backend tests passed with zero
failures/skips (`/tmp/bud-personal-data-regression-latest.log`), and all 28
TimelineCore simulator tests passed (`/tmp/bud-timeline-regression-latest.log`).
Web build passes (`/tmp/bud-expanded-source-web-build.log`). Browser bootstrap
again failed before selection; device and real-client gates remain open.

## Local review/app enablement, September 6

Read-only startup-schema checks passed for activation reviews, existing-contact
reviews/membership and app access requests. The aggregate unsettled invocation
query returned no rows before reload. Local ignored `service/.env` now explicitly
sets `APP_DATA_KEYS_ENABLED=1`, `AUTOMATION_PROPOSALS_ENABLED=1` and
`AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED=1`, retaining durable mode and enabled
automations. Existing configuration validation reports all enabled with Bud
concurrency 1. No request was approved and no key was minted by this change.

The existing watcher reloaded after a server source timestamp touch; the listener
changed to PID 50116 and `/readyz` reported database/auth-schema OK. No source
content change, deployment or commit was performed. This establishes local
configuration and successful startup, not authenticated UI capability display,
provider tool selection, graceful crash recovery or approval acceptance.
The live demonstrations can now exercise these flows once clients are available.


App-key ordinary-channel source review is recorded in
[the handoff review](app-key-handoff.md#september-6-ordinary-channel-review).
Explicit serializers/helper return values and the existing actual HTTP/replay
fixture support those named boundaries. K5 remains open for live terminal/SSE,
infrastructure logs and deployed assets; K8 still needs owner/foreign private
preview validation rather than direct loopback example access.


## Live acceptance blocked after repeated availability checks

Latest recheck: physical iPhone B919B7B9-512F-5AD2-B247-46A46666BCFB remains
unavailable. Supported browser initialization still fails with
`Importing module "node:process" is not allowed in node_repl`; supported Simulator
desktop inspection still fails with `Sky Computer Use native pipe startup failed`.
These external conditions have persisted across multiple goal turns while
independent implementation, regression and contract review progressed.

The next live client/device acceptance work cannot proceed through the available
tools. The user reconnection request remains unanswered. The goal is blocked,
not complete; the prepared live-validation handoff supplies manual steps if UI
tooling cannot be restored. Passing local fixtures must not close live background,
opposite-client approval, actual private-preview, terminal/SSE/log inspection or
rollout gates. Deployment and commit/PR authorization remain separate.
