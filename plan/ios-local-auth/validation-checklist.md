# Validation Checklist: Local iOS Auth Backend Readiness

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/ios-local-auth-backend-readiness.md](../../design/ios-local-auth-backend-readiness.md)

---

## 1. Public Origin And Topology

- [ ] `APP_BASE_URL` is set to `http://localhost:5173`
- [ ] `BETTER_AUTH_URL` is set to `http://localhost:5173`
- [ ] `API_AUDIENCE` is set to `http://localhost:5173/api`
- [ ] Local docs no longer describe `3000` as the public auth issuer
- [ ] Provider callback guidance points at `http://localhost:5173/api/auth/callback/github`
- [ ] Provider callback guidance points at `http://localhost:5173/api/auth/callback/google`
- [ ] The Vite proxy preserves enough host/proto information for the service to reconstruct the public origin

## 2. Metadata And Discovery

- [ ] `http://localhost:5173/api/auth/.well-known/openid-configuration` resolves
- [ ] `http://localhost:5173/.well-known/oauth-authorization-server/api/auth` resolves
- [ ] `http://localhost:5173/.well-known/oauth-protected-resource/api` resolves
- [ ] `http://localhost:5173/api/auth/jwks` resolves
- [ ] Discovery metadata advertises issuer `http://localhost:5173/api/auth`
- [ ] Metadata endpoints advertise `5173`, not `3000`

## 3. Local Client Provisioning

- [ ] The repo contains an idempotent local iOS provisioning script
- [ ] The provisioning script creates or updates `bud-ios-dev-local`
- [ ] The registered redirect URI is exactly `chat.bud.app://oauth/callback`
- [ ] The client is public (`token_endpoint_auth_method = none`)
- [ ] Grant types include `authorization_code` and `refresh_token`
- [ ] PKCE is required
- [ ] `skip_consent` is enabled for the local first-party client
- [ ] The provisioning script emits the local auth bundle in a stable format

## 4. Hosted OAuth Flow

- [ ] A real signed authorize request reaches the hosted login page
- [ ] Google selection works through the hosted page
- [ ] GitHub selection works through the hosted page
- [ ] OAuth resume state is preserved through hosted login
- [ ] If consent is forced, `/auth/mobile/consent` completes the flow correctly
- [ ] The callback returns `code` and `state` to `chat.bud.app://oauth/callback`

## 5. Token And API Flow

- [ ] Code exchange succeeds for `bud-ios-dev-local`
- [ ] Requesting `offline_access` returns a refresh token
- [ ] Refresh succeeds
- [ ] `GET /api/me` succeeds with the bearer access token through `http://localhost:5173/api/me`
- [ ] `/api/me` returns `auth_type: "bearer"`
- [ ] `POST /api/me/oauth/revoke` requires `client_id`
- [ ] Revoke succeeds when `client_id=bud-ios-dev-local` is supplied

## 6. Handoff Output

- [ ] The backend repo publishes one exact local auth bundle
- [ ] The local auth bundle uses `http://localhost:5173` consistently
- [ ] The bundle includes the real local `client_id`
- [ ] The bundle includes the exact redirect URI
- [ ] The bundle includes authorize/token/userinfo/JWKS/discovery URLs
- [ ] The bundle includes the revoke/logout caveat about `client_id`
- [ ] `plan/mobile-auth/mobile-team-local-dev-guide.md` matches the emitted bundle

---

## Signoff

- [ ] Backend/web validation complete
- [ ] Bundle sent to iOS
- [ ] iOS simulator validation started

---

*Last Updated: 2026-03-20*
