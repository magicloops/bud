# Implementation Spec: Production Authentication And Bud Claim Flow

**Status**: In Progress
**Created**: 2026-03-13
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

Bud currently has:

- no human authentication boundary
- globally visible browser data
- no user-scoped ownership enforcement
- a device bootstrap flow based on visible enrollment tokens
- no web-client login shell
- no user settings or linked-account management

The design doc defines the target state:

- Better Auth for human auth
- standard web login for browser users
- browser-mediated Bud claim flow for devices
- hidden long-lived device credentials
- per-user resource isolation
- settings and account linking

This implementation spec turns that design into a phased build plan.

### Related Spec Files

| Spec File | Relevance |
|-----------|-----------|
| `bud.spec.md` | Project-wide auth and ownership documentation |
| `bud/bud.spec.md` | Bud daemon bootstrap and identity flow |
| `bud/src/src.spec.md` | Bud Rust implementation details |
| `service/service.spec.md` | Service architecture and auth integration |
| `service/src/src.spec.md` | New auth module and route wiring |
| `service/src/db/db.spec.md` | New auth-adjacent schema usage |
| `service/src/routes/routes.spec.md` | Browser and device-auth endpoints |
| `service/src/ws/ws.spec.md` | Existing Bud device auth over `/ws` |
| `web/web.spec.md` | Login/settings addition at app level |
| `web/src/src.spec.md` | Auth client and app session plumbing |
| `web/src/routes/routes.spec.md` | `/login` and `/devices/claim/$flowId` routes |
| `web/src/lib/lib.spec.md` | Auth-aware fetch/SSE helpers |
| `web/src/components/components.spec.md` | Settings/account UI |
| `web/src/contexts/contexts.spec.md` | Current-user/auth session state |

---

## Objective

Implement production-ready authentication in six phases:

1. Better Auth foundation in the service, including persistent browser sessions.
2. Standard web-client login flow and an auth-aware app shell.
3. Browser-mediated Bud device claim flow with link/QR onboarding and identity continuity.
4. Local-development ownership backfill for existing prototype data.
5. Ownership stamping and authorization enforcement across Bud-owned resources.
6. Settings, account linking, expiry handling, testing, and rollout hardening.

### Success Criteria

- [ ] Users can sign in to the web client with GitHub or Google.
- [ ] Unauthenticated users are redirected to `/login`.
- [ ] Bud can be claimed by opening a link or scanning a QR code without exposing a long-lived device secret.
- [ ] Reauth with the same `installation_id` preserves the same `bud_id` and history.
- [ ] Users can see only their own Buds, threads, runs, sessions, and messages.
- [ ] Settings page shows linked accounts, supports username management, and renders provider-avatar fallback correctly.
- [ ] Linked-account flow works from an authenticated settings session.
- [ ] Expired browser sessions fail cleanly instead of leaving the UI in reconnect loops.

---

## Design Anchors

These design decisions are assumed throughout the phases:

- Better Auth lives in a dedicated PostgreSQL schema such as `auth`.
- Bud-owned app data remains in `public`.
- Bud uses one required unique `username` field as the user-facing display label in v1.
- Avatar handling is provider-only in v1, with a generated initials fallback in the UI when no provider image exists.
- `device_secret` is never shown in browser UI.
- Bud stores a stable non-secret `installation_id`.
- Standard web login and device claim are separate entry paths that share the same Better Auth browser session model.
- Shared-Bud multi-user access is out of scope for this tranche.

## Resolved Defaults

- `user_profile` bootstrap happens in Bud-owned session/bootstrap code after login, not in Better Auth hooks.
- `/api/me` and any linked-account read model are Bud-owned normalized responses even if they are backed by Better Auth internally.
- Linked accounts are connect-only in v1; unlink is deferred.
- Same-email provider sign-ins auto-link when they return the same verified email for an existing user.
- Logged-in device claims auto-approve immediately.
- Bud receives new device credentials via polling-based claim completion.
- Device onboarding uses a short claim URL plus QR only; no separate fallback short code in v1.
- Unauthorized resource-scoped access returns `404`; `401` is reserved for unauthenticated requests.
- Prototype data is wiped before launch in production instead of being backfilled to a bootstrap user.
- Local development may use a one-off ownership backfill phase to preserve prototype fixtures for Phase 5 authorization testing.
- Production deployment standardizes on same-origin web + service, with proxied development if needed.

---

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-auth-foundation.md](./phase-1-auth-foundation.md) | Better Auth mounted in service, auth DB/schema ready, request session helpers in place |
| 2 | [phase-2-web-login-shell.md](./phase-2-web-login-shell.md) | Browser users can sign in and enter an auth-aware app shell |
| 3 | [phase-3-device-claim-flow.md](./phase-3-device-claim-flow.md) | Bud device claim via link/QR works and preserves Bud identity on reauth |
| 3.5 | [phase-3.5-local-dev-data-backfill.md](./phase-3.5-local-dev-data-backfill.md) | Existing local prototype data is assigned to the current dev user for Phase 4/5 testing |
| 4 | [phase-4-ownership-enforcement.md](./phase-4-ownership-enforcement.md) | Per-user ownership is stamped and enforced across all key resources |
| 5 | [phase-5-settings-linking-hardening.md](./phase-5-settings-linking-hardening.md) | Settings, account linking, session-expiry handling, tests, rollout readiness |

### Sequencing Notes

- Phase 1 is a hard prerequisite for every later phase.
- Phase 2 and Phase 3 both depend on Phase 1 but can overlap partially once the auth foundation is stable.
- Phase 3.5 is optional and local-development-only; it exists to preserve useful prototype fixtures before Phase 4 testing.
- Phase 4 should not ship half-done; route enforcement needs to land as a coherent pass.
- Phase 5 closes the product surface and operational gaps before launch.

---

## Entry Paths

### Standard Web Login

```text
browser opens Bud
  -> app resolves session
  -> no session => /login
  -> user signs in with GitHub or Google
  -> Better Auth creates session
  -> app loads only authorized Bud data
```

### Device Claim

```text
Bud starts without valid device_secret
  -> Bud requests pending claim
  -> Bud prints claim link + QR code
  -> user opens link on browser/phone
  -> if needed, browser signs in
  -> claim auto-approves for the logged-in user
  -> service delivers new device_secret directly to Bud
  -> Bud reconnects as the same bud_id when installation_id matches
```

---

## Spec Files To Update

### New Specs Expected During Implementation

- [ ] `service/src/auth/auth.spec.md` for the new auth module folder
- [ ] any new nested folder specs created during implementation

### Existing Specs Expected To Change

- [ ] `bud.spec.md`
- [ ] `bud/bud.spec.md`
- [ ] `bud/src/src.spec.md`
- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/ws/ws.spec.md`
- [ ] `web/web.spec.md`
- [ ] `web/src/src.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `web/src/components/components.spec.md`
- [ ] `web/src/contexts/contexts.spec.md`

### Possibly Impacted Docs

- [ ] `docs/proto.md` only if `/ws` or SSE contracts change

---

## Impacted Contracts

- [x] DB schema
- [x] Web UI
- [x] Bud CLI/device bootstrap UX
- [ ] WSS protocol
- [ ] SSE event shapes
- [ ] Agent tools

Notes:

- WSS changes are not currently planned if Bud claim remains an HTTP bootstrap plus existing `/ws` reconnect.
- SSE authz behavior will change, but event payload shapes do not necessarily need to change.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Better Auth table collision with existing `session` table | High | High | Use dedicated `auth` schema from day one |
| Split-origin cookie/SSE behavior causes auth bugs | High | High | Normalize fetch/EventSource helpers and prefer same-origin prod |
| Device reauth accidentally creates duplicate Buds | Medium | High | Require stable `installation_id` and clear reuse rules |
| Partial ownership rollout leaves data globally accessible | Medium | High | Land Phase 4 as a coherent pass, not piecemeal |
| Historical prototype data blocks enforcement | High | Medium | Wipe prototype data before production enforcement; use the local-dev-only Phase 3.5 backfill when preserving fixtures is useful |
| Linked-account edge cases complicate launch | Medium | Medium | Auto-link same verified-email providers, keep explicit linking as fallback, and defer unlink |

---

## Rollout Strategy

1. Land Better Auth foundation behind no-op route enforcement first.
2. Land web login and session-aware shell.
3. Land device claim flow and Bud identity continuity.
4. Optionally backfill existing local-development data to a known user via Phase 3.5.
5. Migrate ownership stamping and enforce authorized reads/writes.
6. Land settings/linking UX and expiry handling.
7. Wipe prototype data before enabling ownership enforcement in production.
8. Validate end-to-end before enabling production auth as the default path.

### Rollback Guidance

- Phase 1 rollback: disable Better Auth route wiring and revert auth schema changes before depending phases land.
- Phase 2 rollback: revert web auth gating and login UI; service foundation can remain dormant.
- Phase 3 rollback: keep legacy/manual device enrollment path available until claim flow is validated.
- Phase 3.5 rollback: restore the local dev database from backup or re-run a clean seed if the one-off backfill is no longer wanted.
- Phase 4 rollback: do not partially revert route authz; if needed, revert the full ownership-enforcement pass together.
- Phase 5 rollback: profile/settings UX can be reverted independently if auth core remains stable.

---

## Definition Of Done

- [ ] All phases completed or explicitly descoped with review signoff.
- [ ] Better Auth is the active browser auth system.
- [ ] Standard web login works.
- [ ] Device claim via link/QR works.
- [ ] Reauth preserves Bud identity when `installation_id` matches.
- [ ] All major browser-facing routes enforce ownership.
- [ ] Settings page ships with linked-account visibility, username management, and provider-avatar fallback.
- [ ] Specs updated for every touched module/folder.
- [ ] Tests cover auth, claim, and ownership behavior.

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Better Auth foundation landed in the service |
| 2 | Complete | Web login shell, auth-aware loaders, and Better Auth client wiring landed |
| 3 | Complete | Device claim via link/QR and Bud identity continuity landed |
| 3.5 | Complete (local dev) | Local prototype data backfill was run to preserve fixtures for multi-user testing |
| 4 | Complete | Ownership stamping and per-user authorization enforcement landed |
| 5 | In Progress | Settings/profile editing, explicit provider linking, sign-out, and session-expiry handling landed; manual validation is underway |

---

*Last Updated: 2026-03-15*
