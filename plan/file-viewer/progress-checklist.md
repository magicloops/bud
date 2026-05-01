# Progress Checklist: File Viewer

## Phase 1: Thread Open Route And Contract

- [ ] Add `POST /api/threads/:thread_id/files/open`
- [ ] Add request schema validation
- [ ] Authorize via viewer-owned thread lookup
- [ ] Derive Bud from the authorized thread
- [ ] Add or reuse relative-path parser on the service
- [ ] Reject absolute, home, parent traversal, Windows, URL, NUL, and empty paths
- [ ] Parse and carry line/column metadata
- [ ] Create viewer-scoped file sessions with `root_key: "workspace"`
- [ ] Apply 1 MiB viewer `max_bytes`
- [ ] Persist or return source metadata for audit/display
- [ ] Return file-session serialization plus viewer hints
- [ ] Add route tests for auth, ownership, path validation, defaults, and metadata
- [ ] Update service/protocol specs

## Phase 2: Web Path Detection And Message Actions

- [ ] Add shared web file-path parser
- [ ] Add parser tests for accepted paths
- [ ] Add parser tests for rejected paths and false positives
- [ ] Detect local Markdown links in assistant messages
- [ ] Detect inline-code path candidates in assistant messages
- [ ] Decide whether conservative plain-text detection ships in the first pass
- [ ] Add explicit accessible file-open actions
- [ ] Ensure message render never creates file sessions
- [ ] Wire source message id/client id into click payloads
- [ ] Call the thread open route from click actions
- [ ] Add renderer/action tests
- [ ] Update web specs

## Phase 3: Web File Viewer And Fetch Flow

- [ ] Add `file` workspace view mode
- [ ] Add thread-route file viewer state with future tab-compatible shape
- [ ] Reuse valid existing file entries on repeated clicks
- [ ] Recreate expired or missing sessions
- [ ] Fetch metadata with `HEAD /api/files/:file_session_id`
- [ ] Fetch content with `GET /api/files/:file_session_id`
- [ ] Enforce 1 MiB display cap in viewer behavior
- [ ] Add text/binary sniffing
- [ ] Render Markdown files
- [ ] Render source/code files
- [ ] Render unknown UTF-8 text files
- [ ] Handle not found, denied, expired, offline, too-large, content-changed, binary, and generic error states
- [ ] Add close, reload, copy path, and copy content controls
- [ ] Decide whether Markdown preview recursive file links ship now
- [ ] Add viewer tests
- [ ] Update web specs

## Phase 4: Hardening, Mobile Handoff, And Follow-Ups

- [ ] Run real-daemon happy-path smoke
- [ ] Validate path outside workspace denial
- [ ] Validate symlink/non-regular/directory denial where practical
- [ ] Validate too-large file behavior
- [ ] Validate offline/carrier unavailable behavior
- [ ] Capture mobile route contract handoff if needed
- [ ] Record final plain-text detection decision
- [ ] Record final viewer state/tab-readiness decision
- [ ] Record recursive Markdown link decision
- [ ] Scope absolute path support follow-up
- [ ] Scope binary/image/PDF viewer follow-ups
- [ ] Update protocol/root docs and all affected specs
