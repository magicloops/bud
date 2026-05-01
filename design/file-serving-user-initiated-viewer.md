# Design: User-Initiated Host File Viewer

Status: Draft

Audience: Backend, web platform, iOS, and product

Last updated: 2026-05-01

Implementation plan: [../plan/file-viewer/implementation-spec.md](../plan/file-viewer/implementation-spec.md)

## Context

The `network-upgrade` work left Bud with a daemon/service file-stream foundation:

- browser-authenticated `file_session` rows
- `POST /api/buds/:bud_id/file-sessions`
- `GET /api/file-sessions/:file_session_id`
- `DELETE /api/file-sessions/:file_session_id`
- `HEAD /api/files/:file_session_id`
- `GET /api/files/:file_session_id`
- daemon `file_open` handling for `stat`, `read`, and single byte-range `range`
- WebSocket-first carrier selection, with optional HTTP/2 data and future QUIC hidden behind the data-plane selector
- service ownership checks, short TTLs, stream limits, selected-carrier diagnostics, and audit events

That foundation is intentionally not the product. It requires callers to already know the Bud id, thread id, root key, and workspace-relative path. It has no path affordance in the message timeline and no viewer in the web app.

This document narrows [network-upgrade-file-serving-productization.md](./network-upgrade-file-serving-productization.md) into the first product pass: a user clicks a path in an assistant response and views that file in Bud. The agent does not get a file tool in this tranche.

The mobile app is the most important eventual client, but the first implementation should ship in the web client so backend, path parsing, session creation, error states, and viewer behavior can be validated with the current repo.

## Goals

1. Let a signed-in user open a path referenced in a thread message.
2. Keep file access user-initiated. Rendering a message must not create file sessions or open daemon streams.
3. Keep authorization thread-scoped and service-owned before daemon work starts.
4. Render text, Markdown, and source files in a first-party viewer.
5. Use the same backend route contract for web and mobile.
6. Preserve transport independence. The browser and mobile clients should never know whether bytes came over WebSocket, HTTP/2, or future QUIC.

## Non-Goals

- agent-managed file reads or a model-facing file tool
- arbitrary file browser or directory explorer
- file writes, edits, uploads, or saves
- direct browser/mobile-to-daemon file reads
- binary, image, PDF, notebook, or office-document preview in the first pass
- directory preview
- web proxy productization
- QUIC implementation

## Product Decisions

- First pass supports workspace-relative paths only. Absolute host-path stripping is a follow-on feature.
- Daemon-owned `file_resolve` is deferred until absolute path support is in scope.
- Line and column suffixes may be parsed and stored in metadata, but first-pass web does not need scroll/highlight navigation.
- Markdown file previews should eventually support clickable file references, but this should not block the first viewer pass.
- Repeated clicks should route to an already open file viewer entry when the client still has a valid session. If the session is expired or gone, create a new session.
- The first viewer display cap is 1 MiB.
- Binary, image, and PDF preview are follow-on viewer expansions, not separate product surfaces.
- Path detection remains client-side for the first pass. Server-assisted parsing may be useful later, but streamed assistant text appears in the client before any durable server-side post-processing pass can run.
- The first pass does not add file-specific message metadata. Future prompt work can make agent path references more deterministic; structured file-reference metadata can be revisited if clients need it.

## Current Foundation

### Service

The service already owns the low-level file session and edge routes in `service/src/files/` and `service/src/routes/files.ts`.

Important current behavior:

- all file routes call `requireViewer(...)`
- Bud-scoped create/list routes use `getAuthorizedBud(...)`
- optional `thread_id` on file-session create must belong to the same viewer and Bud
- session read/revoke/edge routes filter by `file_session.created_by_user_id`
- `401` is unauthenticated, while signed-in non-owners get `404`
- `root_key` is restricted to `workspace`
- `relative_path` is POSIX-style, root-relative, and rejects absolute paths, drive prefixes, backslashes, NUL bytes, and parent traversal
- `permissions` default to `stat`, `read`, and `range`
- `file_url` points at `/api/files/:file_session_id`
- `HEAD` performs daemon stat
- `GET` performs daemon read
- single `Range` requests perform daemon range reads
- selected carrier metadata is returned in file-session serialization

### Daemon

The daemon file adapter in `bud/src/files/mod.rs` re-checks local policy before touching the filesystem:

- only `stream_type = "file_read"`
- only `root_key = "workspace"`
- only regular files
- no symlinks
- no root escapes after canonicalization
- size and range bounds
- content identity checks before and during reads

Current limitation: the daemon buffers the selected file/range into memory before chunking it over stream frames. The first product pass must keep a conservative display byte cap until true chunk-by-chunk reads land.

### Web

The current message timeline renders user and assistant content through `react-markdown`, with lazy syntax highlighting in `CodeBlock`. It does not detect local paths or provide a file action. The thread route has a `viewMode` toggle between `terminal` and a placeholder `web` view; that gives us a natural place to add a file viewer without inventing a separate app shell.

## Product Model

The first product surface is an "open referenced file" workflow:

1. The assistant response contains a path.
2. The message renderer recognizes an openable path candidate.
3. The user clicks an explicit file action.
4. The web client calls a thread-scoped backend helper with the raw path candidate and source metadata.
5. The service authorizes the viewer and thread, resolves the path into the existing file-session model, and creates a short-lived session.
6. The web client opens the returned `file_url`.
7. The viewer chooses Markdown, code, or plain text rendering.

Rendering a transcript should only detect candidates. It should not create sessions, prefetch file contents, or touch the daemon.

## Directional Choices

### 1. Add a thread-scoped open helper

Keep the existing Bud-scoped file-session routes as lower-level primitives, but add a product route:

```text
POST /api/threads/:thread_id/files/open
```

Request:

```json
{
  "path": "service/src/files/file-session.ts",
  "source": {
    "kind": "assistant_message",
    "message_id": "uuid optional",
    "client_id": "uuidv7 optional",
    "text_range": {
      "start": 120,
      "end": 153
    }
  },
  "line": 42,
  "column": 7,
  "viewer_intent": "preview"
}
```

Response:

```json
{
  "file_session": {
    "file_session_id": "fs_01H...",
    "bud_id": "b_01H...",
    "thread_id": "uuid",
    "root": { "key": "workspace" },
    "path": {
      "raw_path": "service/src/files/file-session.ts",
      "relative_path": "service/src/files/file-session.ts"
    },
    "file_url": "https://service.example/api/files/fs_01H...",
    "permissions": ["stat", "read", "range"],
    "state": "ready",
    "max_bytes": 1048576,
    "expires_at": "2026-05-01T12:00:00.000Z",
    "content_identity": null,
    "display_metadata": {
      "source": {
        "kind": "assistant_message",
        "message_id": "uuid optional",
        "client_id": "uuidv7 optional"
      },
      "line": 42,
      "column": 7
    },
    "transport": { "...": "existing transport status shape" }
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

Why this route:

- mobile can start from a thread without carrying Bud layout state
- authorization is naturally `thread -> Bud -> file session`
- source message metadata can be audited without changing the low-level file session contract
- the existing `/api/files/:file_session_id` edge remains the byte-serving route

The route should internally call the existing `createFileSession(...)` helper after resolving the path to `{ root_key: "workspace", relative_path }`.

### 2. Keep sessions lazy-on-click

Path detection is cheap and local. Session creation is audited, short-lived, and daemon-backed. Creating file sessions during message render would grant access to paths the user might never inspect.

The first pass should create exactly one file session per explicit open action. Re-click can either reuse the still-valid active viewer state in the client or call the helper again and let the backend create a fresh short-lived session.

### 3. Treat path resolution conservatively

The existing file foundation is workspace-relative. The first implementation should not pretend to support arbitrary host paths.

Initial accepted path forms:

- `service/src/files/file-session.ts`
- `./service/src/files/file-session.ts`
- `src/main.rs`
- `README.md:12`
- `web/src/lib/api.ts#L42`

Initial rejected path forms:

- `/etc/passwd`
- `/Users/adam/anything` unless it can be proven to be inside the Bud workspace root
- `~/secrets.txt`
- `../outside`
- Windows drive paths
- URLs
- directories

Absolute host paths are important because agents often mention them. We should support them only after one of these is true:

- the service knows a safe display-only workspace root for the thread/Bud and can strip it to a workspace-relative path, or
- the daemon supports a path-resolution request that takes a raw path plus thread cwd and returns an approved root-relative file target without leaking unsafe host details.

For the first web pass, support relative paths only and make absolute-path misses visible as "outside the current file-viewer scope" rather than silently trying to open them. Do not add workspace-root stripping or daemon `file_resolve` until absolute path support is deliberately scoped.

### 4. Detect path actions in assistant messages first

Start with the highest-signal surfaces:

- inline code spans in assistant messages
- Markdown links whose `href` is a local path
- plain text path-like tokens in assistant messages when the token has a file extension or line suffix

Do not initially scan:

- user messages
- system messages
- expanded raw tool JSON
- terminal transcript bytes
- arbitrary words with slashes that do not look like files

This is enough to validate the workflow without turning the transcript into noisy action chrome.

### 5. Add a thread file-viewer state to the web workspace

Opening a file should switch the thread workspace right pane to a file viewer while keeping the chat timeline visible.

Recommended web shape:

- extend `viewMode` to include `file`
- keep `terminal` as the default mode
- leave the placeholder `web` view alone unless the product wants to rename it later
- store the current file viewer state in the thread route
- show loading, denied, offline, expired, too-large, unsupported, and content-changed states
- provide copy path and copy content actions
- provide a reload action that creates or reuses a fresh file session

The file viewer should be a real component, not a modal-only preview. Mobile can translate the same model into a pushed detail screen or bottom sheet later.

### 6. Use a small display cap

The low-level session default is currently much larger than a comfortable UI display budget. For the viewer route, set first-pass `max_bytes` to 1 MiB, even though the lower-level route can support larger ceilings.

Reasons:

- daemon file reads currently prebuffer the selected bytes
- mobile memory and rendering budgets are tighter than desktop
- syntax highlighting and Markdown rendering degrade quickly on very large files
- range/paged viewing deserves a separate design

If `HEAD` reports a file beyond the display cap or `GET` returns `413`, show a clear too-large state and defer range pagination.

### 7. Choose viewer by extension plus text sniffing

The daemon currently returns `application/octet-stream`. The product viewer should not rely solely on response `Content-Type`.

Initial viewer selection:

- `.md`, `.markdown`, `.mdx`: Markdown preview plus raw/source toggle
- known source/config extensions: code viewer
- UTF-8 text without known extension: plain text viewer
- invalid UTF-8 or NUL-heavy content: unsupported binary state

The service helper can return a suggested viewer from extension, but the client should still sniff the fetched bytes before rendering.

## Backend Plan

### Phase 1: Thread-scoped open route

Add `POST /api/threads/:thread_id/files/open`.

Route responsibilities:

- call `requireViewer(...)`
- resolve the authorized thread with ownership checks
- derive the owning Bud from the thread, not from a client-supplied Bud id
- parse the raw path into:
  - display path
  - optional line
  - optional column
  - workspace-relative path candidate
- reject unsupported path forms with `400 invalid_file_path`
- call `createFileSession(...)` with:
  - `root_key: "workspace"`
  - normalized `relative_path`
  - `thread_id`
  - short viewer TTL
  - small viewer `max_bytes`
  - `display_metadata.source`
- return the serialized file session plus viewer hints

The helper should return `404` for a signed-in user who cannot access the thread, matching existing ownership rules.

### Phase 2: Optional metadata helper

The viewer can use `HEAD /api/files/:file_session_id` directly. If client ergonomics are poor, add a thin helper:

```text
GET /api/file-sessions/:file_session_id/metadata
```

This should only wrap existing owner checks and daemon `stat`; it should not introduce a second byte-serving path.

### Phase 3: Path resolution beyond workspace-relative paths

After the web first pass proves the interaction, decide whether to add a daemon-assisted resolver:

```text
Service -> Bud: file_resolve { raw_path, cwd, allowed_roots }
Bud -> Service: file_resolve_result { accepted, root_key, relative_path, display_path, error }
```

This is the clean route to absolute path support because the daemon owns host-local canonicalization and policy. It can also avoid exposing the host workspace root broadly if that becomes a concern.

This is explicitly deferred. The first pass should not add absolute path support.

## Web Plan

### Phase 1: File path candidate parser

Add a focused helper under `web/src/lib/` with tests.

Responsibilities:

- detect local path candidates
- parse optional line/column suffixes:
  - `path:12`
  - `path:12:4`
  - `path#L12`
  - `path#L12-L20` as line start only for the first pass
- reject URLs, emails, flags, package names, and punctuation-only tokens
- normalize leading `./`
- keep the raw display text for audit/display

This parser should be shared by Markdown inline-code/link rendering and any future terminal-output detection.

Line and column values should be carried through to the open route and stored in `display_metadata`, but the first web pass does not need to scroll or highlight the target line.

### Phase 2: Message renderer actions

Extend the role renderer props or add a thread-level file-action context so `MarkdownContent` can render detected path candidates as buttons.

Recommended first pass:

- local-path Markdown links render as normal-looking links that call `openFileCandidate(...)`
- inline code path candidates show a small adjacent open-file button or make the code chip clickable with an accessible title
- plain text path candidates can be made clickable only when false-positive rate is acceptable

The action should carry:

- `raw_path`
- parsed line/column
- source message id/client id when available
- source kind (`assistant_message`)

### Phase 3: File viewer component

Add a viewer in the thread route's right pane.

States:

- idle/no file selected
- creating session
- stat/loading metadata
- loading content
- ready
- denied
- not found
- too large
- expired/revoked
- Bud offline or transport unavailable
- content changed
- unsupported binary
- generic failure

Viewer controls:

- close file viewer, returning to terminal
- reload
- copy path
- copy content when text
- Markdown/code/plain toggle where applicable

Use existing `MarkdownContent` and `CodeBlock` where possible. Clickable file references inside rendered Markdown previews are desirable, but they can be a follow-on if wiring recursive file actions into the viewer would slow the first pass.

Repeated clicks should prefer an already open viewer entry for the same thread/root/path when the client still has a valid session. A future tabbed viewer should route to the existing tab. If the session has expired, been revoked, or disappeared from client state, create a fresh file session.

## Mobile Contract

The backend route should be mobile-ready from day one:

```text
POST /api/threads/:thread_id/files/open
HEAD /api/files/:file_session_id
GET /api/files/:file_session_id
```

Mobile can:

- parse path candidates locally using equivalent rules
- call the same thread-scoped open route with bearer auth
- use `HEAD` for size/state
- use `GET` for content
- render Markdown/code/text natively
- treat `401`, `404`, `410`, `413`, `416`, `424`, and daemon policy denials as first-class UI states

Do not add mobile-only routes unless the web-first route proves insufficient.

## Security And Ownership

Hard rules:

- browser/mobile users authorize against the thread before any file session is created
- the route derives `bud_id` from the authorized thread
- the client cannot choose an arbitrary Bud for a thread-scoped open
- session rows are stamped with `created_by_user_id`
- source metadata is audit/display context only, not authorization
- non-owner thread/session/file access returns `404`
- unauthenticated requests return `401`
- daemon policy remains the final local filesystem gate
- no direct path is ever exposed from daemon to browser except through service-owned URLs

## Protocol And Foundation Follow-Ups

These are not needed to sketch the web UI, but they matter before broad product exposure:

- remove remaining file-family `frame_json` dependency from active product payloads
- add route-level tests for selected-carrier refusal and thrown send failures if not already covered at the edge level
- add open-timeout and accepted-without-status coverage at the route edge
- add real-daemon negative smokes for path escape, symlink, directory, non-regular file, over-limit reads, and content identity changes
- implement true daemon chunk-by-chunk file reading before increasing viewer size limits
- clarify whether `file_session.state = "unavailable"` is terminal or transient
- add MIME/type sniffing policy either in service or the viewer contract
- add absolute path support, likely through daemon-owned resolution, after relative paths are working
- add binary/image/PDF preview as viewer expansions
- add clickable file references inside Markdown file previews if not included in the first pass
- revisit server-assisted path detection after streamed-response and persisted-message behavior are better understood
- revisit structured file-reference metadata only if deterministic prompting and client parsing are not enough

## Validation Plan

Backend:

- route registration test for `POST /api/threads/:thread_id/files/open`
- unauthenticated `401`
- signed-in non-owner `404`
- owned thread creates a `file_session` with the thread owner
- bad path forms return `400`
- absolute/out-of-scope paths fail closed
- viewer `max_bytes` and TTL defaults are applied
- source metadata is persisted in `display_metadata`

Web:

- path parser unit tests
- assistant Markdown link opens a session lazily
- inline-code path action opens a session lazily
- no session is created during message render
- viewer states for markdown, code, plain text, binary, too large, not found, denied, expired, and offline
- copy path/content actions
- web build and lint

Manual smoke:

1. Start service, web, and a WebSocket-only Bud daemon.
2. Ask the agent to reference a known workspace file path.
3. Click the path in the assistant response.
4. Confirm a file session is created only after click.
5. Confirm the file renders.
6. Confirm denied/outside-workspace and too-large paths show useful states.

## Remaining Unknowns

1. How aggressive should first-pass plain-text path detection be outside inline code and Markdown links?
2. Should the first web pass include a single active viewer entry only, or should it lay enough state shape for future tabs from the start?
3. Should Markdown-preview recursive file links be included if the implementation is straightforward, or held for a dedicated follow-up regardless?
4. What exact source metadata should be persisted for audit without making message rendering depend on file-specific transcript metadata?

## Recommended Next Step

Implement the thread-scoped open route and web path parser first. That gives the team a narrow vertical slice to validate path detection, authorization, lazy session creation, and file-edge behavior before investing in a polished viewer or absolute-path resolver.
