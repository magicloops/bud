# Validation Checklist: File Viewer

## Backend Route

- [x] `POST /api/threads/:thread_id/files/open` is registered.
- [x] Unauthenticated request returns `401`.
- [x] Signed-in non-owner thread request returns `404`.
- [x] Owned thread request creates a `file_session`.
- [x] Created session is stamped with the thread owner.
- [x] Created session is associated with the route thread id.
- [x] Route derives `bud_id` from the thread.
- [x] Client-supplied Bud ids are ignored or rejected.
- [x] `root_key` is always `workspace`.
- [x] Permissions include `stat`, `read`, and `range`.
- [x] Viewer `max_bytes` is `1048576`.
- [x] Viewer TTL is short and documented.
- [x] Source metadata is persisted or returned according to the implemented contract.
- [x] Line and column metadata are carried through response metadata.

## Backend Path Validation

- [x] Accepts `README.md`.
- [x] Accepts `service/src/files/file-session.ts`.
- [x] Accepts `./web/src/lib/api.ts`.
- [x] Parses `README.md:12`.
- [x] Parses `README.md:12:4`.
- [x] Parses `README.md#L12`.
- [x] Parses `README.md#L12-L20` as first-line metadata.
- [x] Classifies absolute POSIX paths such as `/Users/adam/bud/README.md` for daemon preflight.
- [x] Preserves line/column metadata on absolute POSIX paths where parsed.
- [x] Rejects `~/secrets.txt`.
- [x] Rejects `../outside.txt`.
- [x] Rejects `service/../outside.txt`.
- [x] Rejects Windows drive paths.
- [x] Rejects backslashes.
- [x] Rejects URLs.
- [x] Rejects NUL bytes.
- [x] Rejects empty paths.

## Web Parser

- [x] Detects Markdown local path links.
- [x] Leaves external Markdown links as normal links.
- [x] Detects inline-code relative path candidates.
- [x] Leaves non-path inline code inert.
- [x] Plain-text detection, if enabled, requires conservative file-like signals.
- [x] Parser trims safe surrounding punctuation.
- [x] Parser preserves raw display path for metadata.
- [x] Parser normalizes leading `./`.
- [x] Parser accepts high-confidence absolute POSIX file candidates.
- [x] Parser rejects app-like slash paths, home, parent traversal, Windows, URL, email, and NUL forms.

## Message Actions

- [x] Assistant messages expose first-pass file actions.
- [x] User messages do not expose first-pass file actions.
- [x] System/tool messages do not expose first-pass file actions.
- [x] Rendering messages does not call the open route.
- [x] Clicking a file action calls the open route exactly once.
- [x] Click payload includes raw path.
- [x] Click payload includes line/column when parsed.
- [x] Click payload includes message id/client id when available.
- [x] Actions are keyboard accessible.

## Web Viewer

- [x] Opening a file switches the right pane to file mode.
- [x] Valid repeated click reuses the current entry/session.
- [x] Expired or missing session creates a fresh session.
- [x] `HEAD` runs before `GET`.
- [x] Over-cap metadata prevents content fetch and shows too-large state.
- [x] Markdown renders as Markdown.
- [x] Source file renders as code.
- [x] Unknown UTF-8 renders as plain text.
- [x] Binary or invalid UTF-8 shows unsupported-binary state.
- [x] Not-found response shows not-found state.
- [x] Denial response shows denied state.
- [x] Expired/revoked session shows expired state.
- [x] Offline/carrier unavailable response shows offline state.
- [x] Range content-identity mismatch shows content-changed state when available.
- [x] Content-changed file-edge response creates one fresh session and retries once.
- [x] Generic failures show recoverable error state.
- [x] Reload re-fetches with a valid session.
- [x] Close returns to terminal or prior mode.
- [x] Copy path works.
- [x] Copy content is enabled only for text content.

## Real-Daemon Smoke

- [x] Service starts with WebSocket baseline.
- [x] Bud daemon connects and advertises file capability.
- [x] A known workspace-relative file can be opened from an assistant response.
- [x] File session is created only after click.
- [x] `HEAD` succeeds.
- [x] `GET` succeeds.
- [x] The file renders in web.
- [ ] Path outside workspace is rejected.
- [ ] Symlink or non-regular file is rejected where practical.
- [ ] Too-large file shows too-large viewer state.
- [ ] Daemon offline/carrier unavailable maps to viewer offline state.

## Historic CWD Preservation

- [x] Bud terminal send results report optional `host_cwd`.
- [x] Bud terminal observe results report optional `host_cwd`.
- [x] Service caches `terminal_status.info.cwd` and terminal result `host_cwd` on the terminal session.
- [x] Service updates cached cwd before resolving terminal tool promises.
- [x] User and assistant messages are stamped with `metadata.path_context` when cached cwd exists.
- [x] Terminal tool messages are stamped with `metadata.path_context_before` and `metadata.path_context_after`.
- [x] Thread file-open loads source-message path context only from the same authorized thread.
- [x] Thread file-open ignores missing or foreign source-message context without revealing cross-thread existence.
- [x] File edge sends daemon `resolution_hint` only from server-side file-session display metadata.
- [x] Daemon hinted opens resolve message-time cwd before workspace root.
- [x] Daemon hinted opens skip click-time tmux cwd.
- [x] Daemon invalid/outside hints fall back directly to workspace root.
- [x] Contextless opens retain terminal-cwd-first behavior.
- [x] Manual web validation confirmed an old assistant-message file link still opens after the thread changes project directories.
- [x] Web viewer reuse keying accounts for `source.message_id`.

## Absolute POSIX Path Opens

- [x] Bud advertises `files.resolve.absolute_posix`.
- [x] Bud handles metadata-only `file_resolve` requests.
- [x] Bud rejects absolute POSIX paths outside the workspace root with `POLICY_DENIED`.
- [x] Bud rejects symlinks and directories before serving bytes.
- [x] Bud accepted resolve responses include `resolved_against: "absolute_path"`.
- [x] Bud accepted resolve responses include workspace-relative `resolved_relative_path`.
- [x] Bud accepted resolve responses include size and content identity.
- [x] Service requires file-read transport availability before absolute preflight.
- [x] Service requires daemon absolute-resolve capability before absolute preflight.
- [x] Service maps daemon outside-root denial to `403`.
- [x] Service maps in-root missing files to `404`.
- [x] Service creates sessions from daemon-approved relative paths only.
- [x] Service persists preflight content identity on absolute sessions.
- [x] Service stores `requested_path_kind: "absolute_posix"` and `resolved_against: "absolute_path"` in display metadata.
- [x] `source.kind = "markdown_preview"` remains accepted.
- [x] Protobuf and JSON compatibility payloads cover `file_resolve` / `file_resolve_result`.

## Web Absolute And Markdown Preview Links

- [x] Web parser accepts high-confidence absolute POSIX assistant-message candidates.
- [x] Web parser rejects app-relative paths such as `/settings` and `/api/threads`.
- [x] Web open flow sends raw absolute paths to the thread file-open route.
- [x] Web open flow moves successful absolute opens to the backend-normalized workspace key.
- [x] Markdown previews pass file-open actions into `MarkdownContent`.
- [x] Absolute POSIX links inside Markdown previews open with `source.kind = "markdown_preview"`.
- [x] External web links inside Markdown previews remain external anchors.
- [x] Unsafe protocol links inside Markdown previews are not clickable.
- [x] Unsupported local/relative Markdown-preview links do not navigate to same-origin web-app 404s.
- [ ] Long absolute Markdown-preview links wrap without hiding the file action.

## Mobile Handoff

- [x] Handoff documents `POST /api/threads/:thread_id/files/open`.
- [x] Handoff documents `HEAD` and `GET` file edge routes.
- [x] Handoff documents auth and non-owner behavior.
- [x] Handoff documents relative-path and daemon-preflighted absolute POSIX scope.
- [x] Handoff includes request and response examples.
- [x] Handoff includes parser rules.
- [x] Handoff includes 1 MiB display cap.
- [x] Handoff includes status-code-to-UI-state guidance.
- [x] Handoff includes line/column metadata behavior.
- [x] Handoff includes session reuse guidance.
- [x] Handoff documents message-time cwd behavior and source-message reuse guidance.
- [x] Handoff documents Markdown-preview absolute POSIX link behavior.

## Documentation

- [x] `docs/proto.md` describes the new route and file viewer flow.
- [x] `service/src/routes/routes.spec.md` describes the thread file-open route.
- [x] `service/src/files/files.spec.md` describes viewer-scoped session defaults.
- [x] Web specs describe parser/actions/viewer behavior.
- [x] [file-viewer.spec.md](./file-viewer.spec.md) matches the plan folder contents.
- [x] [../../bud.spec.md](../../bud.spec.md) links this implementation plan.

## Verification Notes

- Code-level verification completed with focused service route/parser tests, focused service runtime/agent/file/proto tests, focused daemon tests, and the service production build.
- Phase 5 verification commands completed successfully:
  - `cargo test` from `/Users/adam/bud/bud`
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/proto/wire.test.ts src/runtime/terminal/request-dispatcher.test.ts src/runtime/terminal-session-manager.test.ts src/agent/transcript-writer.test.ts src/files/file-edge.test.ts src/routes/threads/files.test.ts`
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/threads/messages.test.ts`
  - `pnpm --dir /Users/adam/bud/service build`
  - `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/features/threads/file-viewer-flow.test.ts`
  - `pnpm --dir /Users/adam/bud/web build`
  - `git diff --check`
- Phase 7 verification commands completed successfully:
  - `cargo fmt --check` from `/Users/adam/bud/bud`
  - `cargo test files::` from `/Users/adam/bud/bud`
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/files/file-session.test.ts src/proto/wire.test.ts src/routes/threads/files.test.ts`
  - `pnpm --dir /Users/adam/bud/service exec tsc --noEmit`
  - `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/lib/file-paths.test.ts src/components/message-renderers/roles/markdown-file-actions.test.ts src/features/threads/file-viewer-flow.test.ts`
  - `pnpm --dir /Users/adam/bud/web test`
  - `pnpm --dir /Users/adam/bud/web exec tsc -b`
  - `pnpm --dir /Users/adam/bud/web lint`
  - `pnpm --dir /Users/adam/bud/web build`
  - `git diff --check`
- Web happy-path validation is complete against a real Bud flow.
- Historic cwd project-switch validation is complete against the web flow.
- Remaining real-daemon smoke items are negative edge cases: outside-workspace denial, symlink/non-regular denial, too-large state, and daemon-offline state.
- Mobile handoff is captured in [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md).
