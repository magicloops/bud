# Phase 7b: Service Absolute Path Preflight

**Implementation status:** Implemented on this branch.

## Context

Phase 7a adds daemon `file_resolve`, allowing the service to accept absolute
POSIX syntax in the thread file-open route and ask the daemon to normalize it
before creating a viewer file session.

Related:

- [./phase-7-absolute-path-opens.md](./phase-7-absolute-path-opens.md)
- [./phase-7a-daemon-file-resolve-frame.md](./phase-7a-daemon-file-resolve-frame.md)

## Objective

Update `POST /api/threads/:thread_id/files/open` so absolute POSIX paths are
authorized by thread ownership, resolved by the daemon, and stored as normal
workspace-relative file sessions.

Acceptance criteria:

- service parser classifies absolute POSIX paths instead of rejecting them
- service still rejects URL, `mailto:`, NUL, Windows, backslash, empty, and
  trailing-slash directory forms before daemon work
- service requires normal file-read transport availability before absolute
  preflight
- service sends `file_resolve` over the control path for absolute POSIX inputs
- successful resolve creates a file session with daemon-approved
  `relative_path`
- service persists preflight `content_identity` on the file session
- outside-root daemon denial maps to `403`
- missing in-root file maps to `404`
- resolve timeout maps to `504`
- unsupported/missing daemon capability maps to offline/unavailable rather than
  falling back to unsafe service-side normalization

## Parser Shape

Update the parsed file path type:

```ts
type ParsedViewerFilePath =
  | {
      kind: "relative";
      rawPath: string;
      relativePath: string;
      line?: number;
      column?: number;
    }
  | {
      kind: "absolute_posix";
      rawPath: string;
      requestedPath: string;
      line?: number;
      column?: number;
    };
```

Relative paths continue through the existing session creation path.

Absolute POSIX paths go through daemon preflight before DB insertion.

## Preflight Flow

1. Authenticate the viewer.
2. Authorize the thread and derive its Bud.
3. Parse the raw path and line/column metadata.
4. If path is relative, keep the existing flow.
5. If path is absolute:
   - check `resolveFileTransportStatus(thread.budId)`
   - require `available: true`
   - require a daemon capability for absolute POSIX resolve
   - send `file_resolve` over control
   - wait with a short timeout, likely the same 15-second budget as file open
6. On accepted resolve:
   - create a viewer file session using `resolved_relative_path`
   - set `root_key = "workspace"`
   - set `max_bytes = 1048576`
   - set permissions to `["stat", "read", "range"]`
   - persist `content_identity` returned by preflight
   - store display metadata described below
7. Return the normal file-session response.

## Display Metadata

For absolute POSIX opens, store a minimal display-safe shape:

```json
{
  "raw_path": "/Users/adam/bud/docs/proto.md",
  "source": {
    "kind": "markdown_preview",
    "message_id": "22222222-2222-4222-8222-222222222222",
    "client_id": "33333333-3333-4333-8333-333333333333"
  },
  "requested_path_kind": "absolute_posix",
  "resolved_against": "absolute_path",
  "viewer_intent": "preview"
}
```

Do not include canonical absolute paths in browser/mobile-visible metadata.

For absolute opens, do not copy `metadata.path_context` into display metadata
unless a later resolver actually uses it. Absolute paths carry their own host
candidate and do not need message-time cwd.

## Content Identity

Persist `content_identity` returned by `file_resolve` immediately on the new
file session.

Rationale:

- preflight stat is the first concrete target approval
- the identity is useful for response metadata, audit/debugging, and future
  byte-range reads
- normal preview `HEAD` and full `GET` should still open the current file
  contents, even if an older stored identity is stale
- `409 CONTENT_CHANGED` is reserved for stale byte-range reads and files that
  change during a read, where returning mixed or offset-invalid bytes would be
  incorrect

Implementation can either extend `createFileSession(...)` to accept optional
initial content identity, or create the session and immediately update
`file_session.content_identity` inside the same transaction/helper.

## Error Mapping

| Daemon/service condition | HTTP | Body guidance |
| --- | --- | --- |
| unsupported daemon capability | `424` | `FILE_RESOLVE_UNAVAILABLE` |
| no file data-plane transport | `424` / `503` | existing transport status body |
| `POLICY_DENIED`, `UNSAFE_PATH` outside root | `403` | denied/outside scope |
| `FILE_NOT_FOUND` | `404` | not found |
| `SYMLINK_DENIED` | `403` | denied |
| `UNSAFE_FILE_TYPE` | `403` | unsupported file type |
| `LOCAL_READ_FAILED` | `502` | local read failed |
| timeout | `504` | retryable timeout |

Keep unauthenticated `401` and signed-in non-owner `404` behavior unchanged.

## Tests

Service tests:

- absolute POSIX path is accepted after thread authorization
- URL, NUL, Windows, backslash, empty, and trailing slash still return `400`
- missing file transport returns offline/unavailable without creating a session
- missing `file_resolve` capability returns offline/unavailable without creating
  a session
- accepted `file_resolve_result` creates a file session with
  `relative_path = resolved_relative_path`
- accepted result persists `content_identity`
- display metadata includes `requested_path_kind` and `resolved_against`
- outside-root denial maps to `403`
- missing in-root file maps to `404`
- `source.kind = "markdown_preview"` and original message ids are preserved
- existing relative-path route tests still pass

## Files Likely Touched

- [../../service/src/routes/threads/files.ts](../../service/src/routes/threads/files.ts)
- [../../service/src/routes/threads/files.test.ts](../../service/src/routes/threads/files.test.ts)
- [../../service/src/files/file-session.ts](../../service/src/files/file-session.ts)
- [../../service/src/files/file-session.test.ts](../../service/src/files/file-session.test.ts)
- [../../service/src/files/file-edge.ts](../../service/src/files/file-edge.ts)
- [../../service/src/ws/protocol.ts](../../service/src/ws/protocol.ts)
- [../../service/src/ws/bud-connection.ts](../../service/src/ws/bud-connection.ts)
- [../../service/src/proto/wire.ts](../../service/src/proto/wire.ts)
- [../../service/src/proto/wire.test.ts](../../service/src/proto/wire.test.ts)
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md)
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [../../docs/proto.md](../../docs/proto.md)
