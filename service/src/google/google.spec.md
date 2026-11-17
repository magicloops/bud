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
  userinfo identity, exchange/refresh without automatic retries. Add account opens the Google chooser. Targeted consent
  hints the saved email and checks the returned Google subject. Temporary refresh
  failures return a retryable error and preserve the grant; a missing/rejected
  refresh grant requires reconnecting.
- `http.ts`: fixed Google OAuth/Calendar/Gmail users/me/Drive destinations; no
  redirects or retries, 20s network timeout, 64 KiB request and 1 MiB response caps.
  Binary multipart bodies retain exact bytes. Text responses expose at most
  24,000 bytes with truncation; binary MIME types are rejected as text. Provider
  error messages remain private; known disabled-API reasons get static guidance.
- `connections.ts`: one verified Google connection per owner and Google subject (migration 0072),
  owner-filtered SQL, session-bound single-use state, 10-minute consent expiry,
  45s provider operation deadline and four admitted provider operations per owner/process.
  A new chooser starts on an owned temporary row. Inventory includes only verified identities.
  Choosing an existing identity with sufficient permissions reuses its connection.
  Additional consent for an existing identity runs through its targeted upgrade or reconnect flow.
  OAuth exchange, token refresh, API requests and invocation checkpoints run
  without a checked-out SQL client. The grant epoch identifies consent changes
  across replicas, and the final dispatch check also reads current scopes.
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
  services usable. Revoking the last service or removing an account deletes that account row.
  Both service revoke and account removal cancel unfinished Add choosers for this owner.
  These operations do not revoke the upstream Google grant shared with sign-in.
  Unreadable credentials remain visible as reconnect-required inventory with no
  effective access and `recovery_required:true`. Explicit reconnect or revocation
  clears unusable credentials in a short edit. Targeted reconnect retains the verified
  subject, including after a key or client change. Account removal needs no key.
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
  already-stale edits and supplies the existing media type for a content replacement when the caller omits it. A shared file reservation protects overlapping Bud writes. Changes from external Drive clients can still race the update.
- `agent-tools.ts`: google_search_tools(service, access, query, connection_id?, add_account?) and google_call discovery/
  execution. Omitted and null discovery arguments default to Calendar and read-only access.
- `agent-executor.ts`: reviewed catalog, service grant gating, human invocation
  lease plus live thread/Bud ownership checks before dispatch/preflight/evidence.
  Discovery lists addresses when account choice is ambiguous and supports explicit
  account addition. Calls target a connection ID and successful results carry its ID and email.
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
  same-session callbacks. Connect accepts service/access selections, optional owned connection_id and thread_id;
  callback reauthorizes the thread/Bud and builds its return path on the configured
  origin. Caller-supplied return URLs are rejected. Account mismatch has explicit
  callback status. Successful callbacks and duplicate Add attempts that need more
  access return the verified, owner-scoped connection ID. Invalid state falls back to Settings.

## Chat contract

Canonical Google evidence can carry `connect_request` with provider
`google_calendar`, `google_gmail` or `google_drive`, server-stamped thread_id, and
`access:read_only|read_write` matching the task. Consent can target an owned connection ID
or explicitly request Add account. Settings Connect requests full access.
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
service in Bud. It is one short edit that raises `grant_epoch` and never waits
for callback, refresh or API work; that work stops at its next request (see
Concurrency). There is no per-action approval layer or global
write-policy switch; user-request and uncertain-outcome handling remain unchanged.

## Concurrency

Design: [options](../../../design/google-connection-concurrency.md),
[plan](../../../plan/google-connection-concurrency.md). Calls for one account run
together, up to four per owner per process.

- Account credential edits use `FOR UPDATE NOWAIT`. A locked row is retried for
  two seconds with the pool client released between attempts. Account additions
  and removals take a short owner-scoped advisory lock when changing membership.
  An Add attempt sweeps its owner's expired temporary rows with `SKIP LOCKED`.
  A revoke cancels that owner's unfinished choosers before committing. All network
  operations run outside these locks.
- A Drive edit reads the file metadata with the caller's Google token. Before
  sending the mutation, Bud claims the file in `google_drive_write_lease` using
  a hash of the file ID. A competing claim or a write that finished after the
  metadata read began invalidates that read. An uncertain provider result keeps
  its reservation until expiry. No SQL transaction spans a Google request.
- `grant_epoch` rises when authorization changes: a completed grant, a service
  revoke, a disconnect, a move to `reconnect_required`, cleared unreadable
  credentials, or a changed OAuth client. A token refresh does not raise it.
- A call reads the row without a lock and remembers the epoch. Before each
  preflight and dispatch, after the invocation and ownership checks, it compares
  the epoch and rechecks Google's latest granted scopes. A refresh that narrows
  access while a write is waiting prevents dispatch. An epoch change returns a
  missing-access error or retryable `google_connection_changed`.
- Calls on the same connection and grant epoch share a refresh in one process.
  A new grant starts a separate attempt. Across instances, the one that sets
  `refresh_lease_until` (30 s on the database's clock, longer than a refresh can
  take) asks Google and clears it when done or failed; the others poll every
  250 ms for its tokens, or carry on with a token that still has five seconds
  left. A lease left by an instance that died ends by itself, and an instance that
  stalled past its lease finds on saving that it no longer holds it and keeps the
  other instance's tokens. The same holds for a failure: a refresh error, including
  `invalid_grant`, only counts while the instance still holds the lease for the
  same grant epoch. If the
  lease can't be read after a failure, the call fails as retryable `google_busy`
  and nothing is concluded about the grant. A cancelled or timed-out call stops waiting for a
  shared refresh, which carries on for the others. The result is saved
  onto the current row only if the epoch is unchanged, so it cannot undo a
  disconnect or drop a pending connect flow. This lease covers the token request
  only.
- The OAuth callback consumes its state in one edit, exchanges the code outside any
  transaction, and applies the grant in a second edit only if the epoch is
  unchanged. A newer connect flow that began meanwhile stays pending and falls
  back to that grant. When targeted consent returns no new refresh token and a
  refresh is already rotating the saved one, the callback waits outside the
  transaction for the rotated token. Each attempt checks the grant epoch again.
  The authorization code is exchanged once.
- A call or exchange is cut off after 45 seconds (`google_operation_timed_out`,
  retryable; a write whose outcome is uncertain is reported as unknown).

## Validation and rollout

`test-fixture.ts` supplies synthetic Google transport for actual SDK exchange/
refresh. `calendar.test.ts`, `services.test.ts`, `connections.test.ts` and
`agent.test.ts` cover MIME/content boundaries, scoped discovery, callback/account
binding, canceled/partial incremental consent, refresh-token reuse, owner/Origin
checks, version preflight, disconnect races and uncertain writes. DB tests use an
isolated local PostgreSQL schema. Task-specific access, partial upgrades, service
revocation and stale OAuth callbacks have dedicated regressions. Two real accounts granted read-only access on localhost. Gmail, Calendar and Drive
returned the expected identity for each account. Writes were tested with synthetic
Google responses. See the [multi-account validation](../../../debug/multiple-google-accounts-validation.md).
`config.test.ts` covers optional-integration startup with unusable callback URLs
and consent-time URL validation. Recovery regressions cover key changes, missing
old scopes, repeated temporary refresh errors, cross-owner concurrency and large
Gmail threads. See [recovery plan](../../../plan/google-service-recovery.md).

Apply `0070_google_connections.sql`, `0071_google_drive_write_lease.sql`
and `0072_multiple_google_accounts.sql` before deploying matching service/web builds.
Migration 0072 preserves connection IDs, credentials and both kinds of leases.
Keep the stable encryption key across replicas/restarts.
The Google project owner must enable Gmail/Drive APIs and register the added
restricted scopes; each task card requests the selected service and access level. Public verification/security
assessment is separate from test-user setup.
See [setup/limits](../../../docs/google-services.md),
[Calendar setup](../../../docs/google-calendar.md), and
[task-access plan](../../../plan/google-task-access.md).
