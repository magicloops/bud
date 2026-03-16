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
- [ ] Logout succeeds and returns the browser to an unauthenticated state.
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

### Local Ownership Sanity

- [ ] Existing backfilled Buds still appear for local user `dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe`.
- [ ] Existing backfilled threads/messages/runs still appear correctly for that same user.
- [ ] Newly claimed Buds are created with the expected owner user id in the database.

## Run Now After Phase 4 Lands

### List And Read Scoping

- [ ] `GET /api/buds` returns only the signed-in user’s Buds.
- [ ] `GET /api/threads` returns only the signed-in user’s threads.
- [ ] Direct navigation to another user’s `/$budId/$threadId` fails cleanly.
- [ ] Resource-scoped unauthorized access returns `404` rather than leaking existence.

### Write And Stream Authorization

- [ ] A second user cannot post messages to another user’s thread.
- [ ] A second user cannot attach to another user’s terminal SSE stream.
- [ ] A second user cannot send terminal input, interrupt, or resize requests to another user’s thread.
- [ ] A second user cannot see another user’s run history.

### Ownership Stamping

- [ ] New thread rows have the correct `created_by_user_id`.
- [ ] New message rows have the correct `created_by_user_id`.
- [ ] New run rows have the correct `created_by_user_id`.
- [ ] New terminal session rows have the correct `created_by_user_id`.
- [ ] New terminal input log rows record the acting human `user_id`.

### Second-User Verification Pass

- [ ] Create a second real user and confirm they cannot see the first user’s Buds, threads, runs, sessions, or messages.
- [ ] Confirm the original local dev user still sees all preserved backfilled prototype fixtures.
- [ ] Confirm a newly claimed Bud for user A does not appear for user B.
- [ ] Confirm raw copied URLs from user A do not load for user B.

## Run After Phase 5 Or Before Launch

### Settings And Linked Accounts

- [-] `/settings` renders successfully for an authenticated user.
- [-] Settings shows linked-account state for GitHub and Google.
- [-] Username editing works and persists.
- [-] Avatar rendering uses provider image when available.
- [-] Avatar rendering falls back to generated initials when no provider image exists.
- [-] Explicit provider linking from settings works when same-email auto-linking does not apply.

### Session And Expiry Behavior

- [-] Expired browser sessions redirect cleanly back to `/login`.
- [-] Terminal and agent reconnect loops stop after auth expiry instead of spinning forever.
- [-] Login resumes back to the intended route after reauthentication.

## Notes

- Keep this checklist up to date as items are verified or deferred.
- Reuse the same preserved local data set for Phase 4/5 multi-user verification where practical.
- If behavior changes materially, update this checklist and the relevant phase plan docs together.
