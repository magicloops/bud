# Google permissions and write approvals

Google access and Bud action approval are separate controls. Connecting a Google
service allows reading with the granted scopes. Every mutation additionally
requires a one-use approval of the exact action in the owning chat.

## Connecting and changing access

Settings → Connected apps lets the user choose supported services and either
**Read only** (Google-enforced scopes) or **Allow changes, ask first**. Calendar
ships in PR180; PR182 adds Gmail and Drive. Selected services share one account
and one OAuth request. Later additions use incremental consent. The callback
records actual granted scopes; denying one service does not fabricate its access.
Canceled upgrades preserve the prior usable account. OAuth never runs a write.
A read-only selection does not remove permissions previously granted to the same
Google project: incremental consent may retain them. To remove that upstream
write grant, revoke Bud in Google Account permissions before reconnecting. Bud
always reports the actual grant and applies Block changes independently.

After connection, **Block changes** is enforced by Bud without revoking Google's
write-capable grant. Switching back to **Ask before changes** needs no OAuth when
the grant still includes writes. A genuine read-only grant needs additional
Google consent before writing. Existing write grants default to asking first.
Disconnect clears the shared Google credentials for all connected services.

Set `GOOGLE_WRITES_ENABLED=false` in the service environment and restart to block
Google writes for all users. Only an absent value or the exact value `true`
enables writes. This administrative switch cannot be changed by model arguments
or browser requests. Reads remain available. It never bypasses approval.

## Approval and execution

The service validates a proposed write, checks scope/policy and saves its exact
arguments, Google account/grant identity, original operation key and ten-minute
expiry in the existing owned invocation action. The chat pauses and displays the
proposed action and account. Approve or Reject records a decision and wakes the
durable invocation. The worker does not remain leased while waiting.

An approved decision supplies a one-use `approval_id` to the resumed model.
`google_call` must supply that ID with the same connection, tool and arguments in
the same invocation. Arguments are compared canonically; changed content,
recipients, event fields, destination or file target needs a new approval.
The service reconstructs the request using the stored arguments and original
operation key, rechecks live ownership and lease, and consumes approval before
dispatch. Current Google scopes, account/grant, user policy and global switch are
checked at dispatch. Approval is not proof of completion. Rejection, expiry,
cancellation, changed connection or policy, and reused approval never execute.

Unknown network/write outcomes stop for review and never automatically retry.
Calendar retains ETag checks; Drive retains its documented version-preflight
limitations. Gmail draft sending includes the approved complete plain-text
message in the send request, replacing the draft's content; an external draft
edit cannot substitute different recipients/body after approval. Attachments
are not preserved by this operation, consistent with the plain-text tool limits.

## Browser API

All endpoints resolve the authenticated viewer before owner-filtered SQL. Foreign
connections/approvals/threads return 404, and anonymous requests return 401.
Cookie-authenticated mutations require a trusted Origin. Approval reads/decisions
also join the live owned thread and Bud. Neither credentials nor internal grant
identities enter browser/model payloads.

- `GET /api/google/connection`: `configured`, `writes_enabled`, `connections`.
  Each connection exposes `<service>_access` for read access,
  `<service>_write_access`, and `write_policy[service]` (`read_only` or
  `ask_before_write`), in addition to its ID, status, email and update time.
- `POST /api/google/connect`: `{ selections: [{ service, access }], thread_id? }`,
  where access is `read_only` or `read_write`; duplicate services are rejected.
  An omitted selection retains Calendar read/write as the default. This endpoint
  requires a browser session. The return thread and Bud are reauthorized before
  consent and on callback; arbitrary return URLs are forbidden.
- `PATCH /api/google/connection/:connection_id/policy`: `{ service, policy }`.
  Returns 204. Missing write scopes require explicit consent, not a silent upgrade.
- `GET /api/google/approvals/:approval_id`: `{ approval }`.
- `POST /api/google/approvals/:approval_id/decision`:
  `{ decision: "approved" | "rejected" }`, returning `{ approval }`.
  This records a decision; it is not an API to dispatch a model-supplied action.

Public approval fields are `approval_id`, `thread_id`, `service`, `tool_name`,
`arguments_json`, `account_email`, `status`, `created_at`, `expires_at` and optional
`decided_at`. Status is pending, approved, rejected, expired or consumed.
No action body can be changed in a decision request.

During a parked turn, the canonical pending `google_call` arguments include
`google_approval`. `/agent/state` includes `pending_google_approvals` for recovery.
After a decision, the persisted tool result carries `approval_request` and
`executed: false`; the subsequent approved call records the actual provider result.
Missing write scopes use `connect_request.write_required: true` so a read-only
connection can offer an explicit upgrade. Existing SSE envelopes stay unchanged.

## Deployment and validation

No new tables, migration or daemon version. Deploy matching service/web builds
after Calendar migration `0067_google_connections.sql`, draining old workers.
PR182 builds on the updated PR180. Register optional read-only scopes in the
Google Cloud project alongside existing scopes: `calendar.events.readonly`,
`gmail.readonly` and `drive.readonly` as their services become available. Existing
Calendar list/freebusy scopes are retained. No broader scope is added for future
features. Full Drive scope remains necessary for the current whole-Drive edits;
`drive.file` would require a separate file-selection product change.

Mobile clients must render these approvals or direct the owner to the web;
unsupported clients cannot bypass them. Automated validation uses synthetic
Google calls and isolated PostgreSQL schemas, never real mail or file mutations.
See the [implementation plan](../plan/google-write-approvals.md) and
[validation notes](../debug/google-write-approvals.md).
