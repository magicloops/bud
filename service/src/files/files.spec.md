# files

Service-side file-session and file-stream bridge for Phase 4 of the daemon network upgrade.

## Purpose

This folder owns browser-created file sessions and the HTTP edge-to-daemon stream bridge for read-only file access. File sessions are user-owned, Bud-scoped, short-lived, root-relative, revocable, auditable, and fail closed unless the Bud has active gRPC control plus a negotiated HTTP/2 data stream with file-read support.

## Files

### `file-session.ts`

File session helpers and route-facing contracts.

- validates the initial file root as `workspace` only
- validates paths as POSIX-style root-relative paths with no absolute, drive-prefix, backslash, NUL, or parent-directory traversal segments
- normalizes file permissions, defaulting to `stat`, `read`, and `range`
- resolves whether the Bud has active authenticated `h2_grpc` control and subordinate `h2_data` with `file_read` negotiated
- creates owned `file_session` rows with TTL, max-byte limit, audit correlation id, display metadata, and transport degraded state
- records `file.session_create` and `file.session_revoke` audit events
- reads and lists sessions with SQL owner filters
- serializes the stable browser REST response shape

### `file-edge.ts`

Browser-facing file edge implementation.

- authorizes an owned file session before opening daemon work
- supports `HEAD`, full `GET`, and single `Range` `GET`
- creates durable `bud_operation` and `bud_stream` rows for each file request
- sends `file_open` metadata over gRPC control
- streams daemon file chunks from `BudData.Attach` into the Fastify reply body
- stores daemon-provided `content_identity` back onto the file session
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- tolerates tiny stat/range responses where data-stream close arrives before control-stream state transitions finish
- sanitizes response headers before sending them to the browser

### `file-runtime.ts`

In-memory bridge between daemon `file_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- writes `stream_data` chunks to a `PassThrough`
- turns reset/close frames into HTTP stream completion or failure
- deletes the runtime registration when the stream closes or resets

### `file-session.test.ts`

Focused unit coverage for root/path validation, permission normalization, and gRPC control/data transport readiness checks.

### `file-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `file_session` schema and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - gRPC control/data tracker state used for readiness
- [../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) - Phase 4 sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later file work still needs richer stream close/reset audit events, configurable daemon roots, and end-to-end browser file-viewer adoption.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
