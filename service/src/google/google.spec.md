# google

Direct Google OAuth and Calendar API access. Calendar is the first implementation;
Gmail and Drive are planned subsequent services on the same connection.

`config.ts` defines the existing Google client credentials, Bud callback, Calendar
scopes and sanitized errors. `credentials.ts` encrypts tokens/PKCE using AES-GCM
bound to owner, connection and OAuth client. `oauth.ts` uses google-auth-library
for PKCE, code exchange and refresh, plus an authenticated Google userinfo lookup.
`http.ts` restricts destinations, redirects, timeouts and response size; writes
never automatically retry. The service never forwards credentials to the model.
Known `SERVICE_DISABLED`/`accessNotConfigured` HTTP 403 reasons become
`google_api_disabled` with static Calendar API setup guidance. Raw error bodies
remain private; malformed bodies retain the HTTP rejection status.

`connections.ts` owns one row per user in google_connection (0067): hashed
single-use state bound to browser session, 10-minute flow expiry, owner-filtered
SQL, encrypted credentials and account identity. Row locks serialize refresh,
calls and disconnect; 4 active operations/process, 5s lock timeout and 45s signal.
Disconnect clears local credentials without revoking the shared Google OAuth
client's grant. Production keys persist across deploys and match across replicas.
An optional return thread is encrypted with the PKCE verifier. Valid callbacks
consume both; GoogleCallbackError retains return context only after state/session
validation so consent cancellation and partial consent can return to chat.

`calendar.ts` defines seven reviewed operations with Zod input validation and
model-visible JSON schemas: list calendars/events, get/create/update/delete events
and free/busy. Dates require explicit offsets or valid all-day dates. Paging is
bounded to 25 results; nextPageToken stays visible. Updates/deletes require the
last-read etag (If-Match). Creation uses a deterministic action-specific event ID.
Only requested fields are patched; attendee arrays replace the entire list.

`agent-tools.ts` exposes google_search_tools/google_call; `agent-executor.ts`
checks thread/Bud ownership and human durable-invocation authority before dispatch
and returning evidence. Existing action intents fence uncertain writes, which
halt for needs-review; definite 4xx rejection is a normal error. No automatic
write retries or automation access. Read/write results are bounded to 32 KiB.
Disconnected discovery and reconnect/permission failures include a canonical
`connect_request { provider: google_calendar, thread_id }`. The thread ID comes
from the authorized invocation; no consent URL, state or token enters evidence.
The model asks the user to connect in chat and continue with a new message.

`routes.ts` mounts owned inventory, cookie-origin-checked connect/disconnect and
same-session callbacks. Tokens never enter browser state; inventory includes only
email, status, Calendar read/write grants, policy, connection ID and timestamp.
Connect accepts an optional `thread_id`, authorizes both thread and Bud before
starting consent, then reauthorizes on callback. The service derives the return
path from those owned IDs on its configured origin; arbitrary return URLs are
rejected. Settings-origin flows continue returning to Settings. No extra migration.

`test-fixture.ts` is a synthetic Google OAuth/Calendar transport used by
calendar.test.ts, connections.test.ts and agent.test.ts. The real Google SDK is
used for fixture exchange/refresh; DB tests use an isolated PostgreSQL schema.

Dependency: google-auth-library 10.9.1 (compatible with Bud's Node 20 baseline).
Service typecheck/web build and 45 focused Google/chat/projection tests pass,
including isolated PostgreSQL callback and encrypted return-context recovery.
The user confirmed real Calendar listing after enabling the API, with a Calendar
email different from their Bud login. Real event mutation acceptance remains pending.
See [setup](../../../docs/google-calendar.md) and [plan](../../../plan/google-direct-oauth.md).

## Consent and enforced write approval

`config.ts` defines true read-only and read/write scope sets. `oauth.ts` requests
selected capabilities together with incremental consent. `connections.ts` preserves
prior usable grants on canceled upgrades, stores actual granted scopes, and keeps
per-service policies and a rotating grant identity in encrypted credentials.
Inventory separates read access, write scope and Bud write policy. Policy changes
and disconnect invalidate outstanding approval identities.

`approvals.ts` owns exact, expiring, single-use approvals in existing invocation
action evidence; owner-scoped lookups join invocation/thread/Bud. It exposes a
public projection without internal account/grant identities. `approvals.test.ts`
covers owner, decision, expiry, exact-action and single-use boundaries with isolated
PostgreSQL. No new table or migration.

The executor proposes writes without dispatch. The durable agent parks, displays
the approval and resumes after approve/reject/expiry. Approved calls must supply
`approval_id` with unchanged arguments in the same invocation; execution uses the
stored operation key. Scope, account/grant, per-service policy and global
`GOOGLE_WRITES_ENABLED` are checked before dispatch. Every write requires approval;
a model assertion never substitutes for an owner decision.

Routes add selected consent, owned policy changes and approval reads/decisions.
See [API and rollout](../../../docs/google-write-approvals.md),
[plan](../../../plan/google-write-approvals.md) and
[validation](../../../debug/google-write-approvals.md).
