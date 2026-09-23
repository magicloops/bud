# Auth Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running manual verification list while auth, device claim, ownership enforcement, and settings hardening land across Phases 2-5.
Keep it current as we verify behavior locally and as Phase 4/5 work changes the expected surface.

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred until a later phase

## Verified So Far

- [x] Device reauth: delete only the local Bud secret, keep `installation_id`, reclaim, and confirm the same `bud_id` comes back.

## Foundational Checks

### Web Auth

- [ ] Anonymous `/` redirects to `/login`.
- [ ] Google OAuth sign-in succeeds.
- [x] Logout succeeds and returns the browser to an unauthenticated state.
- [ ] `GET /api/me` returns `401` while logged out.
- [ ] `GET /api/me` returns the expected normalized current-user payload after login.

### GitHub + Auto-Link

- [ ] GitHub OAuth sign-in succeeds.
- [ ] Same-email auto-link works when signing in with the second provider using the same verified email.
  Success condition: the second provider lands in the same Bud account rather than creating a new user.

### Device Claim

- [ ] Fresh Bud claim works from a local machine using the printed link.
- [ ] Fresh Bud claim works by scanning the QR code from a phone.
- [ ] The browser claim flow never displays the long-lived `device_secret`.
- [ ] The browser claim flow never exposes the long-lived `device_secret` in claim-page API responses.

### Device Install Claims

- [ ] Authenticated `POST /api/device-install-claims` returns a complete service-generated install command.
- [ ] Unauthenticated `POST /api/device-install-claims` returns `401`.
- [ ] Signed-in users cannot read another user's install claim (`404`).
- [ ] Expired install claim identifiers cannot redeem.
- [ ] Already redeemed install claim identifiers cannot redeem twice.
- [ ] Successful install claim redemption stamps `bud.created_by_user_id` from the issuing user.
- [ ] Browser install-claim responses never expose the long-lived `device_secret`.

### Local Ownership Sanity

- [ ] Existing backfilled Buds still appear for local user `dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe`.
- [ ] Existing backfilled threads/messages/runs still appear correctly for that same user.
- [ ] Newly claimed Buds are created with the expected owner user id in the database.

## Run Now After Phase 4 Lands

### List And Read Scoping

- [ ] `GET /api/buds` returns only the signed-in user’s Buds.
- [ ] `PATCH /api/buds/:budId` (display name / accent color) returns `404` for another user’s Bud and `401` when logged out.
- [ ] `GET /api/threads/:threadId/model-context` returns `404` for another user’s thread and `401` when logged out, and never loads the conversation first.
- [ ] `GET /api/threads` returns only the signed-in user’s threads.
- [ ] Direct navigation to another user’s `/$budId/$threadId` fails cleanly.
- [ ] Resource-scoped unauthorized access returns `404` rather than leaking existence.

### Write And Stream Authorization

- [ ] A second user cannot post messages to another user’s thread.
- [ ] A second user cannot attach to another user’s terminal SSE stream.
- [ ] A second user cannot send terminal input, interrupt, or resize requests to another user’s thread.
- [ ] A second user cannot create file-viewer sessions through another user’s thread.
- [ ] A second user cannot read, fetch, or revoke another user’s file sessions.
- [ ] A second user cannot see another user’s run history.

### Ownership Stamping

- [ ] New thread rows have the correct `created_by_user_id`.
- [ ] New message rows have the correct `created_by_user_id`.
- [ ] New run rows have the correct `created_by_user_id`.
- [ ] New terminal session rows have the correct `created_by_user_id`.
- [ ] New terminal input log rows record the acting human `user_id`.
- [ ] New file viewer `file_session` rows have the correct `created_by_user_id`.

### Second-User Verification Pass

- [ ] Create a second real user and confirm they cannot see the first user’s Buds, threads, runs, sessions, or messages.
- [ ] Confirm the original local dev user still sees all preserved backfilled prototype fixtures.
- [ ] Confirm a newly claimed Bud for user A does not appear for user B.
- [ ] Confirm raw copied URLs from user A do not load for user B.

## Run After Phase 5 Or Before Launch

### Settings And Linked Accounts

- [x] `/settings` renders successfully for an authenticated user.
- [-] Settings shows linked-account state for GitHub and Google.
- [x] Username editing works and persists.
- [-] Avatar rendering uses provider image when available.
- [-] Avatar rendering falls back to generated initials when no provider image exists.
- [x] Explicit provider linking from settings works when same-email auto-linking does not apply.

### Session And Expiry Behavior

- [x] Expired browser sessions redirect cleanly back to `/login`.
- [x] Terminal and agent reconnect loops stop after auth expiry instead of spinning forever.
- [-] Login resumes back to the intended route after reauthentication.

## Latest Manual Passes

- [x] 2026-03-16: `/settings` username save verified locally.
- [x] 2026-03-16: explicit GitHub/Google provider linking from `/settings` verified locally.
- [x] 2026-03-16: browser sign-out flow verified locally.
- [x] 2026-03-16: active-thread session-expiry redirect verified locally, including SSE reconnect-loop shutdown.

## Notes

- Keep this checklist up to date as items are verified or deferred.
- Reuse the same preserved local data set for Phase 4/5 multi-user verification where practical.
- If behavior changes materially, update this checklist and the relevant phase plan docs together.

## Personal-data ingestion foundation

- [ ] `POST /v1/events/batches` rejects unauthenticated/invalid bearer requests before parsing or persistence; a supplied invalid bearer cannot fall back to another account cookie.
- [ ] Envelope actor/installation/epoch mismatches cannot write another account's data. All accepted installation/epoch/event/job rows inherit the authenticated owner.
- [ ] `GET /api/data/status` filters sources and processing counts by owner in SQL and requires authentication.
- [ ] Two users sharing a physical installation ID receive separate data partitions; duplicate event IDs cannot cross owner boundaries.
- [ ] Revoked installation/collection epochs cannot be revived by upload retry.

## Personal-data contact queries

- [x] PostgreSQL tests verify contact list SQL ownership and foreign contact/detail/history exclusion (`404`).
- [x] Contact pagination cursors are bound to owner and filter, preventing reuse across owner contexts.
- [ ] Real OAuth/cookie requests to `/api/data/contacts`, `/api/data/contacts/:id` and `/api/data/contacts/:id/history` return `401` anonymously and only owner data after login.
- [ ] Contact source/scan status is consistent between mobile and web after incomplete/reversed uploads.

Resource ownership is the authenticated personal-data user, independent of Bud/thread. Route authentication runs before queries; worker records inherit raw-event ownership through composite FKs. Agent/app access will require separate grants and is not exposed by these first-party routes.

## Location and agent permission state

- [x] Fastify/PostgreSQL fixtures verify anonymous location/grant reads and grant writes return 401, foreign location lists are empty and foreign contact context returns 404.
- [x] Grant updates stamp the authenticated owner/updater, ignore client-selected owner fields, reject stale versions, and default to no scopes for other owners.
- [x] Location cursors bind owner/time window and unsupported-job recovery cannot cross an explicit owner filter.
- [ ] Real OAuth mobile/web permission editing, conflict/reload, sign-out and location-map presentation.
- [ ] Agent tools enforce current scopes/history bounds and revoked grants before reading.

## Durable invocation admission (disabled pending cutover)

- [x] PostgreSQL fixtures verify atomic input/invocation owner stamps, foreign-thread admission rejection, foreign invocation list/turn lookup exclusion, and owner-only question recovery.
- [x] Route fixture verifies authenticated owner is passed to admission and no detached start or question supersession occurs.
- [x] PostgreSQL AgentService fixture verifies an accepted durable answer retry returns the original invocation instead of starting a fallback turn.
- [ ] Real OAuth/cookie requests verify anonymous/foreign-owner admission, invocation state, pending-question reads and cancellation before server enablement.
- [ ] Both clients recover the same invocation/question after service restart and record the authenticated cancellation actor.

- [x] Durable invocation abandonment: route authenticates and authorizes thread before mutation; repository repeats thread/Bud/invocation owner checks and stamps owner on audit/cancellation. Fixtures verify 401 unauthenticated, 404 foreign thread/invocation, 400 absent acknowledgement, 409 stale/non-review state, and concurrent idempotency. Real cross-account UI validation remains pending.

## Automation management reads

- [x] Fastify fixtures reject anonymous list/detail/delivery reads before repository calls and pass only the authenticated viewer as owner.
- [x] PostgreSQL fixtures verify owner-filtered lists, foreign detail/history 404, and rejection of cross-owner history cursors.
- [ ] Real mobile/web authentication verifies the same rule revisions and delivery histories across account switches.

Automation rows belong to their creating personal-data user. Authentication precedes queries; list/detail/revision/delivery SQL includes owner predicates. These read routes stamp no rows.

- [x] Automation draft/create/pause Fastify + PostgreSQL fixtures verify anonymous 401, foreign edit/pause 404, strict owner-field rejection, owner/updater stamps, create dedupe, and stale-version 409.
- [ ] Real authenticated mobile/web draft-edit and pause parity, including sign-out during a pending mutation.

- [x] PostgreSQL fixtures verify owner-only contact-source inventory and correct delivery-to-owned-conversation linkage.
- [ ] Web `/automations` account-switch/unmount handling, save retries/conflicts, pause controls and conversation links verified in browser.

The web editor uses the root authenticated viewer gate, remounts by owner, and calls existing owner-scoped APIs. All writes retain server owner/updater stamping; source and invocation additions are read-only owner-filtered projections.

- [x] Activation route fixtures verify anonymous 401, foreign rule 404, missing acknowledgement 400, stale grant/rule 409, successful immutable activation and disabled server capability 503.
- [ ] Mobile/web activation consent and delivery conversation navigation verified with real authenticated accounts.

- [x] Bootstrap Fastify/PostgreSQL fixtures verify anonymous reads/combined writes return 401, foreign receipt/member/combined access returns 404, injected owner fields return 400, and disabled capture/combined activation return 503. Snapshot reads filter owner in SQL; member cursors bind owner/rule/request.
- [ ] Real mobile/web bootstrap consent, retry, progress and cancellation across account switches.

- [x] Bootstrap cancellation Fastify/PostgreSQL fixtures verify anonymous 401, foreign request 404, queued-group cancellation and running cancellation owner stamp/reservation retention. Bootstrap dispatch and query ceilings reject foreign invocation owners, altered models, canceled requests and revoked grants.

- [x] Bootstrap progress Fastify/PostgreSQL fixtures verify anonymous 401, foreign request 404, bounded group pagination and owner-scoped invocation/thread linkage. Running cancellation remains unsettled until acknowledgement. Rule-pause fixtures verify queued cancellation preserves started bootstrap work and active cancellation records its request.

- [x] Bootstrap preview/list PostgreSQL and Fastify fixtures verify authenticated owner scoping, foreign 404/anonymous 401, bounded pagination, stale grant rejection, no preview writes and draft preview without activation.

- [ ] Web existing-contact preview/approval, immutable capture retries, history/progress, cancellation and sign-out during requests verified in browser. UI uses the authenticated owner-remounted automation editor and existing owner-scoped APIs; browser runtime initialization is currently unavailable.

## App data permission and query routes

- [x] Fastify fixtures verify anonymous human routes return 401, query keys cannot approve/revoke, explicit invalid bearer cannot fall back to a cookie, and owned disabled approval returns 503 only after ownership lookup.
- [x] PostgreSQL/Fastify fixtures verify foreign request 404, owner-filtered inventory/cursors, atomic decision/key owner stamps, installation proof, installed-only query auth, scope/argument rejection and immediate revoke denial.
- [x] SQL fixtures verify restricted contact fields affect both matching and projection; app/location cursors cannot cross key/policy contexts. Adapter fixtures withhold data after mid-read revocation and round coarse coordinates.
- [x] Route fixtures verify proof/body separation, no-store and omission of credential/signature/error contents from normal logs/responses. Full provider/transcript/generated-asset inspection remains pending.
- [ ] Real mobile OAuth and browser cookie approvals, opposite-client decision/revoke, navigation/account-switch handling and generated backend setup are verified together.

Human permission resources belong to the authenticated viewer; repository SQL
filters and stamps owner/decision/revocation actor. App-query identity is resolved
only from its installed verification-hash credential. Signed setup proves the
specific recipient and operation; it confers no human permission or query access.

- [x] Pending app-request snapshot: route fixtures verify authorization before reads; PostgreSQL verifies owner/thread/action matching, fresh-repository recovery, stable client identity and removal after decision/cancel.
- [ ] Web app inventory approval/decline/revoke, cross-client refresh, unchanged retry bodies and account switching verified with real authentication in the browser.

## Automation proposal reviews

- [x] PostgreSQL fixtures verify frozen proposal owner/context/action bindings, owner-filtered inventory/cursors, foreign detail/decision exclusion, human actor stamping and atomic activation/decision rollback.
- [x] Fastify fixtures verify anonymous/app-key rejection, owned lookup before approval gating, strict decision bodies, no-store responses and mounted proposal inventory precedence over rule detail.
- [x] Isolated PostgreSQL continuation fixtures verify owner/thread/action-bound pending recovery and no reclaim after cancellation; approved/declined/stale/expired results restore once to the original invocation.
- [ ] Real browser cookie/mobile bearer tests verify explicit bearer precedence, opposite-client approval and account switching during pending decisions.

Proposals belong to the authenticated personal-data user. Human routes resolve
the viewer before repository access; owner SQL and composite keys bind the review
to its rule and originating invocation. New proposals inherit the invocation's
owner/tenant; accepted decisions stamp the authenticated owner. App query keys
cannot supply human identity. Approval and the advertised proposal capability
remain off until the explicit composition setting is enabled.
# Existing-contact automation review boundary

- [x] Injected route fixtures verify human owner forwarding, anonymous/app-query-key rejection, foreign-resource 404 before approval gating, no-store and bounded decisions.
- [x] Mounted fixtures verify separate inventory paths, capability/approval agreement and decline/cancel availability while approval is disabled.
- [x] PostgreSQL repository/storage fixtures verify owner-bound invocation/action/member/receipt associations and rejection of automated-origin requests.
- [ ] Validate actual cookie/mobile bearer identities across two accounts, including opposite-client decisions and account switching. Injected authentication does not prove this live gate.
# Existing-contact thread recovery

- [x] Route fixture verifies no bootstrap proposal reads before authentication and thread ownership, stable public recovery with an empty runtime snapshot, and removal after resolution.
- [ ] Verify recovery in two real signed-in clients: owner sees the saved review; a different account cannot read the thread or review.

## Automation deletion

- [x] Injected Fastify auth and isolated PostgreSQL tests verify anonymous/app-key 401, foreign owner 404, strict expected version, stale 409, no-store, owner-stamped cancellation, retained owner-only history and atomic retries.
- [ ] Real cookie/mobile bearer cross-account deletion and sign-out/navigation during pending deletion; confirmation cancel leaves the rule unchanged.


## Context filters and inline decisions (phases 15–16)

- [x] Injected route tests resolve the viewer before list dispatch and reject injected owner query parameters; pass only validated context filters.
- [x] PostgreSQL tests reject another user's Bud/thread and filter by the immutable active target despite draft changes.
- [x] Web/native recovery fixtures preserve canonical request identity, suppress stale pending state and keep approval rows outside collapsed work.
- [ ] Real two-account browser/mobile checks: inline Allow/Enable/Deny, opposite-client resolution, interrupted submission, details dismissal and account switching.
- [ ] Browser navigation to `/data/contacts`, exact request links and filtered Automations retains only the authenticated owner's state.

Context reads stamp no rows. Inline decisions reuse existing owner-authorized,
versioned human endpoints and their existing decision/cancellation actors.

## Thread-scoped automation authoring
- [x] Local PostgreSQL: default/null thread listing excludes other threads and
  foreign-owner rows, even when a foreign row claims the same destination.
- [x] Explicit all listing still filters owner; foreign invocation context fails.
- [x] Proposal detail/decision owner rejection remains covered with added review
  metadata; title lookup filters owner, Bud and nondeleted destination.
- [ ] Live two-account review: another user's proposal/title remains inaccessible.

## Contact trigger evidence
- [x] Exact revision lookup rejects foreign owners and mismatched contact IDs.
- [x] Exact revision fields and history are filtered by server-owned permission.
- [x] First start rejects revoked Contacts permission before publishing evidence.
- [x] Query-time permission changes withhold contacts_get results.
- [ ] Live two-account validation: trigger evidence and resulting transcript are
  visible only to the owning user; data revocation prevents subsequent starts.

### Proxy hostname resolution

- [ ] Verify `/api/proxied-sites/resolve?endpoint_host=...` returns 401 without auth, 404 for another owner's or missing site, and metadata only for the owner (including another owned Bud).
- [ ] Open historical proxy links on web/mobile without changing the current thread attachment; grant ownership and disabled/expired enforcement remain intact.

## Automation model inheritance

- [x] Local PostgreSQL: model source reads filter owner and Bud; foreign destinations fail and deleted new-thread origins use only the service default.
- [x] Agent creation binds origin to the fenced human invocation; tool arguments cannot invent origin, and updates retain authoring provenance.
- [x] Bootstrap admission follows the origin's latest model; later source changes do not alter its snapshot or bypass dispatch permissions.
- [ ] Live two-account web/mobile check: model warnings/review details/history expose only owned source and invocation data; changing an automation target cannot access another user's thread.

Existing owner/tenant stamping and authenticated viewer resolution are unchanged.
Model projection reads add no grant or new management authority.

## Bud-owned browser — experimental phase 0

- [x] Local PostgreSQL temporary-table fixture exercises the actual executor
  ownership SQL, including Bud mismatch/unclaim, soft deletion and withholding
  a result when deletion happens during dispatch. This tests SQL authority only, not cookie/bearer resolution.

- [x] Fixture authority rejects other owners and forged fields before relay work;
  exact Origin and one-use host tickets are covered by relay tests.
- [x] Agent executor fixture rejects wrong owner before dispatch and withholds
  observations after authority changes or cancellation; transcript writes inherit
  the invocation owner.
- [x] Real Chrome/Rust/relay fixture fences agent observations during private
  takeover and returns fresh evidence only after explicit viewer return. Fake
  private input is absent from model requests.
- [ ] Repeat owner/other-owner checks using real cookie/bearer sessions and real
  thread/Bud rows, including revocation during an in-flight read or viewer return.
- [ ] Before product enablement: durable handoff/worker cancellation and stale
  fence rejection, profile ownership, device unclaim, account switching and
  first-party web/mobile recovery. Fixture persistence does not validate these.

Browser authority derives from the invocation owner and matching thread/Bud SQL
ownership, never model arguments. Viewer authority uses the existing authenticated
relay route before control; no new database rows are added in phase 0. See
[findings](../bud-owned-browser/phase-0-findings.md).

## Bud-owned browser — Phase 1 runtime

- [x] Real normal authenticated HTTP chat reaches the actual owner-bound daemon
  through the production broker and persists owner-stamped tool results.
- [x] Local PostgreSQL tests reject foreign owner/Bud, stale invocation fence,
  deleted thread and unclaimed Bud; late evidence is withheld after scope loss.
- [x] Repository test verifies owner/tenant stamps, single active thread session,
  durable no-replay receipt, service identity recovery and deletion close intent.
- [x] WS/gRPC codec and transport tests reject stale tracker/generation results;
  live Chrome manager tests reject foreign scope, stale references and duplicates.
- [ ] Live two-account OAuth/device-unclaim race against the running browser.
- [-] Viewer grants, browser inventory routes and handoff UI: Phase 2/3.

No browser-specific viewer route was introduced. Acting identity comes from the
admitted invocation; ownership is checked before dispatch and before page evidence
is returned. Internal cleanup is privileged lifecycle work, never a global read API.

## Bud-owned browser — Phase 2 private handoff

- [x] Isolated PostgreSQL checks: foreign owner inventory/get/close excluded;
  handoff/continuation records inherit matching owner, thread, Bud and invocation.
- [x] Local anonymous browser-session GET returns 401 before reading content.
- [x] Controller fixture rejects foreign owner, second controller and stale Return;
  unknown return acknowledgement and release leave the invocation paused.
- [x] Daemon authority fixtures reject stale/foreign controller and old-epoch agent
  evidence; private state remains hidden after media loss/lease expiry.
- [x] Real loopback media sockets reject ticket replay and stop sending frames
  after auth revocation; a slow viewer cannot accumulate frames or block another.
- [x] Canonical continuation fixtures restore one original invocation/turn across
  OpenAI/Anthropic/ds4 ledger shapes; cancellation wins over explicit return.
- [ ] Real cookie-authenticated owner/foreign-owner GET/list/control/input/media
  and Origin-denied writes/upgrades, including guessed/copied session IDs.
- [ ] Real sign-out, account switch, unclaim, thread deletion and service restart
  revoke connected media/input; private content remains unavailable to other tabs.
- [ ] Actual agent → viewer → private login → Return with no credential-bearing
  input, frames or URLs in transcript, provider ledger, app/access logs.

New routes resolve the live Better Auth browser session before owner-scoped SQL
and upgrade; private control additionally binds auth session plus viewer UUID.
Browser/handoff rows carry owner and nullable tenant; explicit return stamps the
acting user. Tickets are memory-only and never URL parameters. See
[implementation evidence](../../debug/bud-browser-phase-2.md).

## Bud-owned browser — Phase 3a pane and viewport

- [x] Controller fixture rejects foreign owner and other viewer before viewport
  dispatch; missing capability dispatches nothing; resize preserves epoch/revision.
- [x] Codec tests carry resize over both WS/gRPC encodings; absent capability
  remains false and upgraded carrier advertises fitting.
- [x] Mounted pane test suppresses initial-history/duplicate handoff reveals and
  drops late responses from a previous thread visit.
- [x] Live localhost HTTPS viewport POST without authentication returns 401.
- [ ] Real cookie requests to POST `/api/browser/sessions/:id/viewport`: foreign 404 (including while owner is busy), untrusted Origin 403, malformed
  size 400; second viewer cannot resize or receive private frames.
- [ ] Sign-out/thread switch/dismiss during resize clears media and input; no
  late acknowledgement reopens the pane or returns the agent's authority.

Resize reuses the owned browser resource and existing controller identity, with
owner lookup before occupancy and again inside the mutation. No rows are created;
existing session sequence updates remain owner-authorized. No global read added.


## Agent-owned browser fitting

- [x] Controller fixtures reject foreign owners and non-elected viewers before
  passive fit dispatch; private state cannot use passive authority.
- [x] Live media fixtures bind sizing to owner/generation/epoch and the first
  connected viewer, transferring eligibility after disconnect.
- [ ] Real cookie/Origin checks for passive viewport fitting, including sign-out
  during fit and two viewers with different sizes. Existing 401/404 rules apply.


- [ ] Browser runtime_status is returned only after existing session/thread/Bud
  owner checks; anonymous/foreign session reads remain 401/404. Confirmed restart
  clears stale private UI; missing session never reveals another owner's state.

### Browser viewer recovery

- [ ] Recovery POST still requires a live cookie session, allowed Origin and owned
  browser/thread/Bud before ticket validation or dispatch; foreign IDs return 404.
- [ ] Another viewer UUID or login session cannot use a captured recovery proof.
- [ ] Expiry, signature tampering, daemon boot/generation change, explicit release,
  return and takeover invalidate proofs; no private pixels reach other viewers.
- [ ] Same mounted viewer recovers through service restart without resuming agent
  work or replaying input; duplicate recovery does not duplicate transitions.
- [ ] Tickets do not appear in URLs, logs, transcripts or agent tool payloads.


### Browser agent screenshots (Phase 3d)

- [x] Upload fixture rejects consumed/disposed tickets, disconnected carriers,
  revoked evidence, wrong target, malformed image and oversized request bodies.
- [x] Immutable artifact lookup binds owner/thread/tool call; provider hydration
  performs fresh owner authorization and does not hydrate for text-only models.
- [ ] Real cookie and mobile bearer GET: anonymous 401, other owner/deleted
  thread/Bud 404, sign-out/account switch during image fetch, no-store response.
- [ ] Live takeover during capture/upload prevents late evidence reaching the
  model; no image or upload ticket in SSE, transcript or operational logs.

Artifacts stamp owner, thread, Bud, call, session/generation/epoch and document
from the service-authorized request. No database table or global viewer read.


- [ ] Phase 3e manual: anonymous wait state/cancel returns 401; foreign thread or
  invocation returns 404; two owner waits recover without leaking browser content;
  only the controlling viewer can return, and stopping an old wait preserves chat.


## Operation-driven browser media (Phase 3h)

- [x] Loopback relay fixtures revoke idle viewers when authentication or owner
  authority fails, without requiring another screenshot. Missing frame ACK times
  out even while native pongs continue. Live sizing authority survives idle periods.
- [x] New/slow viewers share bounded capture credit; refresh during delivery is
  retained. Native liveness grants neither frame credit nor private control.
- [x] Canvas regression clears retained pixels on revocation; real Chrome tests
  fence disconnected capture and keep private renewal independent.
- [ ] Real two-account sign-out/unclaim/thread deletion while agent viewer is idle;
  other owner cannot attach or retain pixels. Existing resource ownership applies.
- [ ] Takeover while agent capture is in flight, return, service reconnect and
  multiple real viewers: no private content reaches a passive/previous viewer.

No routes or rows are added. Existing browser-session/thread/Bud owner resolution
and authenticated viewer binding govern attachment, idle checks and delivery.

## Service-owned turn timing

- [x] Isolated PostgreSQL timing lookup excludes foreign owners and wrong threads,
  deduplicates page turn IDs and exposes no open interval/worker credentials.
- [ ] Real cookie/bearer checks: anonymous messages/state/SSE return 401; another
  owner's thread returns 404 before timing lookup or stream attachment/replay.
- [ ] Account switch clears loaded timing, including an in-flight latest refresh.

No new resource or owner stamping. Existing authorized thread APIs carry timing;
page lookup additionally filters invocation owner and thread in SQL.

## Agent viewer continuity (Phase 3j)

- [x] Relay fixtures preserve the same passive group across agent epochs and retain
  owner-bound first-viewer sizing; private media remains epoch/controller-bound.
- [x] An authorization result arriving after a control fence delivers no frame.
- [x] Daemon authority fixtures reject a pre-takeover attachment even after return;
  stale agent commands and private controller checks retain exact authority.
- [ ] Real two-account takeover during capture, sign-out/unclaim/thread deletion,
  return and reconnect: no private pixels reach a passive or previous viewer.
- [ ] Real agent follow-up turns preserve media connection IDs; private takeover
  and return replace those connections and clear old pixels.

No resource or row-stamping changes. Existing authenticated browser-session,
thread and Bud ownership gates protect metadata, attachment, idle checks and delivery.

## Shared persistent browser (Phase 3k)

- [x] PostgreSQL fixtures reject foreign resource ownership/workspace links,
  serialize concurrent resource creation and validate exact lifecycle receipts.
- [x] Bud owner and same-owner device-secret change retires the old resource;
  its profile identity cannot be reused by a subsequent claim.
- [x] Live disposable Chrome tests block cross-workspace targets/observations and
  passive media during global private control; stop/reset retain or clear privacy
  as specified. Existing media tests fence delayed delivery by resource identity.
- [ ] Real cookie sessions: GET `/api/buds/:bud_id/browser` and POST lifecycle
  return 401 anonymously, 404 for another owner's Bud, and reject untrusted Origin
  before writes. Reset without confirmation and stale revision cannot dispatch.
- [ ] Two real signed-in threads: private takeover fences both agents/viewers;
  return wakes only eligible waits, while chat/terminal continue.
- [ ] Offline Stop/Reset stays pending until the matching daemon acknowledges;
  account switch, unclaim and viewer loss cannot restore old private content.

Resources inherit Bud owner/tenant; workspaces inherit matching thread/Bud owner.
Lifecycle requests stamp `requested_by_user_id` from the authenticated viewer.
All new routes resolve live cookie auth and owned Bud before resource SQL or I/O.
Native secure-store and real-account restart acceptance is tracked in Phase 3k.

## Explicit browser page recovery (Phase 3l)

- [x] Controller/DB fixtures reject foreign ownership before recovery, rotate old
  runtime generations, reject stale completion, and preserve close/deletion intent.
- [x] Disposable Chrome fixture binds duplicate URLs to their original workspace,
  rejects old/cross-workspace target IDs and repeated recovery.
- [x] Recovery dispatch follows acknowledged private takeover; failed/unknown
  execution stays private without automatic mutation retry or agent return.
- [x] Mounted viewer test verifies metadata alone never posts recovery.
- [ ] Real two-account cookie/Origin checks for `control operation:reopen`, copied
  session/viewer IDs, deleted threads and account switching during recovery.
- [ ] Two real threads after daemon restart: correct eligible pages/login, private
  content hidden from agents/other viewers until explicit return; old proofs denied.

No new rows or grants. Existing session/thread/Bud owner authorization protects the
control route; daemon-local hints inherit profile owner/environment binding and
never authorize offline access or appear in service inventory.


## Browser native windows — Phase 3m

- [x] Coordinator tests: foreign owner cannot acquire/reveal; stale revision,
  unsupported capability and another viewer reject before dispatch.
- [x] Daemon fixture: wrong private controller/workspace and authority revoked
  during the page-lock wait reject native reveal.
- [x] Show first pauses/acquires globally; hide preserves private control; failed
  hide never resumes browser waits and preserves the renewable controller.
- [ ] Signed-in two-user HTTP check: control POST retains cookie/Origin validation,
  foreign workspace 404, and only owned target IDs can be revealed.
- [ ] Host acceptance: lifecycle/delete/reconnect while native Show is pending;
  manually closed/fullscreen windows and native dialogs. No personal Chrome is
  targeted. Window visibility never authorizes page reads or resumes an agent.


## Browser launch color — Phase 3n

- [x] Isolated PostgreSQL admission rejects foreign owners/Buds before color
  dispatch; another owner's palette choice cannot affect the NULL fallback.
- [x] Private recovery resolves changed Bud color after owned session admission;
  ordinary observe/acquire omit color. No new viewer route or owner-stamped row.
- [x] Strict daemon schema accepts color only as service envelope metadata, not
  an open action argument; profile identity/ownership locks are unchanged.
- [ ] Real two-account Bud settings and next-launch visual acceptance, including
  reclaim/reset and installed-theme precedence. Existing settings auth applies.

## Phase 3p: empty browser workspace recovery

- [x] Isolated repository/continuation tests preserve invocation ownership, private
  parking and stale-generation rejection across fresh restart open.
- [x] Media tests recheck delivery authority for empty markers; revoked viewers
  receive no empty state or old image. Real-Chrome fixtures retain target isolation.
- [ ] Repeat with two authenticated users: a foreign workspace status/control/media
  request remains 404 and cannot create/restore pages or release private authority.
- [ ] Actual owner flow: close last tab, reopen through agent, restart, recover empty
  private workspace and return; check old proofs and references remain rejected.

## Mobile browser scoped visits (Phase 3b)

- [x] Isolated PostgreSQL: one-use grant races, wrong-owner/secret refresh,
  expiry non-revival, owner-only revocation, resource retirement and stable
  service-restart identity. Migration executes against pre-change browser tables.
- [x] Control operation allowlist rejects close, Stop/Reset and host-window actions.
- [ ] Real bearer mint/inventory: anonymous 401 and foreign workspace/thread 404.
- [ ] Real scoped-cookie REST/WS: wrong workspace/viewer 404, Origin rejection,
  generic account/chat/Bud routes unavailable, expiry and revocation stop delivery.
- [ ] Real phone sign-out/unclaim/thread deletion during capture or takeover,
  desktop/phone private exclusion, background privacy cover and explicit return.

Visits inherit workspace owner/tenant. Native grants are not control leases.
Private input and screenshots never enter native chat state or persisted visits.
