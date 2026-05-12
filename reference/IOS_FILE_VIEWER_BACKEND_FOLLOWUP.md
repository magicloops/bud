# iOS File Viewer Backend Follow-up

**Status:** Needs backend response  
**Last Updated:** 2026-05-08  
**Audience:** Backend, iOS  
**Related docs:** `reference/IOS_FILE_VIEWER_HANDOFF.md`, `design/mobile-thread-file-viewer.md`

## Summary

iOS reviewed the file viewer handoff and drafted the mobile implementation design. The core contract looks workable:

```text
assistant message path
  -> user tap
  -> POST /api/threads/:thread_id/files/open
  -> HEAD file_session.file_url
  -> GET file_session.file_url
  -> render Markdown, code, or plain UTF-8 text
```

The first mobile implementation will stay user-initiated and thread-scoped. iOS will not use a Bud-scoped low-level file-session creation route, will not send cwd/path-context fields, and will not expose file actions until an assistant message has a persisted backend `message_id`.

## Mobile Decisions

- File actions are assistant-message only in the first pass.
- File links are not clickable during streaming before backend `message_id` is available.
- Inline-code file references will be made directly tappable by extending `StreamingMarkdownUI`; iOS will not use below-message chips for the first pass.
- `StreamingMarkdownUI` will expose a narrow public code-view wrapper so file code previews can reuse Prism-backed highlighting.
- Mobile will reject path candidates with spaces or non-ASCII characters in the first pass.
- Mobile will keep `display_metadata.path_context` entirely hidden for now.
- Mobile will rely on file-session TTL unless backend says a revoke route is required.

## Questions For Backend

### 1. `HEAD` `content-length`

Can the file edge guarantee a usable `content-length` header on `HEAD /api/files/:file_session_id` for all supported first-pass text files?

iOS plan:

- If yes, iOS will enforce the 1 MiB display cap from `HEAD` and skip `GET` when too large.
- If no, iOS needs to implement capped streaming reads and cancel once the display cap is exceeded.

Please confirm the expected behavior for missing, zero, compressed, or otherwise unreliable `content-length`.

### 2. `viewer.suggested_kind`

Is `viewer.suggested_kind` authoritative enough for iOS to choose Markdown, code, or plain text without maintaining a broad extension map?

iOS plan:

- Prefer `viewer.suggested_kind` and `viewer.language`.
- Keep a small defensive extension check for `.md`, `.markdown`, `.mdx`, and common source extensions unless backend confirms the viewer metadata is authoritative.

Please confirm whether backend intends `suggested_kind` to be canonical for first-pass mobile rendering.

### 3. Telemetry

What telemetry events and metadata should iOS emit for the file viewer?

Proposed event moments:

- file affordance tapped
- open route succeeded
- viewer content ready
- viewer failed
- reload tapped
- copy path tapped
- copy content tapped
- viewer dismissed

Proposed metadata:

- `thread_id`
- `message_id`
- `client_id`
- `raw_path`
- `relative_path`
- `viewer_kind`
- `language`
- `line`
- `column`
- `error_kind`
- `http_status`
- `file_session_id`

Please confirm event names and any metadata that should be omitted or added.

### 4. Session revoke

Is there or will there be a file-session revoke route?

iOS plan:

- Rely on the current 15 minute TTL.
- Create a fresh session on reload, expiry, `410`, `409`, or missing session.
- Do not attempt explicit revoke on viewer close unless backend provides and wants that route used.

Please confirm whether TTL-only cleanup is acceptable for mobile.

## FYI Constraints

- Images, videos, PDFs, directories, binary files, recursive local links inside Markdown previews, and large-file paging are deferred.
- iOS will treat invalid UTF-8 or NUL-containing content as unsupported binary.
- iOS will validate that `file_session.file_url` is same-origin with the configured API base URL before attaching the bearer token.
- iOS will preserve raw path in the open request and normalize only for cache/display keys.
