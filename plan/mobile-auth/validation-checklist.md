# Mobile Auth Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).
Use [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md) as the concrete integration package for the current localhost iOS test pass.
Keep [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md) as the later cross-environment bundle template.

Use this as the running verification list while the mobile-auth phases land. Keep it current as behavior is implemented, verified, or explicitly deferred.

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Server Readiness

### Migration And Baseline

- [x] Drizzle migration history is repaired through `0008`.
- [x] `pnpm db:generate` exits with no pending schema changes.
- [x] `pnpm db:migrate` applies successfully on the existing local dev database after the migration-history repair.
- [ ] checked-in migrations provision the same auth/plugin tables in a clean database.

### OAuth Provider And Metadata

- [ ] Better Auth starts with `oauthProvider + jwt` enabled.
- [ ] OpenID discovery resolves from the intended issuer/public origin.
- [ ] OAuth authorization-server metadata resolves at the documented path.
- [ ] JWKS resolves at the documented path.
- [ ] any required protected-resource metadata resolves correctly.
- [ ] `/api/auth/token` is disabled in OAuth Provider mode.

### Verification And Schema

- [ ] access-token verification rejects wrong issuer.
- [ ] access-token verification rejects wrong audience.
- [ ] access-token verification rejects missing or wrong scope.
- [ ] local `pnpm db:push` provisions the required Better Auth plugin tables.
- [ ] checked-in migrations provision the same tables in a clean database.
- [ ] existing browser cookie auth still works after Phase 1 lands.

## Phase 2: Hosted Auth Pages

Current note:

- Phase 2 runtime validation is the next step.
- Direct browser validation now confirms that `/auth/mobile` can complete ordinary Bud sign-in.
- The real mobile OAuth transaction is still pending because the flow has not yet been started from a signed `/api/auth/oauth2/authorize` request.
- Deferred hosted-flow checks are tracked in `phase-2-deferred-validation-checklist.md` while prototype work proceeds into Phase 3.

### `/auth/mobile`

- [ ] `/auth/mobile` renders correctly on a phone-sized viewport.
- [x] direct browser sign-in from `/auth/mobile` works for ordinary Bud login.
- [ ] GitHub sign-in started from `/auth/mobile` resumes the OAuth transaction correctly.
- [ ] Google sign-in started from `/auth/mobile` resumes the OAuth transaction correctly.
- [ ] already-authenticated users are handled correctly when entering `/auth/mobile`.

### Consent And Topology

- [ ] `/auth/mobile/consent` renders successfully when forced.
- [ ] trusted first-party clients skip consent where expected.
- [ ] the signed OAuth resume payload survives login redirects.
- [ ] a real signed `/api/auth/oauth2/authorize` request reaches the hosted pages correctly.
- [ ] local dev proxy supports the flow from one frontend origin, including metadata/discovery routes.
- [ ] production routing documentation matches the tested topology.

### Recommended Next Work

- [x] extract shared login UI/logic from `/login`.
- [x] implement `/auth/mobile`.
- [x] implement `/auth/mobile/consent`.
- [x] wire Better Auth hosted-page config.
- [x] add the frontend-origin dev proxy for `/api/auth/*`.
- [ ] provision or register a local/dev OAuth client for real authorize-request testing.

## Phase 3: API Contract And Cleanup

Current note:

- The first native account/session/logout/revoke routes are now implemented.
- The thread-view SSE/request-storm regression has been fixed, so runtime verification is unblocked again.
- The new routes still need runtime verification before they can be treated as handoff-ready.

### Dual Auth

- [ ] cookie-authenticated requests still work for the existing web app.
- [ ] bearer-authenticated requests return the same owned data for the same user.
- [ ] `/api/me` works with a valid OAuth access token.
- [ ] profile/account update flows work with a valid OAuth access token.

### Native Account Surface

- [ ] linked-account status is available through the documented Bud API.
- [ ] `/api/me/accounts` returns the documented linked-account inventory.
- [ ] `/api/me/sessions` returns the documented browser-session inventory.
- [ ] provider-link start/resume flow works through the documented mobile contract.
- [ ] logout/revoke behavior is documented and verified for mobile.

### Route And Contract Cleanup

- [x] the thread view no longer enters the repeated `/api/me` + `/terminal` + SSE reconnect storm seen during local Phase 3 testing.
- [ ] `/api/models` follows the documented authenticated behavior if it is still in use.
- [ ] legacy SSE routes are either authenticated or explicitly documented as legacy/out of scope.
- [x] terminal sessions can be closed and recreated for the same thread.
- [ ] cancel-agent and interrupt-terminal behavior is clear and testable.
- [ ] mobile-facing API casing follows the documented snake_case-first rules.

## Phase 4: Client Provisioning

- local dev is the active target for this phase right now.
- staging and production publication are intentionally deferred until the localhost pass succeeds.

- [ ] iOS local/dev client exists.
- [-] iOS staging client exists.
- [-] iOS prod client exists.
- [ ] trusted-client configuration includes the expected local client ID.
- [-] production Universal Link / app-claimed HTTPS redirect is registered and documented.
- [ ] local-dev callback strategy is documented and verified.
- [ ] the local/dev client can complete authorize + token exchange with PKCE.
- [ ] the local/dev client receives a refresh token when requesting `offline_access`.

## Phase 5: End-To-End Hardening

### Core Flows

- [ ] standard browser login still works through `/login`.
- [ ] auth code + PKCE flow works end to end for mobile.
- [ ] refresh-token rotation works as expected.
- [ ] logout/revoke behavior works as documented.

### Failure Cases

- [ ] invalid client ID fails clearly.
- [ ] invalid redirect URI fails clearly.
- [ ] invalid or missing PKCE verifier fails clearly.
- [ ] wrong audience access token is rejected by the API.
- [ ] missing scope access token is rejected by the API.
- [ ] expired or revoked refresh token fails clearly.
- [ ] disabled OAuth client fails clearly.

### Handoff Readiness

- [ ] rollout and rollback notes are documented.
- [ ] specs are updated for all touched areas.
- [ ] the mobile-team handoff package is ready.

## Notes

- Update this checklist as soon as a validation item is run or deferred.
- If the implementation changes the expected contract, update this checklist and the phase docs together.
