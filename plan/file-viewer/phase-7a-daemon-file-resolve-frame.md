# Phase 7a: Daemon File Resolve Frame

**Implementation status:** Implemented on this branch.

## Context

Phase 7 needs daemon-owned resolution for absolute POSIX paths before the
service creates a normalized viewer file session. The selected direction is a
small metadata-only `file_resolve` control frame rather than a stat-only
`file_open` preflight.

Related parent:

- [./phase-7-absolute-path-opens.md](./phase-7-absolute-path-opens.md)

## Objective

Add daemon-side absolute POSIX path resolution that can answer:

```text
Can this raw absolute path be served under the daemon file-viewer policy, and
what workspace-relative target should the service store if yes?
```

Acceptance criteria:

- service can send a control-plane `file_resolve` request for an absolute POSIX
  path
- daemon canonicalizes and policy-checks the path without serving file bytes
- daemon returns `resolved_against: "absolute_path"` plus
  `resolved_relative_path` when accepted
- daemon returns typed denial/not-found errors when rejected
- no generic stream, stream credit, or data-plane body is involved
- existing `file_open` relative-path behavior remains unchanged

## Wire Shape

The protobuf fields are `file_resolve = 180` and
`file_resolve_result = 181`. The JSON-compatible control-frame shape uses the
existing service/daemon envelope fields:

```json
{
  "proto": "0.1",
  "type": "file_resolve",
  "id": "msg_01H...",
  "ts": "2026-05-10T18:30:00.000Z",
  "operation_id": "op_01H...",
  "root_key": "workspace",
  "requested_path": "/Users/adam/bud/docs/proto.md",
  "requested_path_kind": "absolute_posix",
  "max_bytes": 1048576,
  "ext": {}
}
```

Accepted result:

```json
{
  "proto": "0.1",
  "type": "file_resolve_result",
  "id": "msg_01H...",
  "ts": "2026-05-10T18:30:00.000Z",
  "operation_id": "op_01H...",
  "accepted": true,
  "root_key": "workspace",
  "requested_path_kind": "absolute_posix",
  "resolved_against": "absolute_path",
  "resolved_relative_path": "docs/proto.md",
  "content_identity": {
    "size": 4096,
    "modified_ms": 1777132800000
  },
  "size": 4096,
  "ext": {}
}
```

Rejected result:

```json
{
  "proto": "0.1",
  "type": "file_resolve_result",
  "id": "msg_01H...",
  "ts": "2026-05-10T18:30:00.000Z",
  "operation_id": "op_01H...",
  "accepted": false,
  "error": {
    "code": "POLICY_DENIED",
    "message": "path is outside the Bud file-viewer scope",
    "retryable": false
  },
  "ext": {}
}
```

## Daemon Resolver Behavior

Add a shared daemon resolver helper used by both `file_resolve` and future
`file_open` cleanup work.

For Phase 7a, only add new behavior for `requested_path_kind:
"absolute_posix"`.

Resolution steps:

1. Reject empty, NUL-containing, URL-like, Windows-drive, and backslash paths.
2. Require the raw requested path to be absolute.
3. Normalize `.` / `..` components without following symlinks.
4. If the normalized path is outside the daemon workspace/allowed root, return
   `POLICY_DENIED` without statting arbitrary outside-root paths.
5. Read symlink metadata for in-root candidates.
6. Reject symlinks with `SYMLINK_DENIED`.
7. Reject directories and non-regular files with `UNSAFE_FILE_TYPE`.
8. Canonicalize the in-root regular-file candidate.
9. Require the canonical path to remain inside the workspace/allowed root.
10. Return workspace-relative `resolved_relative_path`, file size, and content
    identity.

This keeps absolute syntax liberal while actual file serving remains
conservative.

## Capability And Mixed Versions

Advertise a file capability such as:

```json
{
  "files": {
    "workspace_read": true,
    "roots": ["workspace"],
    "permissions": ["stat", "read", "range"],
    "resolve": {
      "absolute_posix": true
    }
  }
}
```

Service should not send `file_resolve` to daemons that do not advertise support.
Older daemons keep existing relative-path behavior.

## Error Codes

Use existing file error codes where possible:

| Error code | Meaning |
| --- | --- |
| `POLICY_DENIED` | Absolute path is outside allowed root or otherwise denied by policy. |
| `UNSAFE_PATH` | Syntax or normalized path shape is unsafe. |
| `SYMLINK_DENIED` | Candidate is a symlink. |
| `UNSAFE_FILE_TYPE` | Candidate is a directory or non-regular file. |
| `FILE_NOT_FOUND` | In-root candidate does not exist. |
| `LOCAL_READ_FAILED` | Local metadata/canonicalization failed unexpectedly. |

For outside-root absolute paths, prefer `POLICY_DENIED` with generic copy. Do
not reveal whether the outside-root target exists.

## Tests

Daemon tests:

- accepts absolute POSIX file under workspace root
- returns `resolved_against: "absolute_path"`
- returns workspace-relative `resolved_relative_path`
- returns content identity and size
- rejects absolute path outside workspace root as `POLICY_DENIED`
- rejects symlink absolute path as `SYMLINK_DENIED`
- rejects directory absolute path as `UNSAFE_FILE_TYPE`
- rejects Windows/backslash/URL/NUL inputs
- preserves current relative `file_open` behavior

## Files Likely Touched

- [../../bud/src/protocol.rs](../../bud/src/protocol.rs)
- [../../bud/src/proto_wire.rs](../../bud/src/proto_wire.rs)
- [../../bud/src/files/mod.rs](../../bud/src/files/mod.rs)
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md)
- [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto)
- [../../proto/bud/v1/v1.spec.md](../../proto/bud/v1/v1.spec.md)
- [../../docs/proto.md](../../docs/proto.md)
