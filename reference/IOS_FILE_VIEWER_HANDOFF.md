# iOS File Viewer Backend Handoff

**Status:** Web validated, mobile-ready contract  
**Last Updated:** 2026-05-05  
**Audience:** Backend and iOS  
**Related docs:** `plan/file-viewer/implementation-spec.md`, `plan/improve-file-cwd/implementation-spec.md`, `design/file-serving-user-initiated-viewer.md`, `design/daemon-owned-file-path-resolution.md`, `docs/proto.md`

## Summary

The file viewer is a user-initiated workflow for opening file paths referenced in assistant messages. Mobile should use the thread-scoped product route, then read bytes through the existing file edge:

```text
assistant message path -> user taps file action
  -> POST /api/threads/:thread_id/files/open
  -> HEAD /api/files/:file_session_id
  -> GET /api/files/:file_session_id
  -> render Markdown, code, or plain UTF-8 text
```

Do not use the Bud-scoped low-level file-session create route for this product flow. The thread route owns authorization, derives the Bud from the owned thread, stamps the session owner, and provides the metadata needed by a viewer.

## Scope

Current first pass:

- user-clicked files only; the agent does not get file-read authority
- assistant-message file references only
- workspace-relative path inputs only
- current terminal directory first, Bud workspace fallback, with no new mobile request fields
- 1 MiB display cap
- Markdown, source/code, and plain text previews
- binary, image, PDF, directory, and large-file viewers deferred
- line and column metadata carried, but no required scroll/highlight behavior yet

Deferred:

- absolute paths and `~/...`
- basename search or disambiguation
- recursive clickable file links inside opened Markdown previews
- server-assisted path detection
- structured file-reference message metadata

## Open Route

```http
POST /api/threads/:thread_id/files/open
Content-Type: application/json
Authorization: cookie session or bearer token
```

Request:

```json
{
  "path": "./service/src/files/file-session.ts:42:7",
  "source": {
    "kind": "assistant_message",
    "message_id": "22222222-2222-4222-8222-222222222222",
    "client_id": "33333333-3333-4333-8333-333333333333",
    "text_range": {
      "start": 120,
      "end": 153
    }
  },
  "viewer_intent": "preview"
}
```

`source` is display/audit metadata only. It does not authorize the read.

Allowed `source.kind` values:

- `assistant_message`
- `markdown_preview`
- `unknown`

Optional request fields:

- `line`: positive integer; overrides line parsed from `path`
- `column`: positive integer; overrides column parsed from `path`

Response `201`:

```json
{
  "file_session": {
    "file_session_id": "fs_01H...",
    "bud_id": "b_01H...",
    "thread_id": "11111111-1111-4111-8111-111111111111",
    "root": { "key": "workspace" },
    "path": {
      "raw_path": "./service/src/files/file-session.ts:42:7",
      "relative_path": "service/src/files/file-session.ts"
    },
    "permissions": ["stat", "read", "range"],
    "state": "ready",
    "file_url": "https://service.example/api/files/fs_01H...",
    "max_bytes": 1048576,
    "content_identity": null,
    "expires_at": "2026-05-01T20:15:00.000Z",
    "revoked_at": null,
    "display_metadata": {
      "raw_path": "./service/src/files/file-session.ts:42:7",
      "source": {
        "kind": "assistant_message",
        "message_id": "22222222-2222-4222-8222-222222222222",
        "client_id": "33333333-3333-4333-8333-333333333333",
        "text_range": {
          "start": 120,
          "end": 153
        }
      },
      "line": 42,
      "column": 7,
      "viewer_intent": "preview"
    }
  },
  "viewer": {
    "suggested_kind": "code",
    "language": "typescript",
    "display_name": "file-session.ts",
    "line": 42,
    "column": 7,
    "max_display_bytes": 1048576
  }
}
```

Notes:

- `file_session.file_url` is the URL to use for `HEAD` and `GET`.
- The open route validates path shape and creates a short-lived session. File existence and local policy failures normally surface during `HEAD` / `GET`.
- Sessions currently use a 15 minute TTL.

## File Edge Reads

Metadata:

```http
HEAD /api/files/:file_session_id
Authorization: cookie session or bearer token
```

Content:

```http
GET /api/files/:file_session_id
Authorization: cookie session or bearer token
```

Mobile should:

- issue `HEAD` before `GET`
- use `content-length` from `HEAD` to enforce the 1 MiB display cap before downloading
- use `content-type`, `etag`, and `last-modified` as optional display/cache metadata
- decode `GET` bytes as UTF-8 with fatal/erroring decode
- treat invalid UTF-8 or NUL-containing text as unsupported binary
- render `.md`, `.markdown`, and `.mdx` as Markdown
- render known source extensions as code
- render other UTF-8 content as plain text

Optional range reads exist through `Range` on `GET /api/files/:file_session_id`, but the first mobile viewer can avoid ranges and use full-file `GET` under the 1 MiB cap.

## Auth And Ownership

Expected behavior:

- unauthenticated requests return `401`
- signed-in non-owner thread/session requests return `404`
- the client never supplies or chooses the Bud id for the thread open route
- file edge reads authorize by `file_session.created_by_user_id`
- daemon policy remains the final filesystem gate

## Path Rules

Accepted first-pass forms:

- `README.md`
- `service/src/files/file-session.ts`
- `./web/src/lib/api.ts`
- `README.md:12`
- `README.md:12:4`
- `README.md#L12`
- `README.md#L12-L20`

Rejected first-pass forms:

- absolute POSIX paths such as `/Users/adam/bud/README.md`
- home-relative paths such as `~/secrets.txt`
- parent traversal such as `../outside.txt` or `service/../outside.txt`
- Windows drive paths
- backslashes
- URLs and `mailto:` links
- email addresses
- NUL bytes
- directory paths ending in `/`

Parser guidance:

- For the first mobile pass, detect explicit local Markdown links and inline-code path candidates.
- Keep plain-text prose detection conservative or disabled. Web currently ships explicit actions for Markdown links and inline-code candidates, not broad prose scanning.
- Normalize a leading `./` away for the session key/display path.
- Preserve the raw display path for the open request and audit metadata.

## Current Directory Resolution

Mobile does not need to send cwd or terminal context.

For thread-created file sessions, the service includes the active thread terminal session id when it sends daemon `file_open`. The daemon then tries:

1. path relative to the fresh tmux pane current directory
2. path relative to the Bud workspace root

If no terminal session exists, the pane cwd is unavailable, the cwd is outside the workspace root, or the file is missing from the cwd candidate, the daemon falls back to workspace-root resolution. The API does not expose raw absolute cwd.

## UI State Mapping

Recommended mobile state mapping:

| HTTP / condition | UI state |
| --- | --- |
| `400` from open route | Invalid path |
| `401` | Auth/session expired; follow app auth handling |
| `403` from file edge | Denied/outside scope |
| `404` from open route | Thread inaccessible or missing |
| `404` from file edge | File/session not found |
| `410` | Session expired or revoked; create a fresh session on retry |
| `413` | File too large |
| `409` | Content changed; create a fresh session on retry |
| `416` | Range/content mismatch if using range reads |
| `424` or `503` | Bud/file transport offline |
| `504` | File open timed out; retryable error |
| invalid UTF-8 or NUL text | Unsupported binary |
| other `5xx` | Generic recoverable error |

## Session Reuse

Use the normalized relative path as the stable key, for example:

```text
workspace:service/src/files/file-session.ts
```

Recommended behavior:

- if a ready entry has a non-expired session, route the user back to that entry
- if the session is expired, revoked, missing, or the user taps reload, call the open route again
- if a future tabbed viewer exists, clicking an already-open file should select that tab
- keep line/column on the entry so future scroll/highlight behavior can be added without changing the backend contract

## Validation Checklist

Before mobile marks the feature done:

- Markdown local links expose a file-open affordance.
- Inline-code file references expose a file-open affordance.
- User/tool/system messages do not expose first-pass file actions unless a later design changes scope.
- Opening a valid relative file creates a session only after tap.
- `HEAD` succeeds before `GET`.
- The file renders as Markdown/code/plain text as expected.
- Repeated tap reuses an existing valid entry.
- Reload creates a fresh session and re-fetches bytes.
- Closing the viewer returns to the prior thread surface.
- `src/...` paths work after the terminal has `cd`'d into a project subdirectory.
- Absolute, home-relative, traversal, URL, and Windows paths are inert or show invalid-path behavior.
- Too-large, denied, missing, expired, offline, and binary states render distinctly.
- Copy path and copy content behavior are explicit and do not overlap.

## Source Trail

Most useful backend/web references:

- `service/src/routes/threads/files.ts`
- `service/src/routes/files.ts`
- `service/src/files/file-session.ts`
- `service/src/files/file-edge.ts`
- `web/src/lib/file-paths.ts`
- `web/src/features/threads/use-file-viewer.ts`
- `web/src/components/workbench/file-viewer-pane.tsx`
- `web/src/components/message-renderers/roles/markdown-content.tsx`

Planning and protocol references:

- `plan/file-viewer/implementation-spec.md`
- `plan/file-viewer/validation-checklist.md`
- `plan/improve-file-cwd/implementation-spec.md`
- `plan/improve-file-cwd/validation-checklist.md`
- `docs/proto.md`
