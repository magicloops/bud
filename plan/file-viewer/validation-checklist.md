# Validation Checklist: File Viewer

## Backend Route

- [ ] `POST /api/threads/:thread_id/files/open` is registered.
- [ ] Unauthenticated request returns `401`.
- [ ] Signed-in non-owner thread request returns `404`.
- [ ] Owned thread request creates a `file_session`.
- [ ] Created session is stamped with the thread owner.
- [ ] Created session is associated with the route thread id.
- [ ] Route derives `bud_id` from the thread.
- [ ] Client-supplied Bud ids are ignored or rejected.
- [ ] `root_key` is always `workspace`.
- [ ] Permissions include `stat`, `read`, and `range`.
- [ ] Viewer `max_bytes` is `1048576`.
- [ ] Viewer TTL is short and documented.
- [ ] Source metadata is persisted or returned according to the implemented contract.
- [ ] Line and column metadata are carried through response metadata.

## Backend Path Validation

- [ ] Accepts `README.md`.
- [ ] Accepts `service/src/files/file-session.ts`.
- [ ] Accepts `./web/src/lib/api.ts`.
- [ ] Parses `README.md:12`.
- [ ] Parses `README.md:12:4`.
- [ ] Parses `README.md#L12`.
- [ ] Parses `README.md#L12-L20` as first-line metadata.
- [ ] Rejects `/etc/passwd`.
- [ ] Rejects `/Users/adam/bud/README.md` in the first pass.
- [ ] Rejects `~/secrets.txt`.
- [ ] Rejects `../outside.txt`.
- [ ] Rejects `service/../outside.txt`.
- [ ] Rejects Windows drive paths.
- [ ] Rejects backslashes.
- [ ] Rejects URLs.
- [ ] Rejects NUL bytes.
- [ ] Rejects empty paths.

## Web Parser

- [ ] Detects Markdown local path links.
- [ ] Leaves external Markdown links as normal links.
- [ ] Detects inline-code relative path candidates.
- [ ] Leaves non-path inline code inert.
- [ ] Plain-text detection, if enabled, requires conservative file-like signals.
- [ ] Parser trims safe surrounding punctuation.
- [ ] Parser preserves raw display path for metadata.
- [ ] Parser normalizes leading `./`.
- [ ] Parser rejects absolute, home, parent traversal, Windows, URL, email, and NUL forms.

## Message Actions

- [ ] Assistant messages expose first-pass file actions.
- [ ] User messages do not expose first-pass file actions.
- [ ] System/tool messages do not expose first-pass file actions.
- [ ] Rendering messages does not call the open route.
- [ ] Clicking a file action calls the open route exactly once.
- [ ] Click payload includes raw path.
- [ ] Click payload includes line/column when parsed.
- [ ] Click payload includes message id/client id when available.
- [ ] Actions are keyboard accessible.

## Web Viewer

- [ ] Opening a file switches the right pane to file mode.
- [ ] Valid repeated click reuses the current entry/session.
- [ ] Expired or missing session creates a fresh session.
- [ ] `HEAD` runs before `GET`.
- [ ] Over-cap metadata prevents content fetch and shows too-large state.
- [ ] Markdown renders as Markdown.
- [ ] Source file renders as code.
- [ ] Unknown UTF-8 renders as plain text.
- [ ] Binary or invalid UTF-8 shows unsupported-binary state.
- [ ] Not-found response shows not-found state.
- [ ] Denial response shows denied state.
- [ ] Expired/revoked session shows expired state.
- [ ] Offline/carrier unavailable response shows offline state.
- [ ] Content identity/range mismatch shows content-changed state when available.
- [ ] Generic failures show recoverable error state.
- [ ] Reload re-fetches with a valid session.
- [ ] Close returns to terminal or prior mode.
- [ ] Copy path works.
- [ ] Copy content is enabled only for text content.

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

- [ ] Handoff documents `POST /api/threads/:thread_id/files/open`.
- [ ] Handoff documents `HEAD` and `GET` file edge routes.
- [ ] Handoff documents auth and non-owner behavior.
- [ ] Handoff documents relative-path-only first-pass scope.
- [ ] Handoff includes request and response examples.
- [ ] Handoff includes parser rules.
- [ ] Handoff includes 1 MiB display cap.
- [ ] Handoff includes status-code-to-UI-state guidance.
- [ ] Handoff includes line/column metadata behavior.
- [ ] Handoff includes session reuse guidance.

## Documentation

- [ ] `docs/proto.md` describes the new route and file viewer flow.
- [ ] `service/src/routes/routes.spec.md` describes the thread file-open route.
- [ ] `service/src/files/files.spec.md` describes viewer-scoped session defaults.
- [ ] Web specs describe parser/actions/viewer behavior.
- [ ] [file-viewer.spec.md](./file-viewer.spec.md) matches the plan folder contents.
- [ ] [../../bud.spec.md](../../bud.spec.md) links this implementation plan.
