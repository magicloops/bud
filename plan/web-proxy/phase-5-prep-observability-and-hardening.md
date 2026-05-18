# Phase 5 Prep: Observability And Proxy Hardening

## Objective

Make the current HTTP-only proxy diagnosable and secure enough to support the
larger WebSocket/HMR phase. This phase should not add browser WebSocket support
yet; it reduces ambiguity and closes already-known safety/test gaps before the
protocol surface expands.

## Context

The Vite dev-server smoke showed a reset storm when HMR attempted to run
through the current proxy. The likely product blocker is missing WebSocket
support, but the daemon logs only show `reason=protocol_error`, which is not
enough to distinguish `UNKNOWN_STREAM`, `OFFSET_MISMATCH`,
`FINAL_OFFSET_MISMATCH`, or other stream lifecycle cases.

Phase 2 also still has open gateway auth/security test coverage. Those tests
should land before the gateway accepts WebSocket upgrades.

## Scope

- Improve service and daemon reset diagnostics.
- Add missing proxy gateway auth/security tests.
- Make unsupported WebSocket/HMR capability visible in product/API/tool output.
- Add a small validation runbook for collecting the next failure if Phase 5a or
  5b reveals stream lifecycle bugs.
- Keep runtime behavior otherwise unchanged.

## Non-Goals

- No browser WebSocket upgrade route.
- No daemon local WebSocket client.
- No new proxy WebSocket protocol frames.
- No request bodies or expanded HTTP methods.
- No local HTTPS implementation.

## Diagnostic Work

Service-side logging and audit improvements:

- Log outbound `stream_reset` frames with:
  - `stream_id`
  - reset `reason`
  - `error.code`
  - `error.message`
  - safe `error.details`
  - stream type
  - transport kind
- Ensure `data_plane.stream_reset` audit rows capture the same safe error code
  and details for proxy streams.
- When the service receives `stream_data` for an unknown stream, log whether the
  stream was never registered or was already cleaned up if that is available
  from local state.
- When `FINAL_OFFSET_MISMATCH` occurs, include expected and received offsets in
  safe details.

Daemon-side logging improvements:

- When handling inbound `stream_reset`, log:
  - `stream_id`
  - reset `reason`
  - `error.code`
  - `error.message`
  - safe details if present
- Keep payload bytes, cookies, grants, and request bodies out of logs.

## Gateway Auth/Security Tests

Add or complete tests for:

- owner can mint a viewer grant
- non-owner cannot mint a viewer grant
- grant expires
- grant is one-time use
- bootstrap host must match the endpoint host
- viewer cookie must be valid before daemon stream allocation
- unknown endpoint host returns `404`
- disabled/expired site blocks gateway traffic before daemon stream allocation
- `bud.dev` cookies are not forwarded upstream
- reserved proxy viewer cookie name cannot be overwritten by local app response
  headers in the current supported header policy

The most important invariant is auth-before-work: unauthenticated or invalid
gateway requests must not create durable daemon operation/stream rows and must
not send `proxy_open`.

## Product Capability Surfacing

Until Phase 5 lands, make the current capability explicit:

- API/tool results should indicate `websocket: false` or equivalent for proxied
  sites.
- Agent-facing summaries should not imply full dev-server/HMR support.
- Web UI should be able to display an unsupported-HMR/WebSocket state if we can
  detect it cheaply.
- The debug/workaround guidance should say `vite preview` works for HTTP-only
  proxying, while Vite dev/HMR waits for Phase 5.

This does not require a polished warning UI if it creates churn. The minimum is
that structured responses do not hide the limitation.

## Validation Runbook

For any future reset storm, collect:

- browser URL and target path
- first failing or repeating request path
- whether a browser request attempted `Upgrade: websocket`
- service log line for the reset with `error.code`
- daemon log line for the reset with `error.code`
- relevant `data_plane.stream_reset` audit row for the stream id
- whether the same target works under `vite preview`

## Spec Files To Update During Implementation

- `service/src/proxy/proxy.spec.md`
- `service/src/transport/transport.spec.md`
- `bud/src/proxy/proxy.spec.md`
- `bud/src/src.spec.md`
- `docs/proto.md` only if log/audit semantics become protocol-visible

## Acceptance Criteria

- Reset logs identify concrete reset error codes, not only `protocol_error`.
- Gateway auth/security tests cover auth-before-daemon-work.
- Product/API/tool surfaces do not imply WebSocket/HMR support before it exists.
- A repeated Vite dev-server failure can be diagnosed from logs/audit rows
  without guessing which stream protocol error occurred.
