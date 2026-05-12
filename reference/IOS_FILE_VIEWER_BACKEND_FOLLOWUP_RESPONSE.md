# iOS File Viewer Backend Follow-up Response

**Status:** Backend response
**Last Updated:** 2026-05-08
**Audience:** Backend, iOS
**Related docs:** `reference/IOS_FILE_VIEWER_BACKEND_FOLLOWUP.md`, `reference/IOS_FILE_VIEWER_HANDOFF.md`, `plan/file-viewer/pr-summary.md`, `docs/proto.md`

## Summary

The mobile implementation plan in
`reference/IOS_FILE_VIEWER_BACKEND_FOLLOWUP.md` matches the intended backend
contract:

```text
assistant message path
  -> user tap
  -> POST /api/threads/:thread_id/files/open
  -> HEAD file_session.file_url
  -> GET file_session.file_url
  -> render Markdown, code, or plain UTF-8 text
```

Mobile should continue to keep the feature user-initiated, assistant-message
only, and thread-scoped. Mobile should not send cwd/path-context fields, should
include `source.message_id` whenever available, and should keep
`display_metadata.path_context` hidden.

## 1. `HEAD` `content-length`

Backend answer: yes, for successful first-pass file edge `HEAD` responses, iOS
can treat `content-length` as the file's raw byte size and use it to enforce the
1 MiB display cap before `GET`.

Current implementation details:

- `HEAD /api/files/:file_session_id` sends daemon `file_open` with
  `mode: "stat"`.
- Bud resolves and validates the file, reads metadata, and returns:
  - `status_code: 200`
  - `content-length: <raw file byte size>`
  - `accept-ranges: bytes`
  - `content-type: application/octet-stream`
  - `etag`
- The service allowlists and forwards `content-length`.
- `HEAD` does not return a response body.
- `HEAD` does not apply the 1 MiB viewer cap by itself. Large files should
  still return a successful `HEAD` with a large `content-length`; clients should
  skip `GET` and show too-large.

Expected edge cases:

| Case | Expected mobile behavior |
| --- | --- |
| `content-length: 0` | Valid empty file. `GET` is allowed and should render empty text if UTF-8 decode succeeds. |
| Missing `content-length` on `2xx HEAD` | Treat as backend/protocol error for this first pass; do not issue uncapped `GET`. |
| Invalid or non-integer `content-length` | Treat as backend/protocol error; do not issue uncapped `GET`. |
| `content-length > viewer.max_display_bytes` | Skip `GET`; show too-large. |
| Compressed response | Not expected for file edge. The file edge returns raw bytes with no `content-encoding`. |
| `HEAD` returns `403`, `404`, `410`, `413`, `424`, `503`, or `504` | Map using the existing handoff state table. |

iOS does not need capped streaming reads for the first implementation. If a
future proxy/CDN layer starts altering `content-length` or applying compression
to `/api/files/*`, backend should treat that as a deployment bug and exclude
file edge responses from compression.

## 2. `viewer.suggested_kind`

Backend answer: use `viewer.suggested_kind` and `viewer.language` as the primary
rendering hints, but treat them as hints rather than a universal file-type
oracle.

Current backend behavior:

- `.md`, `.markdown`, and `.mdx` return `suggested_kind: "markdown"`.
- Known source extensions return `suggested_kind: "code"` plus a `language`
  when mapped.
- Unknown extensions currently return `suggested_kind: "unknown"`.
- Backend does not inspect file contents during the open route.
- Binary/UTF-8 detection still belongs after `GET` on the client.

Recommended iOS rendering rule:

1. If UTF-8 decode fails or decoded text contains NUL, show unsupported binary.
2. If `viewer.suggested_kind == "markdown"`, render Markdown.
3. If `viewer.suggested_kind == "code"`, render code using `viewer.language`
   when present.
4. Otherwise render decoded UTF-8 as plain text.

iOS does not need a broad extension map. A small defensive Markdown check for
`.md`, `.markdown`, and `.mdx` is acceptable, but backend should already return
Markdown for those extensions. A broad mobile-maintained source extension map is
not required for the first pass.

## 3. Telemetry

Backend answer: there is no required backend telemetry ingestion contract for
the mobile file viewer today. If iOS emits product/client telemetry, use stable
client event names and avoid sending raw file paths to general analytics.

Recommended event names:

- `file_viewer_affordance_tapped`
- `file_viewer_open_succeeded`
- `file_viewer_content_ready`
- `file_viewer_failed`
- `file_viewer_reload_tapped`
- `file_viewer_copy_path_tapped`
- `file_viewer_copy_content_tapped`
- `file_viewer_dismissed`

Recommended common metadata:

- `thread_id`
- `message_id`, when available
- `client_id`, when available
- `source_kind`
- `source_surface` if iOS distinguishes Markdown link vs inline code
- `viewer_kind`
- `language`
- `has_line`
- `has_column`
- `file_extension`
- `session_reused`
- `duration_ms` for open/content-ready/failure events where available

Recommended failure metadata:

- `failure_stage`: `parse`, `open`, `head`, `get`, `decode`, `render`
- `error_kind`: app-level UI state such as `invalid_path`, `not_found`,
  `denied`, `too_large`, `expired`, `offline`, `content_changed`,
  `unsupported_binary`, or `error`
- `http_status`, when the failure came from HTTP
- `retryable`, if the client can infer it from the state

Recommended size metadata:

- `content_length_bucket`, not exact size, for example:
  - `0`
  - `1-4KiB`
  - `4-64KiB`
  - `64-256KiB`
  - `256KiB-1MiB`
  - `>1MiB`

Avoid in general analytics:

- `raw_path`
- `relative_path`
- `display_metadata.path_context`
- `host_cwd`
- file contents
- copied path or copied content

`file_session_id` is acceptable for internal debug logs that stay in our
controlled backend/client logging systems, but avoid sending it to third-party
product analytics unless we explicitly decide those systems may receive
capability-adjacent identifiers.

## 4. Session Revoke

Backend answer: TTL-only cleanup is acceptable for the first mobile viewer.
Mobile does not need to revoke a file session when the viewer closes.

Current session behavior:

- Thread-created viewer sessions currently use a 15 minute TTL.
- Expired sessions return `410`.
- Revoked sessions return `410`.
- Reload should create a fresh session.
- `409`, `410`, and missing local session should create a fresh session.

There is already an authenticated revoke route:

```http
DELETE /api/file-sessions/:file_session_id
Content-Type: application/json
Authorization: cookie session or bearer token
```

Optional body:

```json
{
  "reason": "user_requested"
}
```

Expected behavior:

- unauthenticated returns `401`
- non-owner or unknown session returns `404`
- success returns the serialized revoked file session
- subsequent `HEAD` / `GET` on the session returns `410`

Recommendation for iOS first pass:

- Do not call revoke on normal viewer close or navigation away.
- Rely on TTL.
- Create a fresh session on reload, expiry, `410`, `409`, or missing session.
- Consider explicit revoke later only if product wants a "close all file
  sessions now" privacy/security control.

## Confirmed Mobile Plan

Backend agrees with these iOS decisions:

- file actions are assistant-message only in the first pass
- file links can wait for persisted backend `message_id`
- mobile does not send cwd/path-context fields
- `display_metadata.path_context` remains hidden
- binary/image/PDF/directory/large-file paging remain deferred
- invalid UTF-8 or NUL text maps to unsupported binary
- `file_session.file_url` should be same-origin with the configured API base URL
  before attaching a bearer token
- raw path should be preserved in the open request, while mobile can normalize
  separately for cache/display keys

## Source Trail

Most relevant backend files:

- `service/src/routes/threads/files.ts`
- `service/src/routes/files.ts`
- `service/src/files/file-session.ts`
- `service/src/files/file-edge.ts`
- `bud/src/files/mod.rs`
