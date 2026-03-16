# Phase 3: Device Claim Flow, QR Bootstrap, And Bud Identity Continuity

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Replace visible device-token onboarding with a browser-mediated Bud claim flow that works well for headless devices.

By the end of this phase:

- Bud can bootstrap auth without a stored `device_secret`
- Bud prints a claim link and terminal QR code
- a signed-in or sign-in-resumed browser can approve the device
- the long-lived device secret is delivered directly to Bud, never shown in the browser UI
- Bud reauth preserves the same `bud_id` when `installation_id` matches

---

## Scope

### In Scope

- `installation_id` persistence on device
- `device_auth_flow` table and service endpoints
- Bud-side claim bootstrap UX
- terminal QR rendering
- claim route in web
- direct Bud delivery of fresh device credentials
- reauth semantics for same `installation_id`

### Out Of Scope

- shared Bud ownership
- advanced device management UI
- separate human-entered fallback claim code flow

---

## Expected Files And Areas

### Bud

- `bud/Cargo.toml`
- `bud/src/main.rs`
- any local config/storage paths used for `installation_id` and `device_secret`

### Service

- `service/src/db/schema.ts`
- `service/src/routes/` for device-auth endpoints
- `service/src/ws/gateway.ts` only if reconnect/bootstrap integration needs adjustment
- `service/src/auth/` if claim approval helpers belong there

### Web

- `web/src/routes/login.tsx`
- `web/src/routes/devices/claim/$flowId.tsx` or equivalent file-based route
- `web/src/lib/auth-client.ts`
- any mobile-friendly claim UI components

### Documentation / Specs

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/ws/ws.spec.md` if `/ws` device behavior changes
- `web/src/routes/routes.spec.md`
- `web/src/components/components.spec.md` if claim UI components are added
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Add `installation_id` to Bud identity

Device behavior:

- Bud generates a stable non-secret `installation_id` on first run
- Bud stores it locally
- losing `device_secret` should not delete or rotate `installation_id`

Schema behavior:

- add `installation_id` to `bud`
- unique constraint

### Task 2: Add `device_auth_flow`

Create a short-lived bootstrap table such as:

- `flow_id`
- `installation_id`
- `poll_secret_hash`
- requested device metadata
- `approved_by_user_id`
- status/timestamps

Purpose:

- pending unauthenticated device claim
- secure Bud-side polling/consumption
- explicit approval state

### Task 3: Add bootstrap endpoints

Recommended service endpoints:

- `POST /api/device-auth/start`
- `POST /api/device-auth/poll` or equivalent Bud-side consumption endpoint
- authenticated browser approval endpoint(s) for the claim page

Notes:

- `start` and Bud polling will likely be public or semi-public endpoints
- approval endpoint must require a logged-in browser user
- long-lived credential issuance must happen only after approval
- Bud polling is the canonical delivery path for the fresh `device_secret`

### Task 4: Add Bud terminal UX

Bud should print:

- claim URL
- QR code for the claim URL
- clear state text such as "Waiting for browser approval..."

The terminal should never print:

- `device_secret`
- reusable hidden verifier

### Task 5: Add claim route in web

Recommended route:

- `/devices/claim/$flowId`

Behavior:

- resolve pending flow
- if anonymous, login then resume
- if authenticated, auto-approve immediately
- show success/failure state

This route must work well on mobile because phone QR scans are a primary use case.

### Task 6: Add direct Bud credential delivery

The browser must not become the carrier for `device_secret`.

Delivery pattern for v1:

- Bud polls with the hidden verifier until approval is available

The invariant is fixed:

- browser sees claim success
- Bud receives credential directly

### Task 7: Preserve Bud identity on reauth

Rules to implement:

- same `installation_id` + same owner => reuse existing `bud_id`
- issue a fresh `device_secret`
- preserve existing threads and sessions
- same `installation_id` + different owner => reject for now
- missing `installation_id` match => create new Bud

---

## Resolved Defaults For This Phase

1. Claim approval auto-completes immediately for logged-in users.
2. Bud-side credential delivery is polling-based.
3. Device onboarding uses claim URL plus QR only; there is no separate fallback short code in v1.
4. `installation_id` lives in the same Bud config directory as other auth material, but in a separate file from `device_secret` so the secret can be lost without losing installation identity.

---

## Validation Checklist

- [ ] Bud without `device_secret` can start a pending claim
- [ ] Bud prints a usable link and QR code in a terminal
- [ ] scanning the QR code on a phone reaches the claim page
- [ ] logged-out browsers can sign in and resume the same claim
- [ ] logged-in browsers can approve the claim successfully
- [ ] browser UI never exposes `device_secret`
- [ ] Bud receives the new `device_secret` directly
- [ ] deleting only the local `device_secret` and reclaiming preserves the same `bud_id`

---

## Spec Updates Required

- [ ] `bud/bud.spec.md`
- [ ] `bud/src/src.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/ws/ws.spec.md` if needed
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/components/components.spec.md` if claim UI components are added
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when a headless Bud install can be claimed by opening a link or scanning a QR code, and a lost device secret can be replaced without creating a duplicate Bud identity.

---

*Last Updated: 2026-03-13*
