# Mobile Auth Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

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
- These checks are still pending because the current hosted/service startup flow regressed before the validation pass could be run.

### `/auth/mobile`

- [ ] `/auth/mobile` renders correctly on a phone-sized viewport.
- [ ] GitHub sign-in started from `/auth/mobile` resumes the OAuth transaction correctly.
- [ ] Google sign-in started from `/auth/mobile` resumes the OAuth transaction correctly.
- [ ] already-authenticated users are handled correctly when entering `/auth/mobile`.

### Consent And Topology

- [ ] `/auth/mobile/consent` renders successfully when forced.
- [ ] trusted first-party clients skip consent where expected.
- [ ] the signed OAuth resume payload survives login redirects.
- [ ] local dev proxy supports the flow from one frontend origin, including metadata/discovery routes.
- [ ] production routing documentation matches the tested topology.

### Recommended Next Work

- [x] extract shared login UI/logic from `/login`.
- [x] implement `/auth/mobile`.
- [x] implement `/auth/mobile/consent`.
- [x] wire Better Auth hosted-page config.
- [x] add the frontend-origin dev proxy for `/api/auth/*`.

## Phase 3: API Contract And Cleanup

### Dual Auth

- [ ] cookie-authenticated requests still work for the existing web app.
- [ ] bearer-authenticated requests return the same owned data for the same user.
- [ ] `/api/me` works with a valid OAuth access token.
- [ ] profile/account update flows work with a valid OAuth access token.

### Native Account Surface

- [ ] linked-account status is available through the documented Bud API.
- [ ] provider-link start/resume flow works through the documented mobile contract.
- [ ] logout/revoke behavior is documented and verified for mobile.

### Route And Contract Cleanup

- [ ] `/api/models` follows the documented authenticated behavior if it is still in use.
- [ ] legacy SSE routes are either authenticated or explicitly documented as legacy/out of scope.
- [ ] terminal sessions can be closed and recreated for the same thread.
- [ ] cancel-agent and interrupt-terminal behavior is clear and testable.
- [ ] mobile-facing API casing follows the documented snake_case-first rules.

## Phase 4: Client Provisioning

- [ ] iOS dev client exists.
- [ ] iOS staging client exists.
- [ ] iOS prod client exists.
- [ ] trusted-client configuration includes the expected client IDs.
- [ ] production Universal Link / app-claimed HTTPS redirect is registered and documented.
- [ ] local-dev callback strategy is documented and verified.
- [ ] each client can complete authorize + token exchange with PKCE.
- [ ] requesting `offline_access` returns a refresh token.

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
