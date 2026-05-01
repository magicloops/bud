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
- [x] Rejects `/etc/passwd`.
- [x] Rejects `/Users/adam/bud/README.md` in the first pass.
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
- [x] Parser rejects absolute, home, parent traversal, Windows, URL, email, and NUL forms.

## Message Actions

- [x] Assistant messages expose first-pass file actions.
- [x] User messages do not expose first-pass file actions.
- [x] System/tool messages do not expose first-pass file actions.
- [x] Rendering messages does not call the open route.
- [ ] Clicking a file action calls the open route exactly once.
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
- [x] Content identity/range mismatch shows content-changed state when available.
- [x] Generic failures show recoverable error state.
- [x] Reload re-fetches with a valid session.
- [x] Close returns to terminal or prior mode.
- [x] Copy path works.
- [x] Copy content is enabled only for text content.

## Real-Daemon Smoke

- [ ] Service starts with WebSocket baseline.
- [ ] Bud daemon connects and advertises file capability.
- [ ] A known workspace-relative file can be opened from an assistant response.
- [ ] File session is created only after click.
- [ ] `HEAD` succeeds.
- [ ] `GET` succeeds.
- [ ] The file renders in web.
- [ ] Path outside workspace is rejected.
- [ ] Symlink or non-regular file is rejected where practical.
- [ ] Too-large file shows too-large viewer state.
- [ ] Daemon offline/carrier unavailable maps to viewer offline state.

## Mobile Handoff

- [x] Handoff documents `POST /api/threads/:thread_id/files/open`.
- [x] Handoff documents `HEAD` and `GET` file edge routes.
- [x] Handoff documents auth and non-owner behavior.
- [x] Handoff documents relative-path-only first-pass scope.
- [x] Handoff includes request and response examples.
- [x] Handoff includes parser rules.
- [x] Handoff includes 1 MiB display cap.
- [x] Handoff includes status-code-to-UI-state guidance.
- [x] Handoff includes line/column metadata behavior.
- [x] Handoff includes session reuse guidance.

## Documentation

- [x] `docs/proto.md` describes the new route and file viewer flow.
- [x] `service/src/routes/routes.spec.md` describes the thread file-open route.
- [x] `service/src/files/files.spec.md` describes viewer-scoped session defaults.
- [x] Web specs describe parser/actions/viewer behavior.
- [x] [file-viewer.spec.md](./file-viewer.spec.md) matches the plan folder contents.
- [x] [../../bud.spec.md](../../bud.spec.md) links this implementation plan.

## Verification Notes

- Code-level verification completed with focused service route/parser tests, the web test suite, and service/web production builds.
- Real-daemon smoke and browser click-path manual validation remain open.
