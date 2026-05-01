# Phase 1: Thread Open Route And Contract

## Priority

Urgent

## Goal

Add the backend product entry point for user-initiated file viewing:

```text
POST /api/threads/:thread_id/files/open
```

The route should turn a raw relative path candidate from a clicked assistant-message reference into an authorized, viewer-scoped `file_session`.

## Scope

Phase 1 is backend-only. It does not add web path detection or a viewer.

In scope:

- thread-scoped route registration
- request validation
- ownership-aware thread lookup
- relative-path parsing and normalization
- line/column suffix extraction
- viewer defaults for TTL and max bytes
- session creation through the existing file-session service helper
- response serialization for web and mobile clients
- route tests and documentation/spec updates

Out of scope:

- absolute path support
- daemon-owned `file_resolve`
- agent file tools
- binary/image/PDF preview
- directory listing
- range-paged large-file viewing

## Request Schema

```ts
type OpenThreadFileRequest = {
  path: string;
  source?: {
    kind?: "assistant_message" | "markdown_preview" | "unknown";
    message_id?: string;
    client_id?: string;
    text_range?: {
      start: number;
      end: number;
    };
  };
  line?: number;
  column?: number;
  viewer_intent?: "preview";
};
```

Validation rules:

- `path` is required, non-empty, and bounded to a small string limit such as 4 KiB.
- `line` and `column`, when present, are positive integers.
- `source.text_range`, when present, uses non-negative offsets with `end >= start`.
- Unknown `viewer_intent` values return `400`.
- Unknown `source.kind` values can be normalized to `unknown` or rejected; pick one behavior and document it.

## Path Normalization

Accepted:

- `README.md`
- `service/src/files/file-session.ts`
- `./service/src/files/file-session.ts`
- `src/main.rs:12`
- `src/main.rs:12:4`
- `web/src/lib/api.ts#L42`
- `web/src/lib/api.ts#L42-L48` with line start retained only

Rejected:

- `/Users/adam/bud/service/src/files/file-session.ts`
- `/etc/passwd`
- `~/secrets.txt`
- `../outside.txt`
- `service/../outside.txt`
- `C:\Users\adam\file.txt`
- `https://example.com/file.ts`
- `mailto:test@example.com`
- paths containing NUL bytes
- empty paths after suffix stripping
- obvious directory references such as `service/src/` when the route can identify them

The server should normalize leading `./`, collapse safe `.` path segments, reject parent traversal, and store the final target as a POSIX workspace-relative path.

If `line` / `column` are supplied both in the request body and in the path suffix, the explicit body fields should win after validation. The raw path string should still be retained in metadata for audit/display.

## Route Behavior

Implementation outline:

1. Call `requireViewer(...)`.
2. Resolve the thread through the same ownership-aware path used by other thread routes.
3. Derive `bud_id` from the authorized thread.
4. Parse the request path into `raw_path`, `relative_path`, optional `line`, and optional `column`.
5. Reject unsupported paths with a stable `400 invalid_file_path` response.
6. Call the existing file-session creation helper with:
   - `bud_id` from the thread
   - `thread_id` from the route param
   - `created_by_user_id` from the authenticated viewer/thread owner
   - `root_key: "workspace"`
   - normalized `relative_path`
   - permissions `["stat", "read", "range"]`
   - viewer `max_bytes: 1048576`
   - short viewer TTL, matching or tightening the current low-level session TTL
   - display/source metadata where the existing model supports it
7. Return serialized `file_session` plus `viewer` hints.

The route should not perform `HEAD` or `GET` itself. File metadata and bytes continue to flow through:

```text
HEAD /api/files/:file_session_id
GET /api/files/:file_session_id
```

## Response And Error Contract

Success: `200` or `201`. Prefer the status already used by low-level file-session create if it is consistent.

Errors:

- `400 invalid_file_path` for unsupported path forms
- `400 invalid_request` for schema failures
- `401` for unauthenticated requests
- `404` for a signed-in user who cannot access the thread
- `424` only when session creation depends on an unavailable daemon/carrier and the existing file-session helper returns that shape
- `500` for unexpected internal failures

Use snake_case fields at the REST boundary.

## Viewer Hints

The route can include lightweight viewer hints without becoming the file-type authority:

```ts
type ViewerHint = {
  suggested_kind: "markdown" | "code" | "text" | "unknown";
  language?: string;
  display_name: string;
  line?: number;
  column?: number;
  max_display_bytes: 1048576;
};
```

The web client should still sniff fetched bytes before rendering.

## Tests

Add route coverage for:

- unauthenticated request returns `401`
- non-owner thread returns `404`
- owned thread creates a session stamped with the viewer/thread owner
- route derives Bud from thread, not request body
- accepted relative paths normalize correctly
- line and column suffixes are parsed
- explicit `line` / `column` body fields win over suffix values
- absolute, home, parent traversal, Windows, URL, NUL, and empty paths return `400`
- viewer `max_bytes` is `1048576`
- source metadata is persisted or returned according to the chosen storage surface

## Docs And Specs

Update when implementing:

- `docs/proto.md` for the new browser/mobile REST route
- `service/src/routes/routes.spec.md`
- `service/src/files/files.spec.md`
- this plan's progress and validation checklists

## Completion Gate

- [ ] Route is registered and ownership-aware.
- [ ] Route accepts only first-pass relative paths.
- [ ] Route creates viewer-scoped file sessions with 1 MiB cap.
- [ ] Route tests cover auth, ownership, path validation, defaults, and metadata.
- [ ] Docs/specs describe the shipped contract.
