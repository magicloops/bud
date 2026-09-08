# Historical implementation notes

These chronological notes describe intermediate states, not current blockers.
Use [progress-checklist.md](progress-checklist.md) for current status.

# Implementation progress

Status: implementation spans ingestion, queries, durable invocations, contact automations and the phase-7 app-key foundation. No phase acceptance gate is complete. Earlier evidence entries are chronological and may describe work completed by later entries; the latest entries and phase documents describe current status.

For each phase, record changes in the owning repositories, relevant spec updates, validation evidence and unresolved defects. Check a phase only when its acceptance gate passes; deploying or merging remains a separate user decision.

| Phase | Service / infrastructure | Mobile | Web / app | Gate |
|---|---|---|---|---|
| 0 | Contracts, publication order, availability, secret handoff | Queue/scan fixtures | Shared status/approval shapes | Contract decisions and fixtures |
| 1 | Routes/auth, raw storage/jobs, migration, public routing | Upload fixture integration | Proxy routing | Durable explicit ACK |
| 2 | Auth/retry compatibility | Queue isolation, OAuth, recovery | — | Crash/account/background matrix |
| 3 | Contact contract integration | Producer, atomic scans, permissions | Source status integration follows in 4 | Baseline/resync semantics |
| 4 | Projections, grants, scoped REST/tools | Consent, contacts/history/map | Same features | Queries and two-user isolation |
| 5 | Durable admission, worker, continuation, transcript | Canonical status/continuation adapters | Same adapters | Restart/concurrency safety |
| 6 | Rules, matcher, bootstrap and deliveries | Full authoring/history | Full authoring/history | Closed-client automations |
| 7 | Requests, approval, query keys, protected handoff | Approval/inventory/revoke | Same features and example app | Cross-client approval + app query |
| 8 | Migration/compatibility/operational evidence | Real-device evidence | Cross-client evidence | Integrated development slice |

## Phase gates

- [ ] [Phase 0](phase-0-contracts-and-fixtures.md): fixtures frozen; secret-handoff decision and mixed-version implications recorded.
- [ ] [Phase 1](phase-1-integrated-ingestion.md): public-origin ingestion/auth/durable ACK tested; migration checked in.
- [ ] [Phase 2](phase-2-mobile-queue-recovery.md): account-bound mobile queue and background recovery tested on device.
- [ ] [Phase 3](phase-3-contacts-capture.md): Contacts snapshot/diff/manifest lifecycle implemented and tested.
- [ ] [Phase 4](phase-4-projections-and-queries.md): owner-scoped queries, consent and evidence views/tools available.
- [ ] [Phase 5](phase-5-durable-agent-invocations.md): shared admission, leases, outcomes and continuations validated.
- [ ] [Phase 6](phase-6-contact-automations.md): live additions/bootstrap/new-existing threads with mobile/web parity.
- [ ] [Phase 7](phase-7-approved-app-api-keys.md): cross-client permission, protected setup, scoped app queries and revoke.
- [ ] [Phase 8](phase-8-validation-and-rollout.md): cross-repo demonstration, compatibility and operational handoff complete.

## Cross-cutting completion

- [ ] Every new read/write/stream has ownership and acting-user stamping evidence in the auth checklist.
- [ ] Relevant hierarchy specs and actual API/SSE/wire docs reflect landed behavior.
- [ ] Deployable schema is represented by reviewed checked-in migrations and staging validation.
- [ ] Existing HealthKit code is retained; deferred health work has not silently become a prerequisite or claimed deliverable.
- [ ] Normal agent terminal tools remain available; app-data approval has not become a general terminal permission gate.
- [ ] No automatic baseline actions, model substitution or repeat of completed actions during enrichment/rebuild.
- [ ] Raw app keys remain outside normal model/transcript/terminal/log paths.
- [ ] Both-client authoring, approval and history gates pass; no required state exists only on one device.
- [ ] Standalone data/legacy queue inventory and rollback decisions are recorded.
- [ ] Follow-ups remain explicit, including shipped queue disposal and production retention/encryption.

## Execution evidence

Working-tree implementation includes bounded batch parsing/validation, owner-scoped Fastify routes, transactional raw event/job persistence, migration `0024_true_luminals.sql`, and local/public routing configuration. Seven parser/route tests, the PostgreSQL integration test and the service build passed. The synthetic auth fixture failure is resolved; see [debug history](../../debug/personal-data-ingestion-db-test-failure.md). No deployment has been performed.

### Mobile transport and Contacts evidence

- The test-action blocker is resolved by invoking `xcodebuild test -scheme TimelineCore` from the standalone `bud-mobile/TimelineCore` package, without `-project Bud.xcodeproj`; see [debug history](../../debug/personal-data-mobile-test-scheme.md).
- Transport now has strict matching/member-only ACK validation, immutable account/environment/installation partitions, OAuth refresh with owner checks, startup orphan recovery, count/byte bounds, enqueue-failure release and permanent-event quarantine. Existing legacy queues remain untouched.
- Contacts snapshot/diff generation and manifest creation are implemented with atomic SQLite checkpoint/event publication. Baseline, resync and known authorization changes suppress newly-observed eligibility. Disappearance is recorded as no-longer-visible.
- Mobile has an account-specific local collection opt-in and OS permission prompt. The prompt checks its original account context before enabling. No Apple Contacts writeback. This is not yet the shared server-consent or web source-status UI.
- Twelve TimelineCore simulator tests passed, including immutable retries, partition separation, orphan/quarantine reopening, batch limits, Contacts classification and transaction rollback/stale checkpoint rejection. Full mobile simulator build passed with the Contacts producer/control.
- Remaining phase-2 gates include cold launch before profile bootstrap, old-account background callback completion, durable wake/split scheduling, visible quarantine and real-device crash tests. Phase 3 still needs permission-set/source-reset repair, device fixtures and phase-4 publication integration. No phase gate is complete.
- Query/projection, shared consent, invocation/automation, generated-app key and cross-client phases remain outstanding. Use the [validation matrix](validation-checklist.md) for their acceptance gates.

### Cold-launch follow-up and current stop

The mobile OAuth Keychain session now carries a server-verified collection owner, retained across token rotation (including binding during an in-flight refresh), absent on legacy/new-login sessions, and deleted on sign-out. AppSessionStore recreates the owner partition during initialization before profile bootstrap. All 23 focused app authentication tests passed. Signed-out callback-only restoration and physical-device launch/lock validation remain open.

Started `service/src/personal-data/contacts.ts` processing validation. Test-file creation used the wrong working-directory-relative path, and the test command failed before loading tests. Stopped under AGENTS.md §3.5; see [exact command/error and correction](../../debug/personal-data-contact-test-path.md). The validator is untested and not wired to publication; the missing tests and service build must be completed next.

### Server Contacts publication foundation

Resolved the latest command-path issue: three Contacts contract tests and service build passed. Added six projection/staging/domain tables in reviewed migration `0025_careful_trauma.sql`, applied locally with `db:push`. Transactional staging and owner-locked publication pass a PostgreSQL integration test covering reverse arrival, incomplete baseline, concurrent publication, replay and rebuild suppression. Runtime scheduling, query/consent adapters and later phases remain in progress; this is not a completed phase-4 gate.

### Contact query and client slice

Processor lifecycle is now connected to server readiness/shutdown; raw processing failures have persisted retry/dead-letter state. Added owner-scoped list/search/detail/history and source/scan status, with owner/filter-bound cursors and bounded output. Thirteen focused tests including PostgreSQL and Drizzle metadata passed, and separate Fastify+PostgreSQL checks verified anonymous 401/foreign-owner 404/list filtering. Fixed JSON-key search matching found by those tests.

Web `/data` and mobile Personal data now render shared contact search/details/history/import status. Web Vite bundling and TypeScript checks passed; mobile simulator build passed. See [implemented API and limitations](implemented-contact-api.md). Outstanding work still includes remaining queue/device/source-repair gates, location projections/maps, shared consent/grants and agent tools, durable invocation/admission, automation/bootstrap, approved app-key handoff, and integration rollout. These client screens do not complete the overall plan.

### Location evidence and shared permission state

Migration `0026_supreme_human_cannonball.sql` adds owner-scoped normalized location observations and versioned owner-wide agent read grants; generated/reviewed and applied locally via `db:push`. Existing visit/significant-change v1 payloads normalize with coordinate/accuracy validation. Previously unsupported v1 location jobs requeue in bounded owner-locked passes. Queries require explicit windows (31-day maximum), preserve occurrence/receipt/source evidence and return nearest context without verified meeting claims or new domain actions.

Web and mobile now edit the same default-deny agent scopes/history-days/version and show best-effort location evidence in a declared ±24-hour window, with maps loaded on request. Mobile's Swift catch-state name collision was fixed and wire DTOs made nonisolated/Sendable; see [debug note](../../debug/personal-data-mobile-location-compile.md). All four mobile contract tests pass, including grant encoding and uncertain/null evidence. All 16 focused service/DB tests pass, service build and web TypeScript/Vite builds pass, and both repositories pass `git diff --check`.

Next: integrate grant-aware agent query tools with history/field bounds, then complete durable human/automation admission, rules/bootstrap and app-key approval/protected delivery. Shared permission editing alone does not complete agent access. Device/source repair, actual-auth/visual/integration and deployment migration gates remain unverified; no phase gate is marked complete.

### Grant-aware query adapter

Implemented `AgentDataQueries` for the four planned contact/location tool operations. It receives an authoritative owner separately from model arguments, rejects unsupported/owner-selecting arguments, enforces current scopes and history bounds, and withholds results if permissions change while reads run. Contact queries enforce the observation cutoff in SQL for current rows and revisions; cursors bind to grant version. Location-context requires both scopes and an in-grant explicit window. Three adapter tests plus the PostgreSQL publication/query test pass; the latter verifies historical revision exclusion and first-party cursor rejection under agent policy. Service build passes after correcting the public missing-grant timestamp type.

Runner tool registration, directive/result/transcript handling and end-to-end model tests remain next. The full agent spec and tool-definitions file have been read; `contracts.ts`, `model-runner.ts`, `agent-service.ts`, transcript writer and replay loader still need full reads before editing. No tool has yet been advertised to a model by this adapter-only change.

### Registered agent query tools

The agent now advertises and executes the four grant-aware data tools, including during manual Bud-offline chat. Thread/Bud ownership is checked before query execution; permission failures point to shared Settings. Directive parsing, stored replay, canonical transcript results and owner attribution are wired through the normal agent loop. Personal-data query arguments are omitted from dispatch debug logs. Fixed literal schema typing and the stale offline-catalog test expectation; 52 focused agent tests pass, including a mocked-provider end-to-end loop fixture, and the service build passes. This does not prove real-provider/device behavior or complete phase 4.

Next implementation work is durable invocation admission/execution (phase 5), followed by contact rules and approved app credentials. Earlier evidence entries describe historical states, not current blockers; AGENTS.md now directs investigation and continued fixes.

### Durable invocation storage and recovery foundation

Added migration `0027_aspiring_triton.sql` and the inactive invocation repository. Inputs and admissions commit together; retries preserve one message/turn; workers claim a thread reservation with fencing; action intents precede future dispatch. Expired preflight can retry, while execution expiry/unresolved intents retain `needs_review` reservations. Availability deferral releases the worker lease. PostgreSQL tests cover rollback/concurrency/recovery and execute reviewed migration SQL in an isolated schema. Corrected generated FK ordering before applying new tables locally; existing messages were preserved.

Next: integrate worker/admission and real agent dispatch/outcome fencing, then durable waits/cancellation and client state, before enabling contact rules. The live manual route still uses the legacy start path. No phase gate is complete.

### Awaitable agent execution and worker

Implemented internal completion/cancellation/checkpoint hooks in the agent loop and a dormant durable worker that binds lease renewal, action intents and transcript evidence to execution. Fixed conversation initialization escaping cleanup. Focused tests prove worker ordering, unavailable-model deferral and stale-lease cancellation, and the query-loop fixture now exercises lifecycle hooks. The runtime remains on legacy admission until the worker is bound to exact model preflight, durable waits/cancellation and shared route admission. No phase gate is complete.

Validation for this slice: 56 focused agent tests passed, followed by an additional passing shutdown/claim race test (57 distinct tests). Service build and `git diff --check` pass. Worker tests use injected execution/repository fixtures; they do not establish the live shared-admission or real-device gates.

### Durable wait/cancel repository transitions

Added owner-stamped cancellation and fenced acknowledgement, independent bounded queued expiry, verified question parking and answered-continuation reclaim. Migration `0028_blue_risque.sql` separates the thread reservation from worker status; model waits preserve continuation ownership. PostgreSQL tests cover same-invocation/new-fence resume, cancellation, expiry behind a reservation and database rejection of overtaking work. Fixed a correlated SQL projection bug found by the resume-after-model-wait fixture and renewed action fences on every claim. Both invocation migrations execute in isolated-schema tests. The column and reviewed index/backfill are applied locally; no deployment.

The worker is still disabled. Next is connecting runtime question parking/answer replay and exact model preflight, then shared manual/automation admission and the browser/mobile durable state adapters. The full plan remains active.

### Runtime question parking and replay

Connected the worker's durable park hook to AgentService. Parked turns release the worker and retain their question/reservation. Reclaim now reconstructs validated accepted answers into canonical tool messages and provider-ledger results in one transaction. Undispatched tools after a question receive explicit not-executed results for reconsideration; ambiguous dispatched tools are not replayed. PostgreSQL tests verify both answer/trailing-result reconstruction and idempotent retries. The worker remains disabled pending shared route admission, response routing and exact model preflight. No phase gate is complete.

### Exact selected-model executor

Implemented the worker-to-AgentService executor with owned thread/Bud preflight, automated availability waiting, explicit persisted model/reasoning selection, provider/local-capability checks and cross-Bud model rejection. It preserves reserved turn/owner identity and rechecks availability at dispatch without cloud substitution. Manual cloud chat remains usable offline. Focused tests cover the policy and dynamic local-model catalog reconstruction after restart. Shared admission/response routing and client state still precede server enablement.

### Optional shared route admission

Added constructor-controlled durable mode to AgentService and integrated it with message creation/retries, answer responses, state recovery and cancellation routes. Inputs/admissions/model preference updates commit together; the new route does not detach execution or steal question reservations. Answer retries preserve invocation identity without legacy fallback messages. Canonical state includes owner-filtered invocation summaries and persisted pending questions. Route and PostgreSQL integration tests pass. The server still does not enable the mode: web/mobile adapters, runtime admission cutover and remaining execution gates are next.

### Web durable-state recovery

The existing-thread view restores persisted questions after restart, refreshes after durable answers, and displays queued/offline/expired/review status with owner-scoped cancellation. Visible durable threads poll lifecycle state every five seconds without overlapping polls or refreshing for heartbeat-only changes; stale thread visits cannot apply old bootstrap results. Canonical question results win over stale pending snapshots. Legacy services retain the existing path. Twenty-three focused reconciliation/question/status tests and the web production build pass. Browser timing validation, mobile parity and server cutover remain pending; this does not complete phase 5 or the full plan.

### Mobile durable question recovery

Mobile restores canonical `pending_questions` through its native prompt UI with stable client/turn identity when runtime state is inactive. The canonical empty list clears stale runtime prompts, while older services retain compatibility. Durable answer continuations now refresh canonical transcript/state. Six focused simulator tests pass, including cold recovery, authoritative clearing, legacy mapping, response decoding, actual ChatStore answer refresh and the existing live-answer path. Mobile invocation status display/polling, server cutover and the remaining phase 5–8 work are not complete.

### Mobile invocation status

Mobile now decodes persisted invocation state, shows queued/offline/review/terminal outcomes and exposes cancellation through the existing authorized thread route. Visible-thread polling pauses outside the active scene, skips heartbeat-only changes and applies changed snapshots with canonical transcript refresh. Matching non-executing invocations suppress stale runtime tools/reasoning and pending-assistant indicators. Nine focused simulator tests pass. This advances client parity but does not prove live cross-client timing or satisfy server cutover, per-Bud concurrency and input-boundary requirements. The phase 5 document now lists the current implementation and remaining gates instead of obsolete intermediate status.

Additional mobile validation: all 47 existing network DTO tests pass after the invocation mapper change (56 tests including the focused run). No service worker has been enabled.

### Cross-worker per-Bud automation capacity

Repository claims now enforce a configurable per-Bud automation reservation limit (default one), using a transaction advisory lock and fresh capacity check after candidate selection. Tests with independent repository instances verify different-thread races, capacity release on unstarted model deferral, review retention, unaffected human turns and progress on another Bud. The complete PostgreSQL repository fixture and nine worker/executor regression tests pass, as does the service build. A scalar Drizzle query error found by validation was fixed. The server remains disabled pending admitted-input conversation boundaries, review/cutover controls and remaining crash/integration gates.

### Durable input activation and compaction boundaries

Fenced first start now stamps an input's stable model-context timestamp, overriding any caller stamp at admission and preserving it across continuation. Shared loader/checkpoint SQL excludes unstarted inputs and orders activated inputs after prior visible work without changing UI transcript timestamps. Automation input no longer replays at system priority. PostgreSQL tests prove queued exclusion, survival past an earlier checkpoint, clock-skew ordering, continuation stability and automation priority. Loader/checkpoint/budget regression tests and the service build pass. Live provider/compaction validation and controlled cutover remain open.

Continuation replay validation also covers actual same-provider ledger reconstruction, proving one question call/result pair after adding the missing call-reference metadata. The repository fixture and its three subtests pass; 23 loader/checkpoint/budget regression tests pass.

### Startup repair ownership

Legacy startup repair now excludes durable invocation turns in SQL, leaving question continuations, trailing undispatched tools and ambiguous action evidence to fenced recovery. PostgreSQL tests verify durable exclusion and legacy eligibility in one thread. Generic legacy/replay repairs no longer describe missing results as proof of failure or recommend blind retries. The invocation/repair fixtures and loader/repair regression tests pass. Server composition, drain/rollback controls and the remaining phase gates are still unfinished.

### Server admission composition and mode guard

- Added startup-only legacy/durable selection, configured automation capacity,
  shared route/worker repository, readiness start and awaited worker shutdown.
- Added schema-scoped PostgreSQL session mode locks: same-mode replicas allowed,
  opposite modes refused; unresolved durable work blocks legacy rollback and
  pending legacy questions block durable cutover. Older binaries require drain.
- Lease/shutdown interruption releases pending service terminal waits and removes
  its listener on completion; no remote command stop or replay is inferred.
- Fixed the first test failure caused by database-wide advisory locks colliding
  with the running dev service despite an isolated fixture schema.
- Validation: startup/database + worker/executor suite 11 passed; subsequent
  executor interruption + real Fastify composition suite 6 passed; service build
  passed. Composition teardown also logged a contact-processing retry warning;
  investigate worker/pool shutdown ordering before live cutover.
- Default remains legacy. No phase gate completed, deployment or commit performed.

### Database-worker shutdown ordering

- Fixed the contact-processing warning observed during service composition teardown.
  Personal-data registration returns an idempotent stop handle; server shutdown
  explicitly awaits contact and invocation workers before gateways and pools.
  Early preClose draining is retained, but correctness no longer depends on hook order.
- Added a held-operation lifecycle regression; contact/routes and invocation-worker
  tests pass (7 tests). The real Fastify server test passes without the earlier
  processing warning; service TypeScript build passes.
- No live restart/phase gate is implied. Review/abandon controls and remaining
  automation/key phases remain outstanding under the original plan.

### Owner-reviewed invocation abandonment

- Added owner/thread-authorized `POST /api/threads/:threadId/agent/invocations/:invocationId/abandon`, requiring explicit possible-effects acknowledgement and observed update timestamp.
- Repository records the owner's audit action and cancellation, preserves uncertain
  intents, fences old execution and releases the reservation atomically. Duplicate
  acknowledgements are idempotent; no automatic replay or remote command stop occurs.
- PostgreSQL suite: 5 passed. Route/auth/registration suite: 7 passed after updating
  the explicit route-set fixture. Service build passed.
- Web/mobile review controls still pending; full phase/rollout gates remain open.

### Web review acknowledgement

- Connected the existing-thread `needs_review` state to an inline acknowledgement
  and audited abandonment request. Provides terminal access and explains that
  commands may still be running and queued work can proceed after release.
- Consent is tied to thread/invocation/update timestamp. Duplicate submission is
  guarded; success/conflict refresh canonical state; obsolete thread visits cannot
  apply review response/error state. New-thread layout inspected and unaffected.
- `pnpm --dir web build` passed (existing Vite chunk-size warning remains). Browser
  interaction validation and mobile controls remain outstanding.

### Mobile review acknowledgement

- Added owner-review endpoint support in the mobile backend and network thread
  client, plus a ChatStore method and conversation acknowledgement/action UI.
- Exact wire update timestamps are retained for optimistic checks. Review changes
  invalidate equality/consent; ordinary heartbeat updates remain ignored.
- Missing acknowledgement and stale selections never submit. Selection-generation
  checks withhold responses after leaving/revisiting a thread; successful review
  refreshes canonical state/transcript, with no terminal cancel/replay.
- Eight focused simulator tests passed (`/tmp/bud-mobile-review-final-tests.log`).
  Live cross-client interaction and remaining phase 5 gates are still outstanding.

- Final mobile simulator Release build passed after navigation acknowledgement reset (`/tmp/bud-mobile-review-build.log`).

### Contact automation contracts

- Added strict shared service schemas for definitions, draft updates, activation,
  pause and bounded explicit existing-contact processing. Both new/existing-thread
  targets and exact model selection are represented; injected owner/enable/fallback
  fields are rejected. Separate standing-work and repeated-action consent required.
- Development bounds: 24-hour latest start, 100 invocations/owner/day, bootstrap
  max 1000 contacts in default groups of 25. Storage/matcher must enforce these
  transactionally; schemas alone do not authorize or run work.
- Two focused tests and service build pass. Phase 6 storage/matching/API/client
  management and earlier integration gates remain unfinished.

### Automation storage and publication boundary

- Added automation drafts, revision snapshots and live-event deliveries with
  ownership-compatible FKs, dedupe and admission/state constraints. Bootstrap
  storage and rule/matcher APIs remain pending.
- Added owner-serialized publication counters and domain event sequences;
  baseline/rebuild/replay never advance live eligibility. Old null sequences are
  historical; activation must capture the counter under the same owner lock.
- Generated/reviewed `0029_absent_white_queen.sql`, moved referenced uniqueness
  before its FK, and applied locally transactionally after reviewing db:push.
  Push also proposed unrelated invocation constraint recreation; it was not used
  to apply those statements. No deployment or manual journal edits.
- PostgreSQL publication/revision-owner/delivery-dedupe fixture and service build
  pass. Phase 6 matching, bootstrap, management and clients remain unfinished.

### Automation draft and activation repository

- Implemented owner-serialized draft create/update and explicit version-checked
  activation. Source/epoch/install revocation, Bud/thread ownership and exact
  model/reasoning are validated before mutation. Activation also checks current
  grant version, scope and history window under the grant/publication owner lock.
- Revision snapshots freeze the definition, grant version, human actor and
  publication boundary. Draft edits preserve the already-active revision; a
  concurrent activation accepts one decision and rejects stale state.
- PostgreSQL fixture covers cross-owner/source denial, absent/stale/revoked grant,
  concurrent activation and preserved revisions; it passes. Service build passes.
- Repository is not exposed by routes or a matcher yet. Those integrations,
  bootstrap and both-client management remain part of the full goal.

### Durable contact matching

- Added owner-locked domain matching. Applicable immutable revision is selected
  by publication sequence, including when matching happens after a newer activation.
  Source mismatch/expiry produce visible delivery reasons; legacy unsequenced
  events cannot become live work. Delivery insertion and matched status commit
  together; retries/conflicting matchers do not duplicate work.
- Rule creation is owner-serialized and capped at 100 for bounded event fan-out.
- PostgreSQL tests verify old/new revision cutover and delivery idempotency along
  with activation/ownership tests. Corrected a one-poll timing assumption for
  SKIP LOCKED contention; combined suite and service build pass.
- No model execution is performed by matching. Server scheduling, rule routes,
  grant/pause-aware delivery admission, bootstrap and client management remain.

### Approved app-key contracts and storage

- Selected [backend public-key delivery](app-key-handoff.md): encrypt the approved
  credential to an app-local installation key, retrieve with a scoped signature,
  persist locally and acknowledge with a separate installation signature. No
  daemon protocol change or plaintext service escrow is required. The helper and
  full request/approval/query flow are not implemented yet.
- Added strict request/decision/policy schemas and cryptographic primitives.
  Seven tests pass for scoped fields/precision/history, injected authority,
  unsafe key rejection, wrong-recipient/context decryption and proof separation.
- Generated `0032_flat_wilson_fisk.sql` for immutable permission requests and
  verification/encrypted-handoff key state. Corrected referenced-constraint order
  before execution; applied the reviewed SQL locally after inspecting db:push,
  excluding its unrelated constraint recreation. Existing rows were preserved.
- Two additional tests pass: actual migration execution and ownership/state/
  idempotency constraints in an isolated rolled-back schema, plus Drizzle metadata
  validation. Service build and `git diff --check` pass. No deployment and no raw
  key issuance occurred.
- The latest browser validation failure is a tooling initialization problem
  (`node:process` import rejected), documented in the [debug note](../../debug/bootstrap-browser-runtime.md).
  It has not demonstrated a product defect. Actual browser/device, cross-client,
  recovery and remaining phase gates stay open.

### App permission repository and query policy

- Implemented owner-locked immutable requests from fenced invocation/tool intents,
  atomic approve/decline and one key per request, signed encrypted delivery,
  installation acknowledgement, revoke, and bounded persisted expiry. Ordinary
  serializers omit credential/hash/ciphertext/proof fields. Query authority checks
  installed state and current owner-private destination on every read.
- PostgreSQL fixture verifies cross-owner/stale-fence/intent denial, duplicate and
  competing decisions, rollback after key insertion, delivery through a fresh
  repository instance, decryption, idempotent install, revoke, expiry and cursors.
- Added app scope/field/history/precision query adapter with post-read revocation
  checks. Contact restrictions apply inside SQL matching and projection, so a
  names-only grant cannot search hidden phone/email/organization values. Location
  coordinates round according to the grant; sensor accuracy remains separately
  labeled and cursors bind the key/version.
- Nine repository, SQL-policy, app-adapter and agent regression tests pass. Fixed
  a test-only UUID-default inference error found by the compiler; see the
  [debug note](../../debug/app-key-test-retry-type.md). Service build and
  `git diff --check` pass.
- No app-key routes/tool/continuation/helper or client controls are mounted yet;
  closed-client expiry scheduling and integrated phase-7 acceptance remain open.

### Mounted app-data routes and expiry

- Added owner-authenticated request inventory/detail/decision/revoke, dedicated
  app-key contact/location routes, and operation-bound signed setup endpoints.
  Cookies/OAuth, app query credentials and setup proofs cannot substitute for one
  another. Normal composition still disables approval issuance pending the
  agent continuation and backend-helper integration.
- Service-owned expiry runs independently of client activity and automation
  activation; shutdown drains it through the existing personal-data stop handle.
  Responses are no-store, setup bodies bounded, and errors omit secret material.
- Real Fastify/PostgreSQL fixture now exercises human approval, encrypted HTTP
  retrieval/decryption, signed installation, actual scoped query and HTTP revoke.
  The full server composition test passes with clean worker/pool shutdown.
- Browser/mobile permission controls, request tool/replay continuation, generated
  backend helper and full cross-client acceptance remain open. See the
  [implemented API](implemented-app-data-api.md) and auth checklist for boundaries.

### Standalone backend setup helper

- Added a public downloadable Node helper, copied unchanged into service builds.
  It stores an app-local RSA identity and credentials outside the worktree by
  default, verifies private file ownership/modes, rejects symlink files and pins
  the original API origin. Only public initialization/status metadata is returned.
- Credential/digest persistence and fsync precede the signed installation receipt.
  A restart after a lost acknowledgement retries from disk without retrieval or
  key reminting. Network calls refuse redirects and enforce timeout/byte bounds.
- Two helper tests pass for concurrent initialization, permissions, unsafe state,
  tampered delivery, origin binding and interrupted acknowledgement. The real
  Fastify/PostgreSQL fixture also passes helper download, initialization, approved
  install, contact query and revoke over localhost HTTP. Service build,
  source/deployed-helper byte comparison and `git diff --check` pass.
- Agent request/approval continuation, both-client permission management, generated
  example app and integrated secret-absence/phase acceptance remain unfinished.

### Durable permission parking and replay

- Permission creation and invocation/action parking now commit atomically.
  The worker hook releases its lease while retaining the thread reservation;
  resolved approval/decline/expiry resumes the same turn. Cancellation closes
  pending requests. Model availability waits preserve the reservation.
- Restored results contain public request/key metadata and are idempotent;
  later batched tools receive explicit not-executed results for reconsideration.
  Fixed a loader gap that substituted generic interruption for the saved decision
  ([debug note](../../debug/app-permission-replay-result.md)).
- PostgreSQL permission/invocation fixtures, seven worker tests and fourteen
  conversation-loader tests pass. The permission fixture checks actual replay
  content and absence of generic repair, hash and ciphertext.
- Tool registration, AgentService dispatch, both-client approval UI and integrated
  acceptance remain open; normal composition still disables app-key issuance.

### Model permission tool and dispatch

- Added opt-in tool schema, strict parser and AgentService dispatch. The service
  setting and durable hook must both be present to advertise the tool. Intent,
  atomic parking and public prompt emission occur in that order; the loop then
  returns without executing trailing calls or recording an unanswered result.
- Two focused tests pass for proposal validation/catalog gating and actual loop
  dispatch into the hook, plus five personal-data regression tests. Compaction
  accounting uses the selected catalog, including the permission tool when enabled.
- Normal composition still disables issuance. Client permission inventory/cards,
  thread snapshot recovery, shared activation and end-to-end acceptance remain.

### Pending request recovery and web inventory

- Durable thread state now includes bounded owner-scoped `pending_data_requests`
  independent of the in-memory runtime. PostgreSQL verifies recovery and isolation;
  route tests verify authorization before the new read.
- Web Personal data now lists app requests/key status, exact requested permissions,
  destination/fingerprint and conversation links. Approval requires acknowledgement
  and server capability; decline/revoke use versioned, idempotent requests. Polling
  recovers decisions from other clients; unmounted cards ignore late responses.
- Service/web builds pass; the existing web bundle-size warning remains. Eight
  thread-route tests and the extended PostgreSQL permission fixture pass. Browser
  interaction, mobile controls, thread prompts and composition activation remain.

### Mobile app permission inventory

- Added a Personal data navigation destination for app requests and key status,
  exact policy/destination review, explicit approval acknowledgement, decline and
  revoke. It uses the same owner-authenticated/versioned API as web.
- Polling runs serially only while the scene is active. Owner/task checks suppress
  stale responses; version changes reset review. Mutation tasks consume actions
  before awaiting so navigation cannot replay them, while explicit uncertain
  retries retain the original body and idempotency key.
- Release simulator build passed (`/tmp/bud-app-permissions-build.log`). Focused
  DTO tests passed under Debug (three tests, `/tmp/bud-app-permissions-debug-tests.log`);
  the initial Release test configuration failure is documented in
  [the debug note](../../debug/mobile-app-permission-test-configuration.md).
  Actual cross-client interaction, thread prompt recovery,
  composition activation and full phase acceptance remain open.

### Web conversation permission prompts

- Canonical pending app requests now render a review banner in the requesting
  conversation. Live tool events refresh saved state; cold bootstrap restores the
  same prompt, and request changes participate in durable polling revisions.
- Review navigation targets `/data?request=<id>` and loads that exact owned
  request independently of inventory pagination. Changing requests remounts
  consent/retry state. New-thread layout remains unchanged.
- Web production build and seven invocation-state tests pass. Mobile conversation
  prompts, issuance composition, real UI/provider/device and full-plan acceptance
  remain outstanding.
