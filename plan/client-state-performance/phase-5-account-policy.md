# Phase 5: Account eligibility and revocation contract

Status: Proposed; policy/provider decisions outstanding. Request: F4.
Independent of performance phases; do not claim complete until enforcement and
the supported client policy are tested.

## Decisions to record before final schema/API implementation

| Decision | Recommended starting scope | Evidence / owner |
|---|---|---|
| Disablement | Live account eligibility for cookie and bearer resources | Product/backend: disable/re-enable and audit semantics |
| Revocation | Separate account disablement from credential revocation; use all-session invalidation first if no current single-device need | Product/backend: explicit selected scope |
| Provider integration | Reuse installed provider/session identity where available | Backend: inspect installed claims, token issuance and refresh behavior |
| Cached display | Owner/issuer-scoped cached paint while revalidating, explicitly accepting an offline revocation window | Mobile/web/product: accept or require validation before display |
| Existing streams | Enforce live policy on delivery/control and close idle connections within a proposed 15-second bound | Backend/product: confirm bound, load-test cost |
| Bud/automation behavior | Specify separately from human read access | Product/backend: whether disablement pauses execution, how re-enable behaves |

These are recommendations, not user-approved product policies. Work on writer
inventory, auth-path audit and provider verification can proceed independently;
do not invent a `session_revoked` guarantee from JWT expiry or refresh revocation.

## Implementation sequence

### A. Shared account eligibility

Introduce a durable account policy record only after reviewing existing auth
schema. Store target account, disabled state/time and administrator audit data;
new application tables include owner/tenant conventions. Define an authorized
operator command or existing administrative path, not a public unauthenticated
toggle. Record acting administrator separately from the affected account.

All cookie/bearer viewer resolution and normalized `/api/me` must consult the
same eligibility decision. A missing live auth user cannot be resurrected from
token claims. Audit specialized browser visits, proxies, files, terminal streams,
media/control and OAuth issuance/refresh, not only `requireViewer` callers.
Avoid long-lived positive eligibility caches that violate the selected bound.

Verified disabled identity returns `403 {"error":"account_disabled"}`. Invalid
or expired credentials remain authentication failures; signed-in foreign resource
lookups remain `404`. Backend lookup failures fail closed with a retryable service
error, never masquerading as disabled or instructing clients to wipe caches.

Re-enable must not silently revive credentials explicitly revoked by policy.
Check/close existing streams and derived scoped credentials under the selected
bound, including idle streams; perform the final authorization check before
delivery/control. Document unavoidable in-flight response race limits honestly.

### B. Credential revocation

If selecting all-session invalidation, evaluate account credential epoch versus
valid-after timestamps against actual cookie/JWT issuance precision and refresh
behavior. Block minting fresh credentials from revoked refresh grants. If selecting
per-device revocation, require stable session/grant association through bearer
verification and a live revocation check. Do not implement both approaches.

Only emit a stable `session_revoked` error when the service can establish that
specific condition after verification. Final HTTP mapping and mobile token-refresh
behavior must be specified from the chosen provider flow before implementation.
Ordinary expiration should retain normal bounded refresh/re-authentication.

### C. Client handling

Centralize terminal-auth outcomes in web/mobile transport: cancel requests and
streams, clear owner-specific cached state and credentials as policy requires,
and fence late responses so they cannot repopulate data. Namespace caches by
issuer/environment and owner; clear on logout/account switch independent of F4.
Do not wipe transcript storage on timeout, service outage or refreshable expiry.

Server errors cannot erase offline storage or prevent cached painting before
validation. Document the selected display policy in the handoff and test it.

## Validation and rollout

- [ ] Decision table resolved; exact policy fields, errors and administrative
      mechanism added to this phase before coding the schema.
- [ ] Cookie and bearer parity across resource reads, `/me`, token issuance and
      refresh; deleted user cannot fall back to claims.
- [ ] Disable/re-enable, revoke, ordinary expiry, provider errors and DB outage.
- [ ] Existing active/idle SSE, browser/scoped visits and WebSocket control obey
      selected enforcement bound; no foreign-owner metadata leakage.
- [ ] Client late responses, offline display, account switch and cache cleanup.
- [ ] DB push, generated migration review, deployed migrate and credential
      renewal requirements documented. Do not remove policy state on rollback.

Ship independently when policy and enforcement are ready. Other phases must not
be held open by this phase, but report F4 as outstanding until its acceptance passes.
