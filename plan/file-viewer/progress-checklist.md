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
- [x] Add renderer/action tests
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
- [x] Add viewer tests
- [x] Update web specs

## Phase 4: Hardening, Mobile Handoff, And Follow-Ups

- [x] Run real-daemon happy-path smoke
- [ ] Validate path outside workspace denial
- [ ] Validate symlink/non-regular/directory denial where practical
- [ ] Validate too-large file behavior
- [ ] Validate offline/carrier unavailable behavior
- [x] Capture mobile route contract handoff if needed
- [x] Record final plain-text detection decision
- [x] Record final viewer state/tab-readiness decision
- [x] Record recursive Markdown link decision
- [x] Scope absolute path support follow-up
- [x] Scope binary/image/PDF viewer follow-ups
- [x] Update protocol/root docs and all affected specs

## Phase 5: Historic CWD Preservation

- [x] Add optional daemon `host_cwd` emission on terminal send results
- [x] Add optional daemon `host_cwd` emission on terminal observe results
- [x] Cache daemon-reported cwd in the service terminal runtime
- [x] Stamp user and assistant messages with `metadata.path_context` when cached cwd exists
- [x] Stamp terminal tool messages with `metadata.path_context_before` and `metadata.path_context_after`
- [x] Load same-thread source-message path context in the thread file-open route
- [x] Store trusted source-message path context in file-session display metadata
- [x] Send daemon `file_open.resolution_hint` from server-side path context
- [x] Prefer message-time cwd over click-time cwd for context-bearing daemon file opens
- [x] Keep contextless/pre-rollout opens on terminal-cwd-first behavior
- [x] Add focused daemon and service tests for cwd caching, metadata stamping, resolver hints, and hinted daemon resolution
- [x] Validate old assistant-message links after changing project directories in one thread
- [x] Update protocol, design, plan, handoff, and spec documentation

## Phase 7: Absolute POSIX Path Opens

- [x] Add daemon `file_resolve` control frame handling
- [x] Add daemon absolute POSIX resolver under workspace policy
- [x] Return `resolved_against: "absolute_path"`, resolved relative path, size, and content identity
- [x] Advertise `files.resolve.absolute_posix` in daemon capabilities
- [x] Add protobuf payload tags for `file_resolve` / `file_resolve_result`
- [x] Add service pending-result bridge for `file_resolve_result`
- [x] Classify absolute POSIX paths in the viewer path parser
- [x] Require file-read transport availability before absolute preflight
- [x] Require daemon absolute-resolve capability before absolute preflight
- [x] Create normalized file sessions from daemon-approved resolve metadata
- [x] Persist preflight content identity on absolute sessions
- [x] Preserve `source.kind = "markdown_preview"` and raw path metadata
- [x] Map outside-root denials to `403` and in-root missing files to `404`
- [x] Update protocol, specs, plan, and iOS backend response docs

## Phase 7d: Web Absolute Path Candidates

- [x] Extend web file candidate types to distinguish relative and absolute POSIX paths
- [x] Parse high-confidence absolute POSIX assistant-message candidates
- [x] Keep app-relative URLs such as `/settings` out of file-open actions
- [x] Send raw absolute paths to the existing thread file-open route
- [x] Add pending and canonical keying for daemon-normalized absolute opens
- [x] Update web parser/flow tests and affected specs

## Phase 7e: Web Markdown Preview Links

- [x] Pass file-open actions into Markdown file previews
- [x] Open absolute POSIX preview links with `source.kind = "markdown_preview"`
- [x] Preserve original assistant message ids when available
- [x] Keep external links as external anchors
- [x] Render unsafe or unsupported local preview links without same-origin 404 navigation
- [x] Add parser/action/flow tests and specs
- [ ] Manually validate web Markdown-preview absolute link behavior against a real Bud

## Merge Readiness

- [x] Web file-viewer happy path validated against a real Bud flow
- [x] Foreground TUI tmux `pane_current_path` behavior validated well enough for first pass
- [x] Historic cwd project-switch flow validated on web
- [x] Mobile handoff updated for message-time cwd behavior
- [x] Protocol/spec docs updated for `host_cwd`, `path_context`, `resolution_hint`, and `message_cwd`
- [x] Focused Rust daemon tests passed
- [x] Focused service route/runtime/agent/file/proto tests passed
- [x] Service production build passed
- [x] Patch web viewer reuse keys so same relative paths from different `source.message_id` values cannot reuse the wrong existing file session
- [x] Focused web file-viewer flow test passed after source-aware keying change
- [x] Web production build passed after source-aware keying change
- [x] Create PR summary doc comparing branch scope to `origin/main`
- [ ] Stage/commit the branch, excluding unrelated untracked local scratch files

## Implementation Notes

- Plain-text detection does not ship in the first pass; only Markdown links and inline-code candidates expose actions.
- File viewer state is keyed by workspace-relative path plus assistant `source.message_id` when available, and keeps a future tab-compatible `entries_by_key` shape. Contextless opens keep the original workspace-relative key.
- Markdown files opened in the viewer render normally, but recursive file links inside previewed Markdown are deferred.
- Mobile handoff is captured in [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md).
- Web happy-path validation is complete; remaining unchecked Phase 4 items are negative policy/offline/large-file smokes rather than blockers for the validated web product flow.
