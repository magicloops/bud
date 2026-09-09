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
