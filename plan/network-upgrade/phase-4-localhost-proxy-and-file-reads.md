# Phase 4: Localhost Proxy And File Reads

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Ship the first new daemon-networking product features on the mandatory HTTP/2 data fallback path: localhost HTTP proxying and read-only file/range serving.

## Context

This phase is the security-critical feature phase. It must work with QUIC disabled. The service remains the browser-visible edge: users open service HTTPS URLs, the service authorizes the viewer and session, and the daemon only touches local resources after daemon-side policy accepts the exact target.

## Scope

### In Scope

- proxy session creation API
- proxy edge route family
- daemon localhost HTTP proxy adapter
- `LOCALHOST_HTTP_PROXY` stream type
- read-only file session creation API
- file edge route family
- daemon file stat/read/range adapter
- `FILE_READ` stream type
- default localhost proxy policy
- default file read policy
- audit events
- web affordances only where needed to launch/view proxy and file URLs

### Out Of Scope

- QUIC requirement
- raw TCP proxy
- LAN proxy
- arbitrary file browsing
- file writes
- persistent public share links
- SSH/Docker/Kubernetes/Unix socket proxying
- full browser terminal replacement

## Fixed Decisions

- Proxy and file URLs terminate at the service, not the daemon.
- Proxy sessions are short-lived and scoped to a user, Bud, target host, target port, and methods.
- Initial proxy target is only `http://127.0.0.1:<explicit_port>`.
- File sessions are short-lived and scoped to a user, Bud, approved handle/root/path policy, and byte/range limits.
- The daemon must deny unsafe targets even if the service asks.
- All policy denials are auditable.

## Implementation Tasks

### Task 1: Define proxy session contract

Add API contract for creating a proxy session:

- authenticated viewer
- Bud ID
- optional thread context
- target host must be `127.0.0.1`
- explicit port
- allowed methods
- TTL
- optional display metadata

Response:

- proxy session ID
- service HTTPS base URL
- expiry
- degraded/fallback metadata if relevant

### Task 2: Add proxy schema and ownership helpers

Add `proxy_session` with:

- `tenant_id`
- `created_by_user_id`
- `bud_id`
- optional `thread_id`
- target host/port
- allowed methods
- state
- expiry
- revocation fields
- audit correlation ID

Use SQL ownership filtering for lookup/list paths.

### Task 3: Implement service proxy edge

Add routes such as:

- `POST /api/buds/:bud_id/proxy-sessions`
- `GET /api/proxy/:proxy_session_id/*`
- optional method handling for allowed non-GET methods

The edge must:

- authorize session before stream open
- reject expired/revoked sessions
- sanitize request headers
- strip Bud auth cookies
- enforce body size/stream limits
- map daemon errors to HTTP responses
- support streaming responses
- support local SSE responses
- support Range if needed by common local web assets

Optional WebSocket upgrade should require explicit capability and may be deferred if not needed for first proxy target.

### Task 4: Implement daemon proxy adapter

The daemon should:

- validate target and method against local policy
- create a local HTTP request to `127.0.0.1:<port>`
- forward sanitized headers/body
- stream response headers/body back
- enforce byte/time limits
- emit typed policy denials and local connection errors

### Task 5: Define file session contract

Add API contract for creating a file session:

- authenticated viewer
- Bud ID
- optional thread context
- file handle or approved root-relative path
- read/range permissions
- max bytes
- TTL

Response:

- file session ID
- service HTTPS file URL
- content identity if known
- expiry

### Task 6: Add file schema and edge routes

Add `file_session` with:

- `tenant_id`
- `created_by_user_id`
- `bud_id`
- optional `thread_id`
- handle/root/path metadata
- state
- max bytes
- expiry
- content identity
- revocation fields
- audit correlation ID

Add service routes for:

- stat/head
- read
- range read
- revoke if needed

### Task 7: Implement daemon file adapter

The daemon should:

- authorize path/handle through local policy
- stat file
- compute content identity where practical
- serve full or range bytes
- enforce max bytes
- fail if content identity changes during range reads
- avoid following unsafe symlinks unless policy explicitly allows it

### Task 8: Add audit events

Audit:

- proxy session create/revoke/expire
- file session create/revoke/expire
- stream open/close/reset
- policy denial
- local connection failure
- daemon fallback transport used for a session

### Task 9: Add minimal web adoption

Add only the UI needed to use the feature:

- create/open proxy session for a selected Bud/port
- open file URL from a supported surface
- show expired/denied/offline/degraded states

Do not make web transport-aware.

## Files Likely Affected

### Service

- `service/src/routes/`
- `service/src/routes/threads/`
- `service/src/db/schema.ts`
- `service/src/transport/`
- new `service/src/proxy/`
- new `service/src/files/`
- new `service/src/audit/`

### Bud

- new `bud/src/proxy/`
- new `bud/src/files/`
- new `bud/src/policy/`
- `bud/src/transport/`
- `bud/src/protocol.rs`

### Web

- `web/src/lib/api.ts`
- relevant workbench/thread UI files

## Test Plan

- service ownership tests for proxy/file session creation and lookup
- service SQL owner-filter tests
- proxy target validation tests
- daemon local policy tests
- proxy streaming tests with a local HTTP server
- file stat/read/range tests
- file mutation during range test
- audit event tests
- manual localhost webview validation with QUIC disabled
- manual file/range validation with QUIC disabled

## Exit Criteria

- localhost proxy works over HTTP/2 data with QUIC disabled
- file stat/read/range works over HTTP/2 data with QUIC disabled
- unsafe proxy targets and file paths are denied before local side effects
- sessions are user-scoped, short-lived, revocable, and audited
- browser/mobile clients only see service REST/SSE/HTTPS contracts
- relevant specs, protocol docs, and migrations are updated

