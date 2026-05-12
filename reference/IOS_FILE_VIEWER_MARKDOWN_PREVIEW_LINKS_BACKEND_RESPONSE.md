# iOS File Viewer Markdown Preview Links Backend Response

**Status:** Backend response, Phase 7 implemented on this branch
**Last Updated:** 2026-05-11
**Audience:** Backend, iOS
**Related docs:** `reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_HANDOFF.md`, `reference/IOS_FILE_VIEWER_HANDOFF.md`, `reference/IOS_FILE_VIEWER_BACKEND_FOLLOWUP_RESPONSE.md`, `plan/file-viewer/phase-7-absolute-path-opens.md`

## Summary

The proposed mobile behavior is aligned with the backend direction:

- web links should keep opening outside Bud, such as Safari on iOS
- non-web Markdown-preview links can become user-initiated file opens
- `source.kind = "markdown_preview"` is the right source kind
- mobile should preserve the raw Markdown link destination in the open request
- mobile should not send cwd/path-context fields
- `display_metadata.path_context` should remain hidden

The blocking backend gap for absolute POSIX paths is addressed on this branch.
The open route accepts `source.kind = "markdown_preview"` and now preflights
absolute POSIX paths through the Bud daemon before creating a normalized file
session.

## 1. Does `source.kind = "markdown_preview"` work today?

Yes, the thread file-open route accepts:

```json
{
  "source": {
    "kind": "markdown_preview",
    "message_id": "original-assistant-message-id",
    "client_id": "original-assistant-client-id"
  }
}
```

Backend behavior today:

- `source.kind = "markdown_preview"` is accepted by request validation.
- `source.message_id`, when present and owned by the same thread/user, is used
  to load server-stamped `metadata.path_context` for relative opens.
- `source` remains display/audit metadata; it does not authorize the file read.
- Absolute POSIX paths are resolved by daemon `file_resolve` before session
  creation; the daemon remains the filesystem policy gate during `HEAD` / `GET`.

Recommendation for iOS:

- Use `source.kind = "markdown_preview"` for links tapped inside a rendered
  Markdown file.
- Include the original assistant `message_id` / `client_id` when the current
  viewer entry has them.
- Continue waiting for a persisted backend `message_id` before exposing file
  actions that depend on source-message context.

## 2. Do preview-originated opens need parent file context?

For absolute POSIX links, no parent file context is required.

An absolute path carries its own host path candidate. Once backend support lands,
the daemon will canonicalize that path and allow it only if it is under the
daemon's configured file-viewer policy root.

For future relative Markdown-preview links, parent context will matter. Examples:

```md
[Sibling](./sibling.md)
[Parent](../README.md)
```

Those links should resolve relative to the currently opened Markdown file, not
necessarily the original assistant message cwd. That needs an explicit backend
contract extension. A likely future shape is:

```json
{
  "source": {
    "kind": "markdown_preview",
    "message_id": "original-assistant-message-id",
    "client_id": "original-assistant-client-id",
    "parent_file_session_id": "fs_01H..."
  }
}
```

Do not send `parent_file_session_id` yet. The current route schema does not
accept or use it. For now, mobile can keep parent session/path data in its local
navigation stack for UI back behavior.

## 3. Can mobile allow absolute POSIX paths?

Yes, once this backend branch is deployed. Mobile can treat absolute POSIX paths
as clickable local-file candidates and send the raw absolute path to:

```http
POST /api/threads/:thread_id/files/open
```

Expected behavior:

- absolute path under the daemon's allowed root opens normally
- absolute path outside allowed scope returns denied / `403`
- absolute path to a missing file under allowed scope returns not found / `404`
- absolute path to a directory returns invalid or denied depending on where it
  is rejected
- mobile does not attempt to prove workspace containment locally

Recommended mobile gating:

- Keep web URLs and `mailto:` routed away from file viewer.
- Keep rejecting NUL bytes, backslashes, Windows drive paths, and directory
  paths ending in `/`.
- Allow absolute POSIX paths only once this backend support is available in the
  target environment.
- Continue preserving the raw path in the open request.

## 4. Should mobile normalize absolute paths for cache/display?

Yes. Use the response `file_session.path.relative_path` as the normalized
cache/display path.

Recommended mobile behavior:

- request `path`: preserve the raw Markdown link destination
- display/cache key: prefer `file_session.root.key + file_session.path.relative_path`
- display label: use `viewer.display_name` or the basename
- navigation stack entry: keep `file_session_id`, raw path, normalized relative
  path, source metadata, and line/column

For absolute-path opens, mobile does not need to include `source.message_id` in
the reuse key unless the product wants separate navigation entries per source.
The backend-normalized `root + relative_path` is enough to identify the resolved
file under the current single-root policy.

For context-sensitive relative opens, source-aware keying remains important
because the same relative path can resolve differently from different
message-time cwd contexts.

## Expected Error Mapping

| Condition | HTTP / route state | Mobile UI state |
| --- | --- | --- |
| Absolute path under allowed root, regular file | `201`, then `HEAD 200` | Open normally |
| Absolute path outside allowed root | `403` | Denied/outside scope |
| Absolute path under allowed root but missing | `404` | Not found |
| Path ends in `/` | `400` from open route | Invalid path / directory unsupported |
| Existing directory without trailing `/` | `403` from daemon policy | Denied / directory unsupported |
| Symlink | `403` | Denied |
| Non-regular file | `403` | Denied / unsupported file type |
| URL or `mailto:` accidentally sent to open route | `400` | Invalid path |
| Windows drive path or backslash path | `400` | Invalid path |
| File over 1 MiB | `HEAD 200` with large `content-length`; client skips `GET`, or `GET 413` if attempted | Too large |
| Bud/file transport unavailable | `424` or `503` | Offline / unavailable |

## Backend Support

The implemented backend work is captured in
`plan/file-viewer/phase-7-absolute-path-opens.md` plus the 7a/7b/7c subphase
docs.

The important backend guarantee for mobile is:

- service/mobile can pass a raw absolute POSIX path
- daemon resolves and canonicalizes it
- daemon serves it only when the canonical target is under the configured
  allowed root and is a regular non-symlink file
- response returns a normalized `file_session.path.relative_path`

Until this branch is available in a target environment, mobile should keep
absolute POSIX Markdown-preview links visually inert or show an unsupported-path
state rather than sending them to older open routes.
