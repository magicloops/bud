# Backend app-data setup

Implemented helper and durable tool continuation, tested through local HTTP/PostgreSQL.
The [private example app](../../service/src/personal-data/example-app/example-app.spec.md)
now provides contact search, history and location evidence. Its backend query/revoke
flow passes the PostgreSQL integration fixture; live private-preview and opposite-client
demonstrations remain open. Use the service's supported
Node.js version (20.19+ or 22.12+).

## Install public helper code

Download `GET /api/app-data/backend-helper.mjs` from the configured Bud main API
origin. This is standalone public JavaScript with only Node built-in imports.
Save it with the app's backend code; never import it into a frontend bundle.
The deployed service copies the source file unchanged during `postbuild`.

Initialize from a backend setup script:

```javascript
import { BudAppData } from './backend-helper.mjs';

const appData = new BudAppData({
  appId: 'my-private-contact-app',
  apiOrigin: process.env.BUD_API_ORIGIN,
});
console.log(JSON.stringify(await appData.initialize()));
```

The returned `app_id`, `api_origin`, `public_key` and `recipient_fingerprint` are
safe setup metadata. Supply the public key and owned private-site ID when asking
for the user's app-data permission. A stable, distinct `appId` identifies this
backend installation. Repeated or concurrent initialization preserves its key.

Private state defaults to `~/.local/share/bud/app-data/<appId>/`, separate from the
app worktree. The directory must be owned by the running user with mode 0700;
private files use mode 0600. The helper rejects symlink files and unsafe modes.
The optional `stateRoot` override is for trusted backend/test configuration and
must remain outside Git, browser assets and any served filesystem root. Do not
read or print the private state through agent terminal tools.

## Finish approved setup

After approval, pass only the public context from the canonical request/key
metadata to the helper:

```javascript
const result = await appData.install({
  request_id: approved.request_id,
  key_id: approved.key.key_id,
  recipient_fingerprint: approved.destination.recipient_fingerprint,
  expires_at: approved.key.setup_expires_at,
});
console.log(JSON.stringify(result)); // status and key_id only
```

The helper signs retrieval internally, validates/decrypts the original envelope,
persists the credential and receipt digest with fsync, then acknowledges
installation. A failed connection can retry the exact same public context. After
local persistence, retries acknowledge from disk even if the service already
deleted ciphertext. The helper never returns private keys, signatures or query
credentials to its caller. Lost local credentials after completed installation
fail visibly; they are not silently replaced.

## Query from the backend

Store `BUD_APP_DATA_KEY_ID` as public application configuration. The backend reads
its private credential internally:

```javascript
const contacts = await appData.query(
  process.env.BUD_APP_DATA_KEY_ID,
  'contacts',
  { search: 'Ada', limit: 25 },
);
```

Supported resources are `contacts`, `contacts/<id>`,
`contacts/<id>/history`, `contacts/<id>/location-context`, and `location`.
Location calls require `from`/`to`; contact and location pages use the returned
cursor. The service enforces actual scopes, fields, precision and history.
Return only allowed query results through the app's existing owner-private
web access. Do not create a public dashboard backed by its builder's key.

The helper pins private state to the original API origin, permits HTTPS or local
loopback HTTP, refuses redirects, times requests out after 15 seconds and bounds
response bodies to 1 MiB. It does not use cookies or substitute user OAuth.
Revocation fails the next query with `app_data_permission_denied`. Setup and
network errors use fixed codes without response bodies or secret material.

## Remaining integrated validation

Unit tests cover concurrent identity creation, private modes, unsafe state,
tampered delivery, API-origin pinning and receipt retry after a lost response.
The real HTTP/PostgreSQL fixture covers helper download, approved setup, query and
revoke. The agent tool, opposite-client approval, generated app frontend/private
preview and provider/transcript/terminal secret-absence demonstration remain
required by phase 7.
