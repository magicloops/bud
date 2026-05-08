# Implementation Spec: User-Initiated File Viewer

**Status**: Draft
**Created**: 2026-05-01
**Design Doc**: [../../design/file-serving-user-initiated-viewer.md](../../design/file-serving-user-initiated-viewer.md)
**Folder Spec**: [file-viewer.spec.md](./file-viewer.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-thread-open-route-and-contract.md](./phase-1-thread-open-route-and-contract.md)
**Phase 2**: [phase-2-web-path-detection-and-message-actions.md](./phase-2-web-path-detection-and-message-actions.md)
**Phase 3**: [phase-3-web-file-viewer-and-fetch-flow.md](./phase-3-web-file-viewer-and-fetch-flow.md)
**Phase 4**: [phase-4-hardening-mobile-handoff-and-follow-ups.md](./phase-4-hardening-mobile-handoff-and-follow-ups.md)

---

## Context

The network-upgrade work left Bud with a useful file-session foundation: browser-authenticated `file_session` rows, daemon-side file policy checks, and service-owned `HEAD` / `GET` byte routes that hide whether the daemon bytes traveled over WebSocket, HTTP/2, or future QUIC.

That foundation is not yet a product workflow. A caller must already know the Bud id, root key, and relative path, and the web UI has no path affordance or viewer. The first product pass is narrower: when an assistant response references a file path, a signed-in user can click an explicit file action and open the file in the Bud UI.

The mobile app is the most important eventual client. The first implementation should ship in the web client so the backend contract, path parser, lazy session creation, file-edge behavior, and viewer states can be validated against the current repo.

## Objective

Implement a web-first, mobile-compatible file viewer workflow:

1. detect likely workspace-relative file paths in assistant messages
2. render explicit file-open actions without creating sessions during transcript render
3. add a thread-scoped backend helper that creates viewer-scoped file sessions
4. fetch file metadata and content through the existing service file edge
5. render Markdown, source/code, and plain text in a first-party viewer
6. carry source, line, and column metadata for audit and future navigation
7. leave absolute paths, binary previews, and agent file reads out of the first pass

## Fixed Decisions

- First pass supports workspace-relative paths only.
- Absolute host-path stripping is a follow-on feature.
- Daemon-owned `file_resolve` is deferred until absolute path support is deliberately scoped.
- Line and column suffixes are parsed and carried through metadata, but first-pass web does not need to scroll or highlight the target line.
- Markdown file previews should eventually support clickable file references, but recursive viewer wiring should not block the first web pass.
- Repeated clicks should route to an already open viewer entry when the client still has a valid session; expired or missing sessions create a new session.
- The first viewer display cap is 1 MiB.
- Binary, image, and PDF preview are follow-on viewer expansions.
- Path detection remains client-side for the first pass because streamed assistant text appears in the client before any durable server-side post-processing pass can run.
- First pass does not add file-specific message metadata. Future prompt work can make path references more deterministic, and structured metadata can be revisited if client parsing proves insufficient.
- The agent does not receive new file-read authority in this plan.

## Target Product Flow

```text
assistant message
  |
  v
web parser detects path candidates
  |
  v
user clicks explicit file action
  |
  v
POST /api/threads/:thread_id/files/open
  |
  v
service authorizes viewer -> thread -> Bud
  |
  v
service creates viewer-scoped file_session
  |
  v
web HEADs/GETs /api/files/:file_session_id
  |
  v
file viewer renders Markdown, code, or plain text
```

Rendering a message only detects candidates. It must not create a session, prefetch content, or touch the daemon.

## Backend Contract

Add:

```text
POST /api/threads/:thread_id/files/open
```

Request body:

```json
{
  "path": "service/src/files/file-session.ts:42:7",
  "source": {
    "kind": "assistant_message",
    "message_id": "01HY...",
    "client_id": "0195...",
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

Response body:

```json
{
  "file_session": {
    "file_session_id": "fs_01H...",
    "bud_id": "b_01H...",
    "thread_id": "th_01H...",
    "root": { "key": "workspace" },
    "path": {
      "raw_path": "service/src/files/file-session.ts:42:7",
      "relative_path": "service/src/files/file-session.ts"
    },
    "file_url": "/api/files/fs_01H...",
    "permissions": ["stat", "read", "range"],
    "state": "ready",
    "max_bytes": 1048576,
    "expires_at": "2026-05-01T12:00:00.000Z",
    "content_identity": null,
    "display_metadata": {
      "source": {
        "kind": "assistant_message",
        "message_id": "01HY...",
        "client_id": "0195..."
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

The exact serialized `file_session` shape should match the existing file-session serializer where possible. New fields should use snake_case at the REST boundary.

## Ownership And Security

Hard requirements:

- call `requireViewer(...)`
- resolve `thread_id` through an ownership-aware helper before reading or creating anything
- derive `bud_id` from the authorized thread
- never trust a client-supplied Bud id for this route
- reject unsupported path forms before calling the low-level session helper
- create session rows with the thread owner as `created_by_user_id`
- stamp `thread_id` on the file session
- treat source metadata as audit/display context only, not authorization
- return `401` only for unauthenticated browser/mobile requests
- return `404` for signed-in users accessing another user's thread or file session
- preserve daemon-side local policy as the final filesystem gate

Accepted first-pass paths are POSIX workspace-relative files such as `service/src/files/file-session.ts`, `./web/src/lib/api.ts`, `README.md:12`, and `web/src/lib/api.ts#L42`.

Rejected first-pass paths include absolute POSIX paths, `~`, parent traversal, Windows drive paths, backslashes, URLs, NUL bytes, and obvious directories.

## Web Contract

The reference web client should:

- detect file candidates only in assistant messages for the first pass
- treat Markdown local links and inline code spans as the highest-signal surfaces
- optionally detect plain-text path-like tokens when they have a file extension or line suffix
- make file opening an explicit click action
- call `POST /api/threads/:thread_id/files/open` with raw path and source metadata
- switch the thread workspace right pane into a `file` view
- use `HEAD /api/files/:file_session_id` for metadata and `GET /api/files/:file_session_id` for content
- sniff fetched bytes before choosing Markdown, code, plain-text, or unsupported-binary rendering
- keep state shaped so future tabs can route repeated clicks to an existing file entry

The first pass should use the existing thread route workspace shell. It should not introduce a separate top-level file browser or modal-only preview.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-thread-open-route-and-contract.md](./phase-1-thread-open-route-and-contract.md) | Urgent | Thread-scoped open route creates authorized viewer file sessions from relative paths |
| 2 | [phase-2-web-path-detection-and-message-actions.md](./phase-2-web-path-detection-and-message-actions.md) | Urgent | Assistant message rendering exposes lazy open-file actions for parsed path candidates |
| 3 | [phase-3-web-file-viewer-and-fetch-flow.md](./phase-3-web-file-viewer-and-fetch-flow.md) | High | Web right pane renders fetched Markdown, code, and text files with first-class states |
| 4 | [phase-4-hardening-mobile-handoff-and-follow-ups.md](./phase-4-hardening-mobile-handoff-and-follow-ups.md) | High | Real-daemon validation, mobile contract handoff, docs/spec alignment, and follow-up scoping |

## Expected Files And Areas

### Service

- `service/src/routes/threads/` or `service/src/routes/threads.ts` for the thread-scoped open route
- `service/src/files/` for any reusable path normalization, viewer defaults, and serializer additions
- `service/src/routes/files.ts` only if the low-level file route contract needs additive metadata support
- `service/src/routes/routes.spec.md`
- `service/src/files/files.spec.md`
- `docs/proto.md`

### Web

- `web/src/lib/` for a shared file-path parser and tests
- `web/src/components/` message rendering components for file actions
- `web/src/routes/$budId/$threadId.tsx` for file viewer state and workspace mode wiring
- `web/src/components/workbench/` or a nearby viewer folder for the file viewer component
- `web/src/src.spec.md`
- affected component/folder specs

### Reference And Plan Docs

- `reference/` for mobile handoff if the team wants the route contract captured outside this plan
- this plan folder's progress and validation checklists
- [../../bud.spec.md](../../bud.spec.md)

## Sequencing Notes

- Implement the backend route before the web renderer creates actions so the UI can call the real contract.
- Implement the parser independently from React rendering so web and mobile can share the rules as a handoff.
- Do not create file sessions from render-time code paths.
- Keep low-level Bud-scoped file-session routes as primitives; the product workflow should enter through the thread route.
- Do not add absolute path support in this plan even if the parser sees absolute paths. Show an out-of-scope state or leave them non-openable.
- Keep line/column in metadata even though first-pass viewer navigation ignores it.
- Do not expand the daemon file-read limit or viewer cap until daemon reads are truly streaming instead of prebuffered.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Path detection is noisy and turns normal prose into actions | Medium | Medium | Start with Markdown links and inline code; keep plain-text detection conservative and tested |
| Route accidentally lets a viewer choose an arbitrary Bud | Low | High | Derive Bud exclusively from the authorized thread |
| Absolute paths are common in agent output and first pass cannot open them | High | Medium | Make the limitation visible and add daemon `file_resolve` as a follow-up, not a hidden partial resolver |
| Large files hurt browser or mobile rendering | Medium | High | Enforce 1 MiB viewer max and show a too-large state |
| Binary files render as corrupted text | Medium | Medium | Sniff fetched bytes and show unsupported-binary state |
| Session expiry makes repeated clicks feel flaky | Medium | Medium | Reuse valid client state; recreate on expired/gone session with a clear loading state |
| Markdown preview recursive file links add too much coupling | Medium | Low | Include only if the Phase 3 wiring stays simple; otherwise defer |

## Rollout Strategy

1. Land the backend route with ownership/path tests.
2. Land parser tests and assistant message actions without a polished viewer.
3. Land the right-pane viewer and connect it to the real backend route.
4. Run focused web and service validation with a WebSocket-only daemon.
5. Capture mobile route contract and parser rules for the iOS repo.
6. Promote absolute paths, binary previews, and recursive Markdown links into separate follow-ups as needed.

## Definition Of Done

- [ ] `POST /api/threads/:thread_id/files/open` exists and is documented.
- [ ] The open route is ownership-aware and derives Bud from the authorized thread.
- [ ] First-pass path validation accepts only workspace-relative file candidates.
- [ ] Viewer-created sessions use a 1 MiB display cap and short TTL.
- [ ] Source, line, and column metadata are carried through the route.
- [ ] Assistant message rendering exposes explicit file actions without creating sessions during render.
- [ ] Web parser tests cover accepted and rejected path forms.
- [ ] The web right pane can display Markdown, code, and plain text files.
- [ ] The viewer handles not found, denied, expired/revoked, Bud offline, too large, unsupported binary, content changed, and generic failure states.
- [ ] Repeated clicks reuse still-valid client viewer state and recreate expired sessions.
- [ ] Protocol docs and affected specs match the shipped route and UI behavior.
- [ ] Mobile handoff captures the route contract, parser rules, status handling, and first-pass limitations.
