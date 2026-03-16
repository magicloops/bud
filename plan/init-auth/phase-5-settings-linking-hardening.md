# Phase 5: Settings, Account Linking, And Launch Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Finish the user-facing auth product surface and close the operational gaps required for launch.

By the end of this phase:

- users have a real settings page
- linked-account visibility and linking actions work
- profile editing works
- session-expiry handling is clean
- auth, claim, and ownership behaviors are tested end-to-end

---

## Scope

### In Scope

- `/settings` route and UI
- profile management UI
- linked-account visibility
- explicit account linking from settings
- sign-out/session actions
- auth expiry behavior in browser and SSE flows
- rollout validation and test coverage

### Out Of Scope

- shared Bud management
- org/team settings
- advanced avatar uploads/media storage
- unlink support

---

## Expected Files And Areas

### Web

- `web/src/routes/settings.tsx` or nested settings route structure
- settings-related components in `web/src/components/`
- `web/src/lib/auth-client.ts`
- auth-aware API/SSE helpers
- any user-menu/avatar shell components

### Service

- profile update endpoint(s)
- linked-account listing endpoint(s) for the Bud-owned normalized settings view
- session/logout helpers as needed

### Documentation / Specs

- `web/web.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/components/components.spec.md`
- `web/src/lib/lib.spec.md`
- `service/src/routes/routes.spec.md`
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Add `/settings`

Settings should include:

- profile section
- linked accounts section
- session/account actions section

This route is for already-authenticated users and is distinct from device-claim UI.

### Task 2: Add profile management

Implement:

- username editing
- provider-avatar display with generated initials fallback when no image is available

Provider data remains the avatar source in v1; only the username is user-editable in this phase.

### Task 3: Add linked-account visibility

The user should be able to see:

- GitHub connected or not
- Google connected or not

This can be powered by:

- Better Auth API/client surface where available
- a thin Bud-owned normalized endpoint where the app needs a stable read model

### Task 4: Add explicit linking actions

From settings:

- connect GitHub
- connect Google

Explicit linking should require an already-authenticated Bud session. Same-email provider sign-ins should already auto-link outside settings when the provider email is verified and matches an existing user.

### Task 5: Add session/logout UX

Minimum:

- sign out
- handle expired session redirect to `/login`

The current app’s reconnect behavior around terminal and agent SSE must stop cleanly once the browser is no longer authenticated.

### Task 6: Harden auth expiry handling

Ensure:

- `401` from normal APIs redirects cleanly
- SSE failures caused by auth do not loop forever
- claim flows fail clearly if expired

### Task 7: Test launch-critical paths

Required end-to-end scenarios:

- standard GitHub login
- standard Google login
- GitHub login followed by Google login with the same verified email auto-links to the same account
- direct browser entry while authenticated
- direct browser entry while unauthenticated
- device claim via QR
- device claim resume after login
- reclaim after local `device_secret` loss
- unauthorized access by another user

### Task 8: Final rollout prep

Before launch:

- confirm prototype data will be wiped before enforcement is enabled
- verify same-origin production deployment and proxied development behavior
- confirm env var requirements and secrets handling
- verify spec docs are updated everywhere touched

---

## Resolved Defaults For This Phase

1. Linked accounts are connect-only in v1; unlink is deferred.
2. Avatars stay provider-owned in v1; when no provider image is available, the UI uses a generated initials fallback.
3. A dedicated "current device claims" admin/debug view is out of scope for v1.

---

## Validation Checklist

- [x] Settings route loads for authenticated users
- [ ] Settings route is protected from unauthenticated access
- [x] Profile edits persist correctly
- [ ] Linked provider state renders correctly
- [x] Explicit linking works for both Google and GitHub
- [x] Sign-out works
- [x] Expired sessions redirect cleanly
- [x] Terminal/agent reconnect loops stop when auth is gone
- [ ] End-to-end auth and claim scenarios pass

---

## Spec Updates Required

- [ ] `web/web.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/components/components.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when Bud’s auth surface is both functional and shippable:

- normal browser users can log in
- device users can claim a Bud
- users can manage their account state from settings
- the app behaves predictably when auth expires or credentials are lost

---

## Manual Verification Notes

- `2026-03-16`: `/settings` username save passed locally.
- `2026-03-16`: explicit GitHub and Google linking from settings passed locally.
- `2026-03-16`: sign-out from settings passed locally.
- `2026-03-16`: active-thread session-expiry behavior passed locally; the app redirected to `/login` and live reconnect loops stopped once auth was gone.

*Last Updated: 2026-03-16*
