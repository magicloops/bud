# google

Direct Google OAuth and Calendar/Gmail/Drive tools for owner-scoped human chats.

## Files and responsibilities

- `config.ts`: existing Google credentials/callback, per-service scopes and
  sanitized errors. Calendar retains its narrow scopes; Gmail and Drive have read-only and full
  capability sets. Full Drive uses drive to reach existing files. Invalid callback
  configuration disables new Google connections without preventing service startup;
  HTTPS/loopback validation runs before consent starts.
- `credentials.ts`: AES-256-GCM token/PKCE encryption, bound to owner/row/client.
  Pending flow data includes requested service/access selections, previous connection
  status and optional return thread. Effective per-service access is encrypted too. Credentials never enter browser/model evidence.
- `oauth.ts`: google-auth-library PKCE, offline incremental consent, verified
  userinfo identity, exchange/refresh without automatic retries. An identity hint
  keeps all connected services on the same Google account. Temporary refresh
  failures return a retryable error and preserve the grant; a missing/rejected
  refresh grant requires reconnecting.
- `http.ts`: fixed Google OAuth/Calendar/Gmail users/me/Drive destinations; no
  redirects or retries, 20s network timeout, 64 KiB request and 1 MiB response caps.
  Binary multipart bodies retain exact bytes. Text responses expose at most
  24,000 bytes with truncation; binary MIME types are rejected as text. Provider
  error messages remain private; known disabled-API reasons get static guidance.
- `connections.ts`: one google_connection row per Bud user (migration 0070),
  owner-filtered SQL, session-bound single-use state, 10-minute consent expiry,
  45s provider operation deadline and four admitted provider operations per owner/process.
  Short SQL transactions claim a time-limited operation in the encrypted envelope.
  Competing calls wait outside the database pool. OAuth exchange, refresh, Google
  requests and invocation checkpoints run without a checked-out SQL client.
  Before dispatch and when saving results, the encrypted envelope identifies the
  current owner of the operation across replicas. A stale completion cannot
  restore a disconnected or replaced grant.
  Incremental consent preserves previous grants until successful same-subject
  exchange with at least one selected service granted; canceled/denied/wrong-account
  consent cannot overwrite them. A replacement grant can omit revoked old scopes;
  stored service access is capped to the new grant without reviving local revokes. An
  omitted new refresh token can reuse the existing one only for that same subject.
  Inventory reflects the previous usable status while new consent is pending.
  Each call intersects actual Google scopes with the stored service access.
  A read-only selection cannot write even if Google returns a combined broader grant. Drive edits preflight current version and
  reject native-file content replacement; this is not atomic against other clients.
  Service revoke stores `none`, cancels pending OAuth state, and leaves other
  services usable. The last service revoke and account disconnect clear credentials.
  These operations do not revoke the upstream Google grant shared with sign-in.
  Unreadable credentials remain visible as reconnect-required inventory with no
  effective access and `recovery_required:true`. Explicit reconnect or revocation
  clears unusable credentials under the owner lock; account disconnect needs no key.
- `tool-contracts.ts`: shared reviewed request/tool definitions, response transforms
  and model schema helpers. Request paths/headers/preflights are service-owned.
- `calendar.ts`: seven operations: calendars/events list, event get/create/update/
  delete and free/busy. Bounded pagination, explicit time zones/all-day dates,
  etag If-Match updates/deletes and deterministic per-action event creation ID.
  Time patches explicitly clear the alternate date or timestamp field when switching event type.
  IDs reject literal URL dot segments so normalization cannot escape reviewed paths.
- `gmail.ts`: message search/get, thread read, drafts CRUD/send, new mail/replies,
  user labels and message labels/trash/restore. Server-built plain-text MIME rejects
  header/sender injection, folds Unicode subjects/recipient headers, validates
  threading headers and uses a deterministic Message-ID (not an idempotency key).
  Read transforms decode text and expose attachment metadata without binary dumps.
  Large threads retain recent messages within one structured result budget, with
  explicit body/message omissions and bounded IDs for individual-message reads.
  Sending/downloading attachments is not implemented; replacing a draft replaces
  the full message. No permanent message deletion or settings/delegation tools.
- `drive.ts`: existing-file search/metadata/text/export, folder creation, small
  multipart upload/import, uploaded-content/metadata update, copy/move/trash/restore.
  Decoded uploads cap at 24,000 bytes; Docs/Slides export plain text, Sheets CSV
  exports the first sheet only. No native-document content edits, PDF/image parsing,
  large transfers, sharing changes or permanent deletion. Version preflight catches
  already-stale edits and supplies the existing media type for a content replacement when the caller omits it. It cannot eliminate a change between read and write.
- `agent-tools.ts`: google_search_tools(service, access, query) and google_call discovery/
  execution. Omitted and null discovery arguments default to Calendar and read-only access.
- `agent-executor.ts`: reviewed catalog, service grant gating, human invocation
  lease plus live thread/Bud ownership checks before dispatch/preflight/evidence.
  Unknown write outcomes halt for needs-review; definite 4xx rejections return an
  ordinary error. Rate limits and temporary server errors are retryable on reads. Readable results cap at 32 KiB. Content is untrusted
  data in the owned transcript/model, not authority for additional actions.
  Transient refresh failures are retryable without a consent card; no write has
  dispatched at that point. Bounded Gmail results serialize intact as valid JSON;
  other oversized results use a labeled JSON preview instead of cutting JSON mid-value.
  Validation returns bounded field paths and explanations. The write flag is set
  at the actual fetch call. An explicit API 401 clears the flag, refreshes the
  token and retries once with current scopes and preconditions. A second 401 or
  invalid refresh grant requires consent. Calendar conditional updates have an
  event-specific 412 error, with generic precondition errors elsewhere.
- `routes.ts`: owned inventory, cookie-Origin checked connect/disconnect, and
  same-session callbacks. Connect accepts service/access selections and optional owned thread_id;
  callback reauthorizes the thread/Bud and builds its return path on the configured
  origin. Caller-supplied return URLs are rejected. Account mismatch has explicit
  callback status; invalid state falls back to Settings.

## Chat contract

Canonical Google evidence can carry `connect_request` with provider
`google_calendar`, `google_gmail` or `google_drive`, server-stamped thread_id, and
`access:read_only|read_write` matching the task. Settings Connect requests full access.
When a client has no consent card, the model supplies the configured web URL of
the same authorized chat. On mobile the user grants the exact requested scope in
their signed-in browser and can continue from their original device.
No OAuth URL/state/token enters evidence. The web card starts explicit consent;
users return to the originating chat and send a new message to continue. No write
is resumed or replayed automatically. Existing opaque tool_payload/SSE envelopes
are unchanged. Inventory exposes effective `access[service]` (`none|read_only|read_write`),
read/write booleans, email, status, connection ID and timestamp. Credentials and
internal Google subjects never enter model inputs.
An optional `recovery_required:true` marks unreadable saved credentials. Settings
offers direct reconnect or **Clear saved connection** via the existing account DELETE.

`DELETE /api/google/connection/:connection_id/services/:service` revokes that
service in Bud. The owner-scoped operation lease serializes revocation
with callback/refresh/API work. There is no per-action approval layer or global
write-policy switch; user-request and uncertain-outcome handling remain unchanged.

## Validation and rollout

`test-fixture.ts` supplies synthetic Google transport for actual SDK exchange/
refresh. `calendar.test.ts`, `services.test.ts`, `connections.test.ts` and
`agent.test.ts` cover MIME/content boundaries, scoped discovery, callback/account
binding, canceled/partial incremental consent, refresh-token reuse, owner/Origin
checks, version preflight, disconnect races and uncertain writes. DB tests use an
isolated local PostgreSQL schema. Task-specific access, partial upgrades, service
revocation and stale OAuth callbacks have dedicated regressions. No real Gmail send or Drive
mutation was used. Real Gmail/Drive consent and write acceptance remain pending.
`config.test.ts` covers optional-integration startup with unusable callback URLs
and consent-time URL validation. Recovery regressions cover key changes, missing
old scopes, repeated temporary refresh errors, cross-owner concurrency and large
Gmail threads. See [recovery plan](../../../plan/google-service-recovery.md).

Deploy matching service/web builds after `0070_google_connections.sql`, generated from main’s
`0069_motionless_reaper` snapshot. Keep the stable encryption key across replicas/restarts.
The Google project owner must enable Gmail/Drive APIs and register the added
restricted scopes; each task card requests the selected service and access level. Public verification/security
assessment is separate from test-user setup.
See [setup/limits](../../../docs/google-services.md),
[Calendar setup](../../../docs/google-calendar.md), and
[task-access plan](../../../plan/google-task-access.md).
