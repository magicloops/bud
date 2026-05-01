# Progress Checklist: File Viewer

## Phase 1: Thread Open Route And Contract

- [x] Add `POST /api/threads/:thread_id/files/open`
- [x] Add request schema validation
- [x] Authorize via viewer-owned thread lookup
- [x] Derive Bud from the authorized thread
- [x] Add or reuse relative-path parser on the service
- [x] Reject absolute, home, parent traversal, Windows, URL, NUL, and empty paths
- [x] Parse and carry line/column metadata
- [x] Create viewer-scoped file sessions with `root_key: "workspace"`
- [x] Apply 1 MiB viewer `max_bytes`
- [x] Persist or return source metadata for audit/display
- [x] Return file-session serialization plus viewer hints
- [x] Add route tests for auth, ownership, path validation, defaults, and metadata
- [x] Update service/protocol specs

## Phase 2: Web Path Detection And Message Actions

- [x] Add shared web file-path parser
- [x] Add parser tests for accepted paths
- [x] Add parser tests for rejected paths and false positives
- [x] Detect local Markdown links in assistant messages
- [x] Detect inline-code path candidates in assistant messages
- [x] Decide whether conservative plain-text detection ships in the first pass
- [x] Add explicit accessible file-open actions
- [x] Ensure message render never creates file sessions
- [x] Wire source message id/client id into click payloads
- [x] Call the thread open route from click actions
- [ ] Add renderer/action tests
- [x] Update web specs

## Phase 3: Web File Viewer And Fetch Flow

- [x] Add `file` workspace view mode
- [x] Add thread-route file viewer state with future tab-compatible shape
- [x] Reuse valid existing file entries on repeated clicks
- [x] Recreate expired or missing sessions
- [x] Fetch metadata with `HEAD /api/files/:file_session_id`
- [x] Fetch content with `GET /api/files/:file_session_id`
- [x] Enforce 1 MiB display cap in viewer behavior
- [x] Add text/binary sniffing
- [x] Render Markdown files
- [x] Render source/code files
- [x] Render unknown UTF-8 text files
- [x] Handle not found, denied, expired, offline, too-large, content-changed, binary, and generic error states
- [x] Add close, reload, copy path, and copy content controls
- [x] Decide whether Markdown preview recursive file links ship now
- [ ] Add viewer tests
- [x] Update web specs

## Phase 4: Hardening, Mobile Handoff, And Follow-Ups

- [ ] Run real-daemon happy-path smoke
- [ ] Validate path outside workspace denial
- [ ] Validate symlink/non-regular/directory denial where practical
- [ ] Validate too-large file behavior
- [ ] Validate offline/carrier unavailable behavior
- [ ] Capture mobile route contract handoff if needed
- [x] Record final plain-text detection decision
- [x] Record final viewer state/tab-readiness decision
- [x] Record recursive Markdown link decision
- [ ] Scope absolute path support follow-up
- [ ] Scope binary/image/PDF viewer follow-ups
- [x] Update protocol/root docs and all affected specs

## Implementation Notes

- Plain-text detection does not ship in the first pass; only Markdown links and inline-code candidates expose actions.
- File viewer state is keyed by workspace-relative path and keeps a future tab-compatible `entries_by_key` shape.
- Markdown files opened in the viewer render normally, but recursive file links inside previewed Markdown are deferred.
