# Direct Google Calendar access

Bud calls Google Calendar directly using Google OAuth. The existing service
GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are reused. Calendar is implemented;
Gmail, then Drive, are the next phases. Each will add its own tools and consent
scopes. No MCP server, bucket, or additional hosted service is required.

## Google Cloud setup

In the existing Google Cloud project, enable Google Calendar API. Open Google Auth
Platform → Clients → the Web application matching GOOGLE_CLIENT_ID. Add this
authorized redirect URI for local testing:

```
http://localhost:5173/api/google/callback
```

Keep the separate Bud login callback registered as well:
`http://localhost:5173/api/auth/callback/google`. The old MCP port-8000 callback
is no longer used. For external apps in Testing, add your Google email to Audience
→ Test users. Under Data Access register the scopes requested by this version:

- openid, email, profile (Google account identity)
- https://www.googleapis.com/auth/calendar.calendarlist.readonly
- https://www.googleapis.com/auth/calendar.events
- https://www.googleapis.com/auth/calendar.events.readonly (optional genuine read-only access)
- https://www.googleapis.com/auth/calendar.events.freebusy

Google login and Calendar consent are separate flows. A user may choose a Google
account different from the login account; Bud displays the connected Calendar
email. One Calendar account per Bud user is supported.

Official references: [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[conditional event changes](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Service configuration

Apply generated migration `0067_google_connections.sql` before enabling the
matching service/web build. It follows the latest main migration chain and adds
only the owned Google connection table. Its SQL matches the previously applied
local Calendar migration; do not replay CREATE TABLE against that local database.
Existing file-upload tables were preserved. See [debug note](../debug/google-direct-oauth.md).

```
GOOGLE_CLIENT_ID=<existing client id>
GOOGLE_CLIENT_SECRET=<existing client secret>
GOOGLE_REDIRECT_URI=http://localhost:5173/api/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=<stable 32 random bytes in base64>
APP_BASE_URL=http://localhost:5173
BETTER_AUTH_URL=http://localhost:5173
```

The local encryption key is already generated in the ignored service/.env file;
do not regenerate it on restart. In production use the service secret manager,
HTTPS URLs, and the same key on all replicas. Changing/loss of the encryption key
requires reconnecting accounts. No online key-rotation mechanism is implemented.
The callback origin must be included in BETTER_AUTH_TRUSTED_ORIGINS.

### Hosted configuration — 2026-11-12

Render's `bud-service` already has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
GOOGLE_REDIRECT_URI is saved as `https://app.bud.dev/api/google/callback`, and a
new stable 32-byte base64 GOOGLE_TOKEN_ENCRYPTION_KEY is stored in Render's
environment. These were saved without deployment; no secret values are in Git.
The current hosted environment is used for staging, with the same Google Cloud
OAuth project as local development. Its owner must confirm that the hosted
callback is registered on the matching OAuth client. Keep the existing sign-in
callback `/api/auth/callback/google` as well. Calendar API enablement and consent
configuration are shared within that project. Testing mode is sufficient for
approved test users; its Calendar refresh tokens generally expire after seven days.

Render's pre-deploy command already runs `pnpm db:migrate`. Release the matching
service and web builds together; this integration requires no daemon upgrade.
Hosted Calendar consent and event mutations still need acceptance testing after
deployment. Public release/Google verification is separate from staging setup.

From separate terminals, run `pnpm dev` from service/ and web/. If the local pnpm
wrapper stops on its install-script policy, use installed package-local tools:

```bash
cd /Users/sp/Documents/bud/service
node --import tsx src/server.ts
```

```bash
cd /Users/sp/Documents/bud/web
node node_modules/vite/bin/vite.js --host localhost --port 5173 --strictPort
```

## Connect and test

Ask Bud “What is on my calendar tomorrow?” in chat. If Calendar is not connected,
the reply includes **Connect Google Calendar**. Click it, complete Google consent,
and return to the same conversation. Send “Continue” to have Bud retry the request.
Expired/revoked access offers Reconnect in chat. The card stays visible after the
reply finishes and after reloading. Consent never automatically replays an event write.

Settings → Connected apps remains available to connect or manage/disconnect an
account. Since an already-connected account does not need a card, use a disconnected
test account to test the chat flow. If Google reports redirect_uri_mismatch, the
exact callback above has not been registered on the configured client. Missing
Calendar permissions produce a reconnect prompt; disabled API or account policy
errors remain explicit API errors rather than empty schedules.
For `google_api_disabled`, enable Google Calendar API under APIs & Services in the
OAuth client's project. Account reconnection does not enable an API. Different
Bud login and Calendar emails are supported; in Testing, the connected Google
account must be on the project's test-user list.

1. Ask “List my calendars and their time zones.”
2. Ask “Show my next five events tomorrow in America/Los_Angeles.” Verify times
   and calendar IDs against Google Calendar.
3. Ask “Create Bud test tomorrow at 3 PM Pacific for 15 minutes, with no guests.”
   Verify exactly one event. Ask to move it to 4 PM, then delete it. Each update
   or deletion first reads the event's latest etag.
4. Restart the service and repeat a read; tokens must refresh without reconnection.
5. On a test account, disconnect and repeat a read; a Connect card should appear
   and no Calendar API call should occur. Cancel consent once to check the return
   and retry, then complete it and send “Continue.”

Bud stores tokens encrypted in its existing PostgreSQL database. Tool results
enter the selected model and normal owned-chat transcript. Disconnect deletes
Bud's Calendar token copy; Google Account permissions can revoke the upstream
grant separately (the OAuth client is shared with Bud sign-in).

Unknown write outcomes pause the run for review. Verify Google Calendar before
retrying. The API does not automatically resend mutations. These tools work in
human chats, including while the device daemon is offline; scheduled automations
do not gain Calendar access automatically.

## Validation

45 focused Google/chat/projection tests pass, including real SDK code
exchange/refresh against a synthetic transport, isolated PostgreSQL callback tests,
and mounted chat interaction/account-switch tests.
Service compilation and web production build pass. The local signed-in Settings
page shows the configured Calendar card and Connect button; service readiness is
healthy and anonymous connection reads return 401 through Vite. Real Google consent
succeeded using a different Calendar account from the Bud login. The user enabled
Calendar API and confirmed listing works. A disposable Chrome fixture verified the
inline card; real disconnected-account chat consent and event writes remain user
acceptance checks. Hosted environment values are saved; the feature is not deployed.

## Chat connection contract

Google discovery/call results may carry `connect_request` with
`{ "provider": "google_calendar", "thread_id": "<owned thread>" }` in the existing
opaque `tool_payload`. It contains no OAuth URL, state or credential. Only the
service generates it after human invocation/thread/Bud authorization. Missing or
revoked grants offer consent; disabled APIs and foreign resources do not.

The browser starts consent with `POST /api/google/connect` and optional JSON
`{ "thread_id": "<owned thread>" }`, using the signed-in cookie and trusted Origin.
The service authorizes thread and Bud, saves the return thread inside encrypted
PKCE flow data, and returns `authorization_url`. Callback consumes validated
session-bound state, reauthorizes the saved thread and redirects to its same-origin
`/<bud_id>/<thread_id>?google=connected|failed|permissions_required` path. Invalid
state or unavailable destinations fall back to Settings; callers cannot supply a
return URL. Settings calls omit thread_id. No new DB schema or daemon version is
needed for chat consent; deploy matching service/web builds together.

## Approval and policy update

Every event write now requires an exact in-chat approval. OAuth consent alone
never authorizes a mutation. See [Google permissions and write approvals](./google-write-approvals.md)
for selected consent, per-service Block changes, the global service switch, API
contracts and coordinated rollout.
