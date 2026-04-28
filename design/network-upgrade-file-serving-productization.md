# Design: Network Upgrade File Serving Productization

## Context

The network-upgrade PR adds the daemon/service file-stream foundation over the carrier-neutral data-plane runtime. The open-source baseline is binary `BudEnvelope` stream frames on the authenticated daemon WebSocket; HTTP/2 gRPC data remains an optional carrier and QUIC remains a later optimization.

The foundation includes `file_session` state, route contracts, daemon-side file stat/read/range handling, stream credits, typed resets, per-Bud stream limits, service-side byte ceilings, and real-daemon WebSocket-only smoke coverage.

This design covers the follow-on product work needed to turn that foundation into user-facing file viewing. File viewing should not be treated as complete in the network-upgrade PR because it touches the web UI, viewer selection, user-facing states, and product authorization flows.

## Goal

Let a user open a path referenced by the agent and view the file through the Bud web app.

The intended product model is:

- the agent or terminal output references a path
- the web app recognizes the path as openable context
- the user clicks the path or an adjacent action
- the service creates or resolves a short-lived file session for the authorized Bud/thread/path
- the web app renders the content with a markdown viewer, code viewer, or text fallback

The agent should not need to know about file-session creation, access policy, signed URLs, or viewer mechanics. This remains a user-driven action on service-owned browser routes.

## Non-Goals

- arbitrary file browser or directory explorer
- file writes or edits
- agent-managed file access
- direct browser-to-daemon file reads
- QUIC implementation
- web-serving proxy productization

## Product Contract

File serving should expose an "open path" workflow, not a generic model tool.

Initial flow:

1. Web detects path-like text in assistant messages, tool output, and terminal transcript areas where the Bud/thread context is known.
2. User selects `Open file`.
3. Web calls a service route with Bud/thread context and the literal path.
4. Service authorizes the viewer, resolves the Bud/thread owner, creates a short-lived `file_session`, and returns a service-owned file URL plus metadata.
5. Web fetches through the service file edge and chooses a viewer:
   - markdown renderer for `.md` / `.markdown`
   - code viewer for known source extensions
   - plain text fallback for other text-like files
   - unsupported/binary state for unknown binary content

Open questions:

- whether the path action is inline on every detected path or shown through a contextual menu
- how much terminal transcript path detection should do before it becomes noisy
- whether image/PDF preview is part of this follow-on or a later viewer expansion

## Service Design

The existing foundation can remain the lower-level carrier:

- `POST /api/buds/:budId/file-sessions`
- `GET /api/files/:fileSessionId`
- `HEAD /api/files/:fileSessionId`
- range reads with content identity
- `file_session` ownership, TTL, revocation, max bytes, and audit fields
- WebSocket-first stream transport through carrier-neutral `DataPlane*` selectors
- service-side concurrency, chunk, in-flight, idle, TTL, and response byte limits

Productization may add a browser-facing helper such as `POST /api/threads/:threadId/open-file` if that better captures the ownership context. That helper should still produce the same `file_session` and file edge URL.

Sessions should be lazy-on-click for the first product version. Pre-creating sessions while rendering agent output risks expanding access to paths the user never opens, creates noisy audit records, and increases expiry/reconciliation work. The UI can still pre-detect path-like text and only create the session when the user asks to open it.

Service requirements:

- resolve authenticated viewer before reading or creating any session
- resolve thread ownership before using thread context
- resolve Bud ownership before opening a daemon stream
- return `401` only for unauthenticated browser requests
- return `404` for signed-in non-owners
- keep session TTL short
- filter file-session list/read helpers by owner in SQL
- record session create/revoke/open/deny/reset/close audit events
- enforce max bytes, MIME/type sniffing limits, stream limits, and response header policy

## Daemon Policy

The current HTTP/2 foundation is workspace-root scoped. The product goal can support opening any path-based file only if the daemon owns the final local policy decision.

Daemon-side requirements:

- canonicalize paths before reading
- reject parent traversal, NUL bytes, special files, devices, sockets, FIFOs, and directories
- reject unsafe symlinks unless an explicit future policy allows them
- enforce configured roots or an allowlisted path policy
- enforce max bytes and range bounds
- compute content identity where practical
- reject stale range reads when content identity changes
- return typed policy denials without leaking unnecessary host details

The service must never treat a user-clicked path as sufficient authorization by itself.

## Transport

File viewing should use the transport selector internally:

```text
WebSocket control+data baseline
  -> optional HTTP/2 BudData.Attach when configured and healthy
  -> future QUIC data stream when implemented and healthy
```

The viewer contract must not expose which daemon transport carried the bytes. Product code should call service-owned routes and render states based on HTTP/session status, not carrier type.

## Validation

Required before product exposure:

- route auth tests for unauthenticated `401`
- route auth tests for signed-in non-owner `404`
- file-session owner filtering tests
- WebSocket-only file smoke with gRPC disabled
- service limit tests for concurrency, byte ceiling, chunk/credit, idle, and TTL paths
- path normalization and rejection tests
- web viewer tests for markdown, code/text fallback, expired, denied, offline, and unsupported states
- real-daemon file smoke remains green with HTTP/2 and QUIC disabled
- web lint/build/test coverage if frontend files change

## Exit Criteria

- users can open referenced path-based files from the web app
- access is user-driven and service-authorized
- the agent does not manage file access
- file sessions remain short-lived, revocable, audited, and owner-scoped
- unsupported, denied, expired, and offline states are visible and understandable
