# Direct Google Calendar access

Bud calls Google Calendar directly using Google OAuth. The existing service
GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are reused. Calendar, Gmail and Drive
have separate tools and incremental consent; see [Gmail/Drive setup](./google-services.md).
No MCP server, bucket, or additional hosted service is required.

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
email. One Google account per Bud user is shared across connected services.

Official references: [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[conditional event changes](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Service configuration

Apply generated migration `0069_google_connections.sql` before enabling the
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

From the checkout containing this PR, start two terminals:

```bash
cd service
pnpm dev
```

```bash
cd web
pnpm exec vite --host localhost --port 5173 --strictPort
```

Open `http://localhost:5173`. If using a worktree without its own `service/.env`,
set `DOTENV_CONFIG_PATH` to your existing local service `.env` before starting
the service. Stop an older Vite process on port 5173 before starting this checkout.
The Google callback must keep that exact registered port. The service defaults to
port 3000 and Vite proxies its API there.

## Connect and test

Ask Bud “What is on my calendar tomorrow?” in chat. If Calendar is not connected,
the reply includes a card requesting **Read Google Calendar**. Click it, complete Google consent,
and return to the same conversation. Send “Continue” to have Bud retry the request.
Expired/revoked access offers Reconnect in chat. The card stays visible after the
reply finishes and after reloading. Consent never automatically replays an event write.

A write task requests full Calendar access if the existing access is read-only.
Settings → Connected apps requests full access when connecting and lets the user
revoke Calendar separately. Revoke all connected services to switch the shared Google account. Since an already-connected account does not need a card, use a disconnected
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
5. In Settings, revoke Calendar and repeat a read; a Connect card should appear
   and no Calendar API call should occur. Cancel consent once to check the return
   and retry, then complete it and send “Continue.”

Bud stores tokens and selected service access encrypted in PostgreSQL. Tool results
enter the selected model and normal owned-chat transcript. Revoking Calendar stops
Calendar use in Bud and cancels pending consent without disabling Gmail or Drive.
Revoking the last service removes Bud's saved credentials.
Google Account permissions can revoke the upstream grant separately; the OAuth
client is shared with Bud sign-in.

Unknown write outcomes pause the run for review. Verify Google Calendar before
retrying. The API does not automatically resend mutations. These tools work in
human chats, including while the device daemon is offline; scheduled automations
do not gain Calendar access automatically.

## Validation

Synthetic Google transport, isolated PostgreSQL and mounted web tests cover
OAuth state/session ownership, read/full access, task cards, partial upgrades,
service revocation, callbacks and unknown write outcomes. No automated fixture
sends real mail or changes real Calendar/Drive data. See the
[validation note](../debug/google-task-access.md) for current commands/results.
Real Calendar listing was confirmed previously; real task-consent upgrades and
write acceptance remain manual checks before release.

## Chat connection contract

Google tool results carry `connect_request` with
`{provider:"google_calendar",thread_id:"<owned thread>",access:"read_only"|"read_write"}`
when the task lacks access. It contains no OAuth URL, state or credential. The
service generates it after human invocation/thread/Bud authorization. The card
requests exactly that access; ordinary chat content cannot create an access card.

The browser sends `POST /api/google/connect` with
`{selections:[{service:"calendar",access}],thread_id?}` using its signed-in cookie
and trusted Origin. The service authorizes the return thread/Bud, stores the
selection and return thread with encrypted PKCE data, and returns `authorization_url`.
The callback consumes owner/session-bound state, reauthorizes the saved thread,
and returns to the configured same-origin chat path. Missing destinations and
invalid state fall back to Settings; arbitrary return URLs are rejected. OAuth
never performs the task: the user sends a message after connecting to continue.

`GET /api/google/connection` returns `configured` and owned `connections`, with
`access[service]` (`none`, `read_only`, `read_write`), read/write capability booleans,
ID, account email, status and update time. Effective access is the intersection of
the user's selected access and actual Google scopes. Incremental Google consent
may retain earlier broader scopes, but Bud still enforces the selected access.

`DELETE /api/google/connection/:connection_id/services/:service` revokes only that
service in Bud. `DELETE /api/google/connection/:connection_id` disconnects the shared
account. Both authorize the viewer and require a trusted Origin for cookie requests;
foreign connections return 404. Service revocation invalidates pending OAuth state,
so a stale callback cannot re-enable it. Settings reconnect is explicit.

There is no per-action approval endpoint, approval card, or global write switch.
Deploy matching service/web after the connection migration; no daemon change.
