# Phase 7: Human-approved app query keys

Status: request/policy schemas, protected handoff, approval/key repository, scoped queries, HTTP routes, expiry, backend helper, durable continuation and mobile/web review are implemented. Issuance is default-off; `APP_DATA_KEYS_ENABLED=1` requires durable invocation mode. Live opposite-client/agent/private-viewer acceptance remains open. Dependencies: phases 4 and 5. Parent: [implementation spec](implementation-spec.md).

## Outcome

Storage uses locally applied migration `0032_flat_wilson_fisk.sql`. The
[mounted API](implemented-app-data-api.md) and [protected handoff](app-key-handoff.md)
describe current contracts; no daemon protocol change is required.

An agent building a private owner app requests data access with a tool call. The user approves on mobile or web; the service issues one scoped query key and completes a recoverable app-setup handoff. The app backend queries contacts/history/location through the same authorization layer. This is part of the initial deliverable, not the later dashboard-viewer broker.

## Request, decision and continuation

The implemented `data_request_api_key` tool accepts bounded `app_label`, `purpose`, requested query scopes, field/precision/history restrictions and the private-site/public-key setup destination. Owner, thread, invocation and tool-call identity come from server context. Persist an immutable `data_access_request`; do not mint a key yet. Retries of the same tool call recover the same request.

Provide owner-authorized pending/detail/inventory endpoints and an explicit decision endpoint, for example `POST /api/data/access-requests/:id/decision` with `decision: approve|decline`, `expected_version`, and idempotency key. Both clients render the same card showing whose data, app/purpose, scope and setup destination. Scope changes require a new request. Approve/decline races resolve atomically; another user gets 404. Generic question skip, model output or app API keys cannot approve.

In one transaction, approve and create one grant/key record (unique request relationship). Denied/canceled requests create none. Bind continuation to the original invocation/tool call and persist the decision before waking execution. Disconnect/restart or approval in the other client cannot create duplicate keys or an unrelated turn.

## Key verification and handoff

Use high-entropy query credentials with a public identifier and verification hash. Never return the raw key in ordinary persisted tool results, model context, SSE, analytics, command input logs or transcript metadata. Return only key/grant identity and handoff status through normal serializers.

Implement the protected delivery/recovery contract selected in phase 0. The generated app stores the credential in its server environment outside Git/browser bundles; prove the automatic supported setup path with an example. Key creation and handoff are distinct durable states (`approved`, `handoff_pending`, `installed` or `setup_failed`). A service/daemon outage after issuance cannot trigger untracked reminting. If a transient raw-secret escrow is necessary, specify its protection, expiry and deletion; steady-state key storage remains verification-only. After unrecoverable secret loss, revoke the unusable key and require an explicit visible rotation/setup retry policy.

If a new daemon write-secret operation is required, capability-gate it, ensure no echo/terminal logging, record an idempotent receipt and document the old-daemon fallback. Never redact authoritative terminal output bytes in place: their absolute offsets are a protocol contract. Do not claim generic tool-result redaction protects a secret passed through the terminal.

## Query authorization and management

Dedicated key auth accepts only scoped query routes, resolves the approving owner and verifies the active key/grant on every read. Enforce fields, location precision, allowed history bounds and result limits server-side. Key inventory never reveals the secret after handoff; show label, scopes, creation/use/revocation status. Both mobile and web can revoke. Revocation blocks the next request and pending use through live grant checks; do not rely on long-lived positive auth caches.

Example acceptance app: private contact search/history with an evidence-labeled location map. Queries originate in its backend; browser responses contain permitted data, not credentials. Its existing private preview/owner access must remain enforced. A key represents the approving owner, so do not enable a shared dashboard that returns builder data to arbitrary visitors. Future broker resolves the actual dashboard viewer and their consent.

## Acceptance

- [ ] K-series request/decision/idempotency/restart/revoke tests pass, including approve in the opposite client.
- [ ] Agent setup completes after a durable approval; denial/cancel mints no credential.
- [ ] Raw key and any redeemable handoff secret are absent from all ordinary transcript/provider/SSE/terminal/log paths and generated frontend assets.
- [ ] Private example app queries allowed data, cannot exceed scope, and fails immediately after revoke.
- [ ] Mixed daemon compatibility and interrupted setup recovery are demonstrated for the chosen handoff.

Update auth/data/tool/runtime/DB specs, mobile/web permission and inventory specs, auth checklist and any new protocol/capability docs. Do not implement viewer-specific brokering or general webhooks in this phase.
