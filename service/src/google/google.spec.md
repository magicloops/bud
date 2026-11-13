# google

Direct Google OAuth and Calendar/Gmail/Drive tools for owner-scoped human chats.

## Files and responsibilities

- `config.ts`: existing Google credentials/callback, per-service scopes and
  sanitized errors. Calendar retains its narrow scopes; Gmail and Drive have read-only and full
  capability sets. Full Drive uses drive to reach existing files.
- `credentials.ts`: AES-256-GCM token/PKCE encryption, bound to owner/row/client.
  Pending flow data includes requested service/access selections, previous connection
  status and optional return thread. Effective per-service access is encrypted too. Credentials never enter browser/model evidence.
- `oauth.ts`: google-auth-library PKCE, offline incremental consent, verified
  userinfo identity, exchange/refresh without automatic retries. An identity hint
  keeps all connected services on the same Google account.
- `http.ts`: fixed Google OAuth/Calendar/Gmail users/me/Drive destinations; no
  redirects or retries, 20s network timeout, 64 KiB request and 1 MiB response caps.
  Binary multipart bodies retain exact bytes. Text responses expose at most
  24,000 bytes with truncation; binary MIME types are rejected as text. Provider
  error messages remain private; known disabled-API reasons get static guidance.
- `connections.ts`: one google_connection row per Bud user (migration 0069),
  owner-filtered SQL, session-bound single-use state, 10-minute consent expiry,
  5s lock timeout, 45s call signal and four active locked operations/process.
  Serialized refresh/API calls/disconnect prevent credential resurrection.
  Incremental consent preserves previous grants until successful same-subject
  exchange; canceled/partial/wrong-account consent cannot overwrite them. An
  omitted new refresh token can reuse the existing one only for that same subject.
  Inventory reflects the previous usable status while new consent is pending.
  Each call intersects actual Google scopes with the stored service access.
  A read-only selection cannot write even if Google returns a combined broader grant. Drive edits preflight current version and
  reject native-file content replacement; this is not atomic against other clients.
  Service revoke stores `none`, cancels pending OAuth state, and leaves other
  services usable. The last service revoke and account disconnect clear credentials.
  These operations do not revoke the upstream Google grant shared with sign-in.
- `tool-contracts.ts`: shared reviewed request/tool definitions, response transforms
  and model schema helpers. Request paths/headers/preflights are service-owned.
- `calendar.ts`: seven operations: calendars/events list, event get/create/update/
  delete and free/busy. Bounded pagination, explicit time zones/all-day dates,
  etag If-Match updates/deletes and deterministic per-action event creation ID.
  IDs reject literal URL dot segments so normalization cannot escape reviewed paths.
- `gmail.ts`: message search/get, thread read, drafts CRUD/send, new mail/replies,
  user labels and message labels/trash/restore. Server-built plain-text MIME rejects
  header/sender injection, folds Unicode subjects/recipient headers, validates
  threading headers and uses a deterministic Message-ID (not an idempotency key).
  Read transforms decode text and expose attachment metadata without binary dumps.
  Sending/downloading attachments is not implemented; replacing a draft replaces
  the full message. No permanent message deletion or settings/delegation tools.
- `drive.ts`: existing-file search/metadata/text/export, folder creation, small
  multipart upload/import, uploaded-content/metadata update, copy/move/trash/restore.
  Decoded uploads cap at 24,000 bytes; Docs/Slides export plain text, Sheets CSV
  exports the first sheet only. No native-document content edits, PDF/image parsing,
  large transfers, sharing changes or permanent deletion. Version preflight catches
  already-stale edits but cannot eliminate a change between read and write.
- `agent-tools.ts`: google_search_tools(service, access, query) and google_call discovery/
  execution. Omitted service remains Calendar for existing callers/history.
- `agent-executor.ts`: reviewed catalog, service grant gating, human invocation
  lease plus live thread/Bud ownership checks before dispatch/preflight/evidence.
  Unknown write outcomes halt for needs-review; definite 4xx rejections return an
  ordinary non-retryable error. Readable results cap at 32 KiB. Content is untrusted
  data in the owned transcript/model, not authority for additional actions.
- `routes.ts`: owned inventory, cookie-Origin checked connect/disconnect, and
  same-session callbacks. Connect accepts service/access selections and optional owned thread_id;
  callback reauthorizes the thread/Bud and builds its return path on the configured
  origin. Caller-supplied return URLs are rejected. Account mismatch has explicit
  callback status; invalid state falls back to Settings.

## Chat contract

Canonical Google evidence can carry `connect_request` with provider
`google_calendar`, `google_gmail` or `google_drive`, server-stamped thread_id, and
`access:read_only|read_write` matching the task. Settings Connect requests full access.
No OAuth URL/state/token enters evidence. The web card starts explicit consent;
users return to the originating chat and send a new message to continue. No write
is resumed or replayed automatically. Existing opaque tool_payload/SSE envelopes
are unchanged. Inventory exposes effective `access[service]` (`none|read_only|read_write`),
read/write booleans, email, status, connection ID and timestamp. Credentials and
internal Google subjects never enter model inputs.

`DELETE /api/google/connection/:connection_id/services/:service` revokes that
service in Bud. The normal owner-filtered connection lock serializes revocation
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

Deploy matching service/web builds after migration `0069_google_connections.sql`, generated after main
migrations 0067/0068. No daemon upgrade is needed. Keep the stable encryption key across replicas/restarts.
The Google project owner must enable Gmail/Drive APIs and register the added
restricted scopes; each task card requests the selected service and access level. Public verification/security
assessment is separate from test-user setup.
See [setup/limits](../../../docs/google-services.md),
[Calendar setup](../../../docs/google-calendar.md), and
[task-access plan](../../../plan/google-task-access.md).
