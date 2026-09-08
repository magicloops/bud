# Implemented app-data API

Working-tree implementation; not deployed. App request creation, agent
continuation and both-client review are implemented. `APP_DATA_KEYS_ENABLED=1`
requires `AGENT_INVOCATION_MODE=durable` and enables tool creation and approval
issuance together; the default is disabled. `/api/data/status` reports the
effective `features.app_keys` capability. Read, decline, revoke, query and
signed setup routes are mounted; service-owned expiry runs at readiness and
drains before database shutdown. Tests inject enabled issuance explicitly.

## Human permission management

These endpoints require the normal mobile OAuth bearer or browser session.
An explicit Authorization header takes precedence over cookies. App query keys
cannot authenticate here. SQL filters all resources by the resolved viewer;
anonymous requests get 401 and foreign resources get 404.

| Method | Path | Input / result |
|---|---|---|
| GET | `/api/data/access-requests` | Optional `limit` (1–100), owner/filter-bound `cursor`, `pending_only=true|false`; returns bounded requests with associated key inventory metadata |
| GET | `/api/data/access-requests/:id` | Request metadata, reviewed scopes/fields/precision/history, destination/fingerprint, lifecycle and optional key status |
| POST | `/api/data/access-requests/:id/decision` | `{decision:"approve"|"decline", expected_version, idempotency_key}`; immutable request decision, 409 for stale/conflicting retries; owned approval returns 503 while issuance is disabled |
| POST | `/api/data/app-keys/:id/revoke` | `{expected_version, idempotency_key}`; owner-stamped revocation and encrypted-envelope deletion |

There is no browser endpoint to create a tool request. Creation requires a
server-supplied owner/invocation/worker/fence/call and a current matching action
intent. Approval cannot edit requested permissions. Decisions atomically create
one key/grant record, or none for decline, expired or canceled work. App grants
are separate from the owner-wide `your_agents` grant.

Ordinary metadata never includes query credentials, verification hashes,
ciphertext or proof signatures. Request IDs, key IDs, setup expiry and recipient
fingerprints are public setup metadata, not credentials. All routes return
`Cache-Control: no-store`.

## App backend queries

Only `Authorization: Bearer <app-query-credential>` authenticates these routes.
Cookies and mobile OAuth do not substitute; missing/invalid/revoked keys get 403.
The key must be installed, approved and associated with a current owned private
site. Every query rechecks key/version/site permission before releasing results.

| Method | Path | Required scopes / input |
|---|---|---|
| GET | `/api/app-data/contacts` | `contacts.read`; optional `search`, `visibility`, `limit`, `cursor` |
| GET | `/api/app-data/contacts/:id` | `contacts.read` |
| GET | `/api/app-data/contacts/:id/history` | `contacts.read`; optional `limit`, `cursor` |
| GET | `/api/app-data/location` | `location.read`; required `from`, `to`, optional `limit`, `cursor` |
| GET | `/api/app-data/contacts/:id/location-context` | Both scopes; required `from`, `to` |

Unknown arguments are rejected. Pages have at most 100 records and existing
response-size bounds. Location windows span at most 31 days and must fit the
approved history. Contact history/current rows use the same observed-time cutoff.
SQL search and returned fields are restricted together: a names-only grant cannot
match a hidden phone, email, organization, postal address or website URL. Cursors
bind the app key/version and field list.

Explicit `contact_fields` choices are `names`, `organization`, `phones`, `emails`,
`postal_addresses` and `urls`. Existing requests/keys retain their exact allowlists;
new categories require a new reviewed request. Missing rich fields on legacy
records mean uncollected, not observed empty. Rich capture remains pending; these
choices prepare query authorization without enabling collection. Postal addresses
are contact records, never sensor evidence. URLs are untrusted stored strings and
must not be fetched or executed automatically.

Responses include `data`, `permission` and an uncertainty interpretation. Location
precision is `as_collected` or `rounded_2_decimals`; sensor accuracy is separately
labeled `source_horizontal_accuracy_m`. Coarse responses contain no unrounded
coordinate or raw source-event/epoch reference. Location context remains best
effort and never claims a verified meeting.

## Protected setup

`GET /api/app-data/backend-helper.mjs` serves public standalone Node backend code
without authentication. The artifact contains no application or service private
material. See [backend setup usage](backend-app-setup.md).

`POST /api/app-data/setup/:keyId/retrieve` and
`POST /api/app-data/setup/:keyId/installed` accept only `{signature}` (2 KiB body
limit). Their authorization is the recipient-private-key proof described in the
[handoff contract](app-key-handoff.md), not a user cookie or query credential.
Invalid proof or unknown key returns 404. Retrieval returns the original encrypted
envelope while setup is pending; installation verifies a distinct receipt and
deletes ciphertext. Retries return canonical installed/revoked/failed state.

No signature can approve a request or query data. Expired setup revokes the
unusable key; a new explicit request is required. Service maintenance processes
at most 25 batches per poll, each repository batch limited to 100 requests and
100 uninstalled keys. Failures retain persisted work and log a fixed message.

## Validation limits

Fastify/PostgreSQL tests exercise cross-owner requests, approval, signed delivery,
decryption, installation, scoped query and revoke. Route tests also check auth
separation, disabled issuance, body limits, no-store and secret-free error logs.
Backend-helper persistence, real localhost HTTP installation/query/revoke and
lost-acknowledgement recovery now pass separate tests. Actual OAuth/cookie,
live-provider continuation and cross-client/device acceptance remain open.
The private example backend has passed populated-data HTTP/PostgreSQL tests;
authenticated private-viewer and real mobile/web controls still need live validation.

## Agent permission requests

With the explicit AgentService permission setting and durable execution hook,
`data_request_api_key` accepts the immutable app label, purpose, data policy and
private-site/public-installation-key destination. Ownership and execution IDs are
server supplied. Parsing rejects malformed scopes and unsupported/private keys.
The action intent precedes atomic request creation and invocation parking.

After commit, the existing `agent.tool_call` event uses `name:data_request_api_key`
and `args` containing the public serialized request, including `request_id`.
The runtime enters `waiting_for_user`. No credential or encrypted envelope is
included. The agent returns, preserving its durable reservation; approval,
decline or expiry reconstructs the decision on the same turn before the next
provider call. The default configuration omits the tool; enabling the shared
flag makes it available with the existing mobile/web review controls.
`/agent/state.pending_data_requests` restores up to 20 owner-scoped pending
prompts after refresh or restart; it does not depend on an in-memory waiter.
See [protocol recovery](../../docs/proto.md#app-data-permission-requests-and-recovery).
