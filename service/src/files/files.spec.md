# files

Service-side file-session and file-stream bridge for Phase 4 of the daemon network upgrade.

## Purpose

This folder owns browser-created file sessions and the HTTP edge-to-daemon stream bridge for read-only file access. File sessions are user-owned, Bud-scoped, short-lived, root-relative, revocable, auditable, and fail closed unless the Bud has an active data-plane carrier with `file_read` support.

## Files

### `file-session.ts`

File session helpers and route-facing contracts.

- validates the initial file root as `workspace` only
- validates paths as POSIX-style root-relative paths with no absolute, drive-prefix, backslash, NUL, or parent-directory traversal segments
- normalizes file permissions, defaulting to `stat`, `read`, and `range`
- resolves whether the Bud has an active WebSocket/HTTP2 data-plane carrier with `file_read` negotiated
- creates owned `file_session` rows with TTL, configurable default max-byte limit, audit correlation id, display metadata, and transport degraded state
- records `file.session_create` and `file.session_revoke` audit events
- reads and lists sessions with SQL owner filters
- serializes the stable browser REST response shape

### `file-edge.ts`

Browser-facing file edge implementation.

- authorizes an owned file session before opening daemon work
- supports `HEAD`, full `GET`, and single `Range` `GET`
- creates durable `bud_operation` and `bud_stream` rows for each file request
- enforces per-Bud file stream concurrency, per-stream idle/TTL limits, max chunk/credit windows, and the file-session byte ceiling
- sends `file_open` metadata over the selected carrier's control side
- streams daemon file chunks from the selected data-plane carrier into the Fastify reply body
- stores daemon-provided `content_identity` back onto the file session
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- fails and resets durable state when carrier send throws or when an accepted daemon open-result omits the required HTTP status code
- records stream-open and service/daemon denial audit events with selected carrier metadata
- sanitizes response headers before sending them to the browser

### `file-runtime.ts`

In-memory bridge between daemon `file_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- writes `stream_data` chunks to a `PassThrough`
- enforces the service-side max received byte count before forwarding chunks to the browser
- turns reset/close frames into HTTP stream completion or failure
- preserves runtime registration when zero-byte `HEAD/stat` closes arrive before gRPC control `file_open_result`
- deletes the runtime registration when the stream closes or resets

### `file-session.test.ts`

Focused unit coverage for root/path validation, permission normalization, and carrier-neutral transport readiness checks.

### `file-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `file_session` schema and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - data-plane carrier selection and stream runtime
- [../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md](../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md) - carrier-neutral runtime sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later file work still needs configurable daemon roots, product file-viewer adoption, and UI coverage for denied/expired/offline states.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
