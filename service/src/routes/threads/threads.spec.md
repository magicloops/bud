# threads

Thread-route submodules split out of the top-level `routes/threads.ts` composition root.

## Purpose

Keeps browser-visible thread ownership checks explicit while splitting the old monolithic thread transport file into smaller route groups:
- core thread CRUD
- message history/create flows
- read-watermark updates for unread-attention state
- agent state/stream/cancel
- terminal create/ensure/input/history/stream
- user-clicked file viewer session creation

## Files

### `shared.ts`

Shared Zod schemas, cursor helpers, model-selection serialization/metadata helpers, and ownership-aware thread lookup.

### `core.ts`

Thread list/create/read/delete routes plus `PATCH /api/threads/:threadId/model-preference` for owned model/reasoning selection persistence.

### `core.test.ts`

Focused route-handler coverage for thread-list serialization.

**Current Coverage**:
- `GET /api/threads` maps unread-attention state into `has_unseen_attention` and `last_attention_kind`
- thread-list serialization includes stored/effective model-selection fields
- `PATCH /api/threads/:threadId/model-preference` persists a validated concrete selection and rejects missing models

### `messages.ts`

Thread message history, read-watermark, and create/send routes, including pre-flight context sync, first-message title kickoff, and user-message `path_context` stamping from cached terminal cwd when available.

### `messages.test.ts`

Focused route-handler coverage for the thread read-watermark route.

**Current Coverage**:
- `POST /api/threads/:threadId/read` upserts the watermark when the seen message is newer
- stale read-watermark updates return `updated: false` and do not rewrite the row
- create-message rejects invalid explicit model/reasoning selections before duplicate lookup or persistence

### `agent.ts`

Agent runtime routes for `/agent/state`, `/agent/stream`, and `/cancel`.

### `files.ts`

Thread-scoped file viewer route for `POST /api/threads/:threadId/files/open`.

**Behavior**:
- authorizes through `requireAuthorizedThreadAccess(...)` and derives `budId` from the owned thread
- accepts workspace-relative path candidates and absolute POSIX candidates
- rejects home, parent traversal, Windows, URL, NUL, empty, backslash, and directory path forms at the service boundary
- requires file-read transport availability and daemon `files.resolve.absolute_posix` capability before absolute POSIX preflight
- sends daemon `file_resolve` for absolute POSIX inputs and creates sessions only from daemon-approved workspace-relative results
- parses optional line/column metadata and carries it into display metadata and viewer hints
- loads the clicked source message by authorized thread/user and copies trusted `metadata.path_context` into file-session display metadata
- omits message-time path context for absolute POSIX opens because the absolute candidate resolves through daemon policy rather than cwd context
- creates a viewer-owned `file_session` with `root_key: "workspace"`, `stat/read/range` permissions, the default short TTL, and a 1 MiB preview byte cap
- persists daemon preflight content identity on absolute POSIX sessions
- stores click source metadata such as assistant `message_id` / `client_id` when supplied by the UI

### `terminal.ts`

Thread-scoped terminal routes for session create/ensure/read, SSE attach, human input/interrupt/resize, and history reads.

The interrupt route sends a human Ctrl+C through the terminal runtime and rejects older pending terminal waits as `interrupted`, so a long settled agent tool can return a conservative tool result instead of remaining pending for the full settled timeout.

### `terminal.test.ts`

Focused route-handler coverage for the terminal interrupt route.

**Current Coverage**:
- owned terminal interrupt returns dispatch metadata from the terminal manager
- missing active sessions return `404 no_terminal_session`

### `files.test.ts`

Focused route-handler coverage for the thread file-open route.

**Current Coverage**:
- unauthenticated requests return `401`
- signed-in non-owner thread requests return `404`
- owned requests create viewer-scoped file sessions with thread ownership, viewer byte cap, permissions, path metadata, and viewer hints
- absolute POSIX opens call daemon preflight and persist resolved metadata
- unsupported URL-style path forms return `400 invalid_file_path`
- daemon outside-root absolute denials return `403`

### `registration.test.ts`

Regression test for the split thread-route registration surface.

**Current Coverage**:
- the split core/message/agent/terminal/file modules register the expected endpoint set
- route registration remains duplicate-free after the decomposition

## Ownership Notes

- every exported route module resolves thread ownership at the route boundary through `requireAuthorizedThreadAccess(...)`
- SSE attach happens only after ownership is resolved
- terminal routes still stamp and enforce the owning human through the terminal runtime
- file viewer session creation stamps the acting viewer on `file_session.created_by_user_id` and never trusts a client-supplied Bud id
- thread model-preference updates resolve through the same owned-thread boundary and return `404` for signed-in non-owners

---

*Parent spec: [../routes.spec.md](../routes.spec.md)*
