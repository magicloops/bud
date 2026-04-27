# Phase 4: Localhost Proxy And File Reads

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 4.4 file stat/read/range implemented over HTTP/2 data; web adoption pending

---

## Objective

Ship the first new daemon-networking product features on the mandatory HTTP/2 data fallback path: localhost HTTP proxying and read-only file/range serving.

## Context

This phase is the security-critical feature phase. It must work with QUIC disabled. The service remains the browser-visible edge: users open service HTTPS URLs, the service authorizes the viewer and session, and the daemon only touches local resources after daemon-side policy accepts the exact target.

## Phase 3.1 Baseline

The current implementation gives Phase 4 a working daemon gRPC foundation, but not a complete generic stream runtime yet.

Already available:

- `BudControl.Connect` is the authenticated lifecycle authority for daemon identity, heartbeat, control frames, reconnect reports, and service drain.
- `BudData.Attach` is available as an opt-in subordinate HTTP/2 data stream bound to the active control session.
- Subordinate `h2_data` transport rows close when the owning `h2_grpc` control tracker closes, drains, times out, or is superseded.
- Terminal output is proven over HTTP/2 data with local real-daemon smoke coverage.
- Terminal output falls back to control only for the terminal path when data is disabled, closed, or full.
- Large terminal output no longer blocks terminal input dispatch in the local smoke.

Still not available:

- durable file stream metrics beyond operation/stream/audit rows
- minimal web adoption for launching/opening file URLs

Phase 4 therefore starts with a small stream foundation before adding product routes. Proxy/file must fail closed when `h2_data` is unavailable; unlike terminal output, they should not silently fall back to the control stream or WebSocket compatibility.

## Scope

### In Scope

- minimal generic data-stream dispatcher for proxy/file stream frames
- runtime stream credit enforcement sufficient for bounded proxy/file streaming
- typed stream reset and close propagation for proxy/file callers
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
- WebSocket compatibility for new proxy/file product behavior
- proxy/file payload fallback onto `BudControl.Connect`
- raw TCP proxy
- LAN proxy
- arbitrary file browsing
- file writes
- persistent public share links
- SSH/Docker/Kubernetes/Unix socket proxying
- full browser terminal replacement

## Fixed Decisions

- Proxy and file URLs terminate at the service, not the daemon.
- Proxy/file require an active authenticated gRPC control session and an attached HTTP/2 data stream.
- Proxy sessions are short-lived and scoped to a user, Bud, target host, target port, and methods.
- Initial proxy target is only `http://127.0.0.1:<explicit_port>`.
- File sessions are short-lived and scoped to a user, Bud, approved handle/root/path policy, and byte/range limits.
- The daemon must deny unsafe targets even if the service asks.
- All policy denials are auditable.
- Runtime stream credits and resets must be in place before proxy/file bytes move onto `BudData.Attach`.
- The Phase 2 shared-secret device credential remains acceptable for internal implementation, but production exposure of proxy/file should require a recorded device-identity hardening decision.

## Implementation Tasks

### Task 0: Add generic stream foundation

Add the smallest runtime needed for proxy/file streams over the existing control/data split:

- service creates durable `bud_operation` and `bud_stream` rows for proxy/file work before opening daemon streams
- service sends stream-open metadata over `BudControl.Connect`
- daemon accepts, rejects, resets, and closes streams over control
- data bytes move only over `BudData.Attach` using `stream_data`
- credit updates move over data or control consistently
- both sides enforce max chunk size and max in-flight bytes
- reset/close transitions update `bud_stream` state and unblock waiting HTTP callers
- data-unavailable state maps to a typed service error, not control/WebSocket fallback

This task should stay intentionally small. It can support one active proxy/file stream at first if that keeps scheduling simple, as long as limits are explicit and safe.

Initial implementation:

- service tracks generic data runtime streams by `stream_id` with receive/send offsets, receive/send credit windows, and close/reset flags
- service accepts `stream_data` only for registered runtime streams, enforces offset order, chunk size, and available receive credit, then grants credit after synchronous consumption
- service applies `stream_credit`, `stream_reset`, and `stream_close` to runtime stream state and best-effort `bud_stream` transitions
- service write helpers send generic stream frames only over active `h2_data`
- daemon treats generic stream frames as data-only; `stream_data` is rejected with `UNSUPPORTED_STREAM` until proxy/file adapters land
- daemon `TransportSender` fails generic `stream_*` frames closed if the data channel is unavailable, while preserving terminal-output control fallback

Still required before proxy/file routes are shippable:

- service-created stream-open metadata over control
- durable `bud_operation` / `bud_stream` creation at proxy/file open time
- asynchronous credit grants tied to actual HTTP response/file consumer drain
- proxy/file adapters on the daemon

Phase 4.2 update:

- service-created `proxy_open` metadata now moves over gRPC control for localhost proxy GET/HEAD requests
- each proxy edge request creates durable `bud_operation` and `bud_stream` rows before daemon dispatch
- proxy response bytes move over `BudData.Attach` as generic `stream_data`
- service grants credit after writing chunks into the HTTP response bridge
- `stream_reset` and `stream_close` propagate into active HTTP callers and durable operation/stream transitions
- generic stream frames still fail closed when `h2_data` is unavailable

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
- degraded/unavailable metadata if no acceptable data path is attached

Initial implementation:

- `POST /api/buds/:budId/proxy-sessions` creates a short-lived owned proxy session
- the target contract is strict `target_host = "127.0.0.1"` plus explicit `target_port`
- allowed methods default to `GET` and `HEAD`; unsupported methods such as `CONNECT` are rejected
- optional `thread_id` must be owned by the viewer and belong to the same Bud
- responses include `proxy_url`, expiry, audit correlation id, and current gRPC control/data readiness
- unavailable `h2_grpc` or `h2_data` is recorded as degraded state instead of falling back to control/WebSocket

### Task 2: Add proxy schema and ownership helpers

Add `proxy_session` with:

- `tenant_id`
- `created_by_user_id`
- `bud_id`
- optional `thread_id`
- optional `operation_id`
- optional active `stream_id`
- target host/port
- allowed methods
- state
- expiry
- revocation fields
- audit correlation ID

Use SQL ownership filtering for lookup/list paths.

Initial implementation:

- `proxy_session` is in `service/src/db/schema.ts` and checked in through migration `0014_worthless_frank_castle.sql`
- rows include `tenant_id`, `created_by_user_id`, Bud/thread references, optional operation/stream references, target host/port, allowed methods, state, expiry, revocation fields, display metadata, and audit correlation id
- helper reads/lists/revokes filter by `proxy_session.created_by_user_id`
- session create/revoke writes `proxy.session_create` and `proxy.session_revoke` audit events

### Task 3: Implement service proxy edge

Add routes such as:

- `POST /api/buds/:bud_id/proxy-sessions`
- `GET /api/proxy/:proxy_session_id/*`
- optional method handling for allowed non-GET methods

The edge must:

- authorize session before stream open
- reject expired/revoked sessions
- require active `h2_grpc` control and `h2_data` data transport for the target Bud
- sanitize request headers
- strip Bud auth cookies
- enforce body size/stream limits
- map daemon errors to HTTP responses
- support streaming responses
- support local SSE responses
- support Range if needed by common local web assets

Optional WebSocket upgrade should require explicit capability and is deferred for the first proxy target.

Initial implementation:

- `/api/proxy/:proxySessionId/*` authorizes the viewer and owned session before any daemon work
- the edge rejects expired/revoked sessions with `410`
- the edge rejects disallowed methods with `405` and `Allow`
- the edge rejects unavailable gRPC control/data with `424`
- ready sessions now support `GET` and `HEAD` by sending `proxy_open` over gRPC control and streaming response bytes from `BudData.Attach`
- the edge still returns `501 proxy_method_not_implemented` for non-GET/HEAD methods in this slice
- request and response headers are allowlisted; Bud auth cookies and hop-by-hop headers are not forwarded
- active response streams receive daemon reset/close notifications through the proxy runtime bridge

### Task 4: Implement daemon proxy adapter

The daemon should:

- validate target and method against local policy
- create a local HTTP request to the exact normalized `http://127.0.0.1:<port>` target
- avoid DNS resolution, redirects to non-loopback targets, Unix sockets, and scheme upgrades
- forward sanitized headers/body
- stream response headers/body back
- enforce byte/time limits
- emit typed policy denials and local connection errors

Initial implementation:

- daemon dispatches `proxy_open` into `bud/src/proxy`
- daemon revalidates `stream_type = "localhost_http_proxy"`, `target_host = "127.0.0.1"`, absolute path, and method `GET` / `HEAD`
- daemon uses a reqwest client with redirects disabled
- daemon forwards only a small request-header allowlist
- daemon sends `proxy_open_result` accept/reject metadata over control
- daemon streams response chunks over data-only `stream_data`
- daemon waits for `stream_credit` before sending more response bytes and stops when service sends `stream_reset`

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
- degraded/unavailable metadata if no acceptable data path is attached

Initial implementation:

- `POST /api/buds/:budId/file-sessions` creates a short-lived owned file session
- the target contract is strict `root_key = "workspace"` plus a POSIX-style root-relative `relative_path`
- absolute paths, home-relative paths, Windows drive paths, backslash separators, NUL bytes, and parent-directory traversal segments are rejected at the service contract boundary
- permissions default to `stat`, `read`, and `range`; `range` implies `read`, and `read` implies `stat`
- optional `thread_id` must be owned by the viewer and belong to the same Bud
- responses include `file_url`, expiry, max bytes, audit correlation id, optional content identity, and current gRPC control/data readiness
- unavailable `h2_grpc` or `h2_data` is recorded as degraded state instead of falling back to control/WebSocket

### Task 6: Add file schema and edge routes

Add `file_session` with:

- `tenant_id`
- `created_by_user_id`
- `bud_id`
- optional `thread_id`
- optional `operation_id`
- optional active `stream_id`
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

The first file route should not expose arbitrary host paths by default. It should use an approved handle or a root-relative path under a daemon policy root.

Initial implementation:

- `file_session` is in `service/src/db/schema.ts` and checked in through migration `0015_gifted_kinsey_walden.sql`
- rows include `tenant_id`, `created_by_user_id`, Bud/thread references, optional operation/stream references, root key, relative path, permissions, max bytes, optional content identity, state, expiry, revocation fields, display metadata, and audit correlation id
- helper reads/lists/revokes filter by `file_session.created_by_user_id`
- session create/revoke writes `file.session_create` and `file.session_revoke` audit events
- `GET /api/files/:fileSessionId` and `HEAD /api/files/:fileSessionId` authorize the viewer/session and selected read/range/stat permission, then fail closed with `424` when file-read transport is unavailable

Phase 4.4 update:

- service-created `file_open` metadata now moves over gRPC control for owned file `HEAD`, full `GET`, and single-range `GET` requests
- each file edge request creates durable `bud_operation` and `bud_stream` rows before daemon dispatch
- file response bytes move over `BudData.Attach` as generic `stream_data`
- service grants credit after writing chunks into the HTTP response bridge
- daemon `file_open_result` accept/reject metadata unblocks the HTTP edge runtime
- daemon content identity is stored back onto the file session after accepted opens
- generic stream frames still fail closed when `h2_data` is unavailable

### Task 7: Implement daemon file adapter

The daemon should:

- authorize path/handle through local policy
- stat file
- compute content identity where practical
- serve full or range bytes
- enforce max bytes
- fail if content identity changes during range reads
- avoid following unsafe symlinks unless policy explicitly allows it
- avoid reading special files, devices, sockets, fifos, or directories as regular file bytes

Initial implementation:

- daemon dispatches `file_open` into `bud/src/files`
- daemon revalidates `stream_type = "file_read"`, `root_key = "workspace"`, relative POSIX paths, and mode `stat` / `read` / `range`
- daemon canonicalizes the configured workspace root and rejects symlinks, non-regular files, and canonical paths that escape that root
- daemon computes content identity from file size plus modified time and rejects stale expected identities
- daemon rejects range/full reads that exceed `max_bytes`
- daemon rejects mutation during reads by comparing content identity before and after the bounded read
- daemon sends `file_open_result` accept/reject metadata over control
- daemon streams accepted read/range body chunks over data-only `stream_data`
- daemon waits for `stream_credit` before sending more file bytes and stops when service sends `stream_reset`

### Task 8: Add audit events

Audit:

- proxy session create/revoke/expire
- file session create/revoke/expire
- stream open/close/reset
- policy denial
- local connection failure
- selected transport and transport health for a session
- data unavailable / degraded open failure

### Task 9: Add minimal web adoption

Add only the UI needed to use the feature:

- create/open proxy session for a selected Bud/port
- open file URL from a supported surface
- show expired/denied/offline/degraded states

Do not make web transport-aware.

## Recommended Sequencing

1. **Phase 4.0 stream foundation**: implement generic proxy/file stream open, `stream_data`, credits, resets, and data-unavailable failures without adding browser product routes.
2. **Phase 4.1 proxy security/session foundation**: add `proxy_session`, ownership helpers, audit helpers, and service route contracts with strict localhost validation.
3. **Phase 4.2 minimal proxy streaming**: implement GET/HEAD streaming through the daemon adapter over HTTP/2 data with QUIC disabled.
4. **Phase 4.3 file security/session foundation**: add `file_session`, ownership helpers, local policy shape, and audit events.
5. **Phase 4.4 file stat/read/range**: implement read-only file bytes over HTTP/2 data with content identity and mutation failure.
6. **Phase 4.5 minimal web adoption**: add only launch/open surfaces and user-visible denied/offline/expired states.

## Phase 3.1 Gaps Carried Forward

These gaps should be resolved inside Phase 4 before proxy/file are considered shippable:

- runtime stream credits and max in-flight byte enforcement
- typed reset propagation from daemon/service stream failures
- data-unavailable and degraded-state visibility in service responses, logs, audit events, or metrics
- hosted/front-door validation for long-lived HTTP/2 data streams

Phase 4.2 resolved the first two items for the localhost proxy path. Phase 4.4 now applies the same durable stream-open, credit, reset, close, and data-unavailable behavior to file stat/read/range requests. Richer metrics/operator views remain deferred.

Phase 4.2 local smoke validation is now covered by `pnpm --dir /Users/adam/bud/service smoke:grpc-proxy`, which runs the real Rust daemon against in-process grpc-js control/data gateways and verifies a loopback HTTP target through the proxy edge with QUIC disabled.

Phase 4.4 local smoke validation is now covered by `pnpm --dir /Users/adam/bud/service smoke:grpc-file`, which runs the real Rust daemon against in-process grpc-js control/data gateways and verifies workspace file `HEAD`, full `GET`, range `GET`, durable stream close state, persisted content identity, and stale-content rejection with QUIC disabled.

These gaps may remain deferred until after the first internal Phase 4 slice:

- QUIC
- WebSocket compatibility for proxy/file
- multi-stream fair scheduling beyond conservative per-Bud/per-class limits
- hardened keypair device identity, if the feature remains strictly internal during implementation

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
- proxy streaming tests with a local HTTP server (`pnpm --dir /Users/adam/bud/service smoke:grpc-proxy`)
- file stat/read/range tests (`pnpm --dir /Users/adam/bud/service smoke:grpc-file`)
- file mutation during range test (`pnpm --dir /Users/adam/bud/service smoke:grpc-file`)
- audit event tests
- manual localhost webview validation with QUIC disabled
- manual file viewer validation with QUIC disabled

## Exit Criteria

- localhost proxy works over HTTP/2 data with QUIC disabled
- file stat/read/range works over HTTP/2 data with QUIC disabled
- unsafe proxy targets and file paths are denied before local side effects
- sessions are user-scoped, short-lived, revocable, and audited
- browser/mobile clients only see service REST/SSE/HTTPS contracts
- relevant specs, protocol docs, and migrations are updated
