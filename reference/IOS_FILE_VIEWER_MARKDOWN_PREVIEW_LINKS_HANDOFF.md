# iOS File Viewer Markdown Preview Links Handoff

**Status:** Questions for backend
**Last Updated:** 2026-05-10
**Audience:** Backend, iOS
**Related docs:** `reference/IOS_FILE_VIEWER_HANDOFF.md`, `reference/IOS_FILE_VIEWER_BACKEND_FOLLOWUP_RESPONSE.md`, `design/mobile-thread-file-viewer.md`

## Summary

iOS now renders Markdown files in the mobile file viewer. Markdown links inside
those previews are already visually rendered as links. Web links open Safari, but
local file links are currently discarded.

We want to support user-initiated navigation from a Markdown preview to another
file, with browser-like back navigation inside the file viewer modal.

Example Markdown rendered inside an opened file:

```md
- Related spec files:
  - [bud.spec.md](/Users/adam/bud/bud.spec.md)
  - [service/service.spec.md](/Users/adam/bud/service/service.spec.md)
  - [docs/proto.md](/Users/adam/bud/docs/proto.md)
```

## Proposed iOS Behavior

- Keep web links routed to Safari.
- Treat non-web Markdown links in Markdown previews as file-open requests.
- Preserve the raw link destination in the open request.
- Use `source.kind = "markdown_preview"` for preview-originated opens.
- Include the original assistant `message_id` / `client_id` when the current
  viewer entry has them.
- Keep path-context/debug metadata hidden.
- Maintain a client-side navigation stack so users can go back through opened
  files or close the whole modal.
- Continue rejecting obvious unsupported shapes client-side, including URLs,
  mailto links, NUL bytes, backslashes, and directory paths ending in `/`.

## Questions For Backend

### 1. Does `source.kind = "markdown_preview"` work today?

Can iOS send the existing open route request with:

```json
{
  "path": "/Users/adam/bud/docs/proto.md",
  "source": {
    "kind": "markdown_preview",
    "message_id": "original-assistant-message-id",
    "client_id": "original-assistant-client-id"
  }
}
```

If not, what source shape should mobile use for a file-open action that
originates from another opened file?

### 2. Do preview-originated opens need parent file context?

For audit, resolution, or authorization, does backend need any of these fields?

- parent `file_session_id`
- parent raw path
- parent resolved relative path
- parent viewer/source metadata

Absolute-path links may not need parent context, but relative links inside
Markdown previews likely will if we support them later.

### 3. Can mobile allow absolute POSIX paths?

Agents sometimes emit full system paths such as:

```text
/Users/adam/bud/service/src/routes/routes.spec.md
```

Can mobile treat absolute POSIX paths as clickable candidates and send the raw
absolute path to `/api/threads/:thread_id/files/open`, relying on backend/daemon
validation to allow only thread/workspace-scoped files?

iOS expectation:

- absolute path inside the allowed workspace opens normally
- absolute path outside allowed scope returns `denied` / `403`
- directory paths still return an unsupported/invalid-path style error
- mobile does not attempt to prove workspace containment locally

### 4. Should mobile normalize absolute paths for cache/display?

If backend accepts an absolute raw path, should iOS use the response
`file_session.path.relative_path` as the cache/display key, even when the request
path was absolute?

This matches current behavior for assistant-message file opens and keeps mobile
from maintaining its own workspace-root mapping.

## Requested Backend Response

Please confirm:

1. whether `markdown_preview` is accepted by the open route today;
2. whether parent file context is required or optional;
3. whether absolute POSIX paths are acceptable from mobile when backend enforces
   workspace scope;
4. expected error mappings for outside-scope absolute paths and directories.
