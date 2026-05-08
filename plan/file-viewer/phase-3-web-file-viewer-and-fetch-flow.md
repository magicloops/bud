# Phase 3: Web File Viewer And Fetch Flow

## Priority

High

## Goal

Add the reference web viewer that opens a clicked file in the thread workspace right pane and renders text, Markdown, or code through the service file edge.

## Scope

In scope:

- `file` workspace view mode
- thread-route file viewer state
- open/reuse/reload session flow
- `HEAD` metadata request
- `GET` content request
- 1 MiB display cap behavior
- Markdown/code/plain rendering
- unsupported-binary handling
- copy path and copy content controls
- viewer error states

Out of scope:

- tabs as visible UI
- large-file pagination
- image/PDF/binary preview
- absolute path resolver
- file editing
- directory browsing

## State Model

Use a state shape that supports one visible active file now without blocking future tabs:

```ts
type FileViewerEntryKey = string;

type FileViewerEntry = {
  key: FileViewerEntryKey;
  raw_path: string;
  relative_path: string;
  line?: number;
  column?: number;
  file_session_id?: string;
  file_url?: string;
  expires_at?: string;
  status:
    | "creating_session"
    | "loading_metadata"
    | "loading_content"
    | "ready"
    | "not_found"
    | "denied"
    | "too_large"
    | "expired"
    | "offline"
    | "content_changed"
    | "unsupported_binary"
    | "error";
  metadata?: {
    size?: number;
    content_type?: string;
    etag?: string;
    last_modified?: string;
  };
  content?: string;
  viewer_kind?: "markdown" | "code" | "text";
  language?: string;
  error_message?: string;
};

type FileViewerState = {
  active_key?: FileViewerEntryKey;
  entries_by_key: Record<FileViewerEntryKey, FileViewerEntry>;
};
```

The first UI can render only `active_key`. Repeated clicks should reuse an entry with a still-valid session for the same normalized root/path. If the entry is expired, revoked, or missing a usable session, create a fresh session.

## Fetch Flow

1. User clicks a Phase 2 file action.
2. If a valid entry/session exists, activate it.
3. Otherwise set status `creating_session`.
4. Call `POST /api/threads/:thread_id/files/open`.
5. Store returned `file_session` and viewer hints.
6. Set status `loading_metadata`.
7. `HEAD /api/files/:file_session_id`.
8. If size exceeds 1 MiB, set `too_large`.
9. Set status `loading_content`.
10. `GET /api/files/:file_session_id`.
11. Decode as UTF-8 only if bytes pass text sniffing.
12. Choose Markdown, code, or plain text.
13. Set status `ready`.

The viewer should not rely only on response `Content-Type`; the file foundation may return generic byte content.

## Viewer Selection

Recommended order:

1. Reject invalid UTF-8 or NUL-heavy data as `unsupported_binary`.
2. Use `.md`, `.markdown`, and `.mdx` as Markdown.
3. Use known source/config extensions as code.
4. Use text-like unknown extensions as plain text.

Code language can come from extension-based mapping. Unknown text can render as plain text.

## UI Behavior

The viewer lives in the thread workspace right pane:

- opening a file switches view mode to `file`
- closing returns to the prior mode or `terminal`
- reload creates or reuses a current session and re-fetches content
- copy path copies the display path
- copy content is enabled only for text content
- line/column are displayed or retained internally but do not need scroll/highlight behavior yet

Use existing rendering primitives where they fit:

- existing Markdown renderer for Markdown preview
- existing code block/highlighter for source
- plain preformatted text for unknown text

Avoid nesting the viewer in extra decorative cards. The pane should behave like a workspace tool surface.

## Error State Mapping

Map backend/file-edge outcomes into stable viewer states:

- `400 invalid_file_path`: path outside first-pass scope or invalid
- `401`: auth expired; route to existing auth-expiry behavior if present
- `403` or daemon policy denial if exposed: `denied`
- `404`: `not_found` or `denied` depending on response code semantics
- `410`: `expired`
- `413`: `too_large`
- `416`: range/content mismatch; `content_changed` when applicable
- `424`: `offline`
- invalid UTF-8 or binary sniff: `unsupported_binary`
- network or unexpected errors: `error`

The UI copy should be concise and stateful. Do not expose raw host paths or daemon internals.

## Markdown Preview Links

Clickable file references inside opened Markdown previews are desirable. Include them in Phase 3 only if the implementation can reuse the same file-action component without creating recursive state complexity.

If it becomes expensive, defer to Phase 4 follow-up. The first viewer is complete without recursive Markdown file references.

## Tests

Add coverage for:

- open action switches the workspace to file mode
- still-valid repeated click reuses existing entry
- expired repeated click creates a fresh session
- `HEAD` over cap shows too-large state without `GET`
- Markdown file renders Markdown view
- source file renders code view
- unknown UTF-8 file renders plain-text view
- binary bytes show unsupported state
- `404`, `410`, `413`, and `424` map to stable states
- reload refreshes the session/content
- close returns to a non-file workspace mode
- copy path/content actions work where enabled

## Docs And Specs

Update when implementing:

- `web/src/src.spec.md`
- `web/src/components/components.spec.md` or more specific child specs if a viewer folder is added
- `web/src/routes/` folder spec for thread route state behavior
- this plan's progress and validation checklists

## Completion Gate

- [ ] Web thread route has a file workspace mode.
- [ ] Viewer fetches metadata and content through service file routes.
- [ ] Viewer renders Markdown, code, and text.
- [ ] Viewer handles first-pass error states.
- [ ] Repeated click behavior matches the session reuse decision.
- [ ] Viewer controls cover close, reload, copy path, and copy content.
