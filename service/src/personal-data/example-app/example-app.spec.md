# Private contact example app

## Purpose and ownership

Phase-7 acceptance app for an approved owner's contacts/history/location. The
Node backend binds `127.0.0.1` only. Publish it exclusively through the existing
owner-private Bud preview for the site named in the approved request. The Bud
gateway resolves/authenticates the acting viewer before forwarding; the service
app-key adapter resolves the approving owner and checks current grant/site state
before each data read. This example does not create data rows or support shared
viewers. Local processes on the same machine are within the existing Bud terminal
trust boundary. Do not expose this backend with a public tunnel/reverse proxy.

## Files

- `server.mjs`: fixed static assets and GET-only bounded contact query proxy using
  the backend helper. No setup/admin endpoints, filesystem browsing or raw errors.
- `server.d.mts`: typed backend factory contract for the service integration fixture.
- `index.html`, `style.css`, `app.js`: search/pagination, revision history and
  timestamped uncertain location evidence. Untrusted names use `textContent`.
  OpenStreetMap receives coordinates only after the user clicks Show.
- `server.test.mjs`: local HTTP asset/query allowlist, bounds, method rejection,
  redacted permission failure and frontend secret-plumbing checks.

## Setup and run

Use [backend setup](../../../../plan/personal-data-ingestion-and-agent-triggers/backend-app-setup.md)
to initialize app ID `private-contact-example`, request/approve the private site's
policy, and install with the same app ID and API origin. For all three screens,
request `contacts.read` and `location.read`, names and the desired other contact
fields, location precision and an appropriate history window.

Run from the repository root after installation:

```sh
BUD_API_ORIGIN=http://127.0.0.1:3000 BUD_APP_DATA_KEY_ID=dak_REPLACE_WITH_APPROVED_ID node service/src/personal-data/example-app/server.mjs
```

`BUD_APP_ID` overrides the stable installation ID; `PORT` defaults to 4310.
Only public configuration is supplied. Helper private state remains outside this
directory/Git. This source-tree example imports the sibling public helper; when
copying to a generated app, copy/download it as backend code and adjust the import.

## Validation limits

Run `node --test service/src/personal-data/example-app/server.test.mjs`.
The example still needs private-viewer and opposite-client demonstrations.
A local route test alone does not prove gateway
authentication, live agent setup, rendered UI behavior or map loading.

Verified so far: standalone HTTP route tests pass, and the PostgreSQL permission
continuation fixture starts this backend against its installed helper and reads
an ingested baseline contact, history and location. It checks names-only search
and projection, rounded coordinates, retained sensor accuracy/uncertainty, no
baseline trigger and 403 on the next request after HTTP revocation. Authenticated
preview, rendered UI and live agent setup demonstrations remain open.
