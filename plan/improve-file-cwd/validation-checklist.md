# Validation Checklist: File Viewer Current-CWD Resolution

## Tmux Spike

- [ ] `pane_current_path` reports home for a plain shell at `~`.
- [ ] `pane_current_path` reports project subdirectory after `cd`.
- [ ] Foreground long-running commands preserve expected cwd.
- [ ] Pager preserves expected cwd.
- [ ] Editor/TUI preserves expected cwd or observed behavior is documented.
- [ ] REPL preserves expected cwd or observed behavior is documented.
- [ ] Agent-style TUI preserves expected cwd or observed behavior is documented.
- [ ] Nested shell behavior is documented.
- [ ] Internal process cwd-change behavior is documented if tested.

## Service

- [x] Thread-owned file session sends terminal session context on `file_open`.
- [x] Bud-scoped file session without a thread omits terminal session context.
- [x] Operation request metadata includes `thread_id` and terminal session id when available.
- [x] Audit/log metadata does not include raw absolute cwd.
- [x] Older daemon-compatible frames remain valid.
- [x] `file_open_result` without resolution metadata still parses.
- [x] `file_open_result` with `resolved_against` metadata parses and preserves it.

## Daemon

- [x] Old `file_open` frames without terminal context resolve from workspace root.
- [x] Relative path resolves from terminal cwd when the file exists there.
- [x] Terminal cwd candidate wins when both terminal and workspace candidates exist.
- [x] Workspace fallback is used when terminal-cwd file is missing.
- [x] Workspace fallback is used when terminal cwd is unavailable.
- [x] Workspace fallback is used when terminal cwd is outside workspace root.
- [x] Traversal paths remain rejected.
- [ ] Absolute paths remain rejected.
- [ ] Home-relative paths remain rejected.
- [ ] Symlinks remain denied.
- [ ] Directories remain denied.
- [ ] Non-regular files remain denied.
- [x] Max-byte enforcement remains unchanged.
- [ ] Content identity mismatch remains rejected.
- [x] Accepted result metadata reports `terminal_cwd` or `workspace` when implemented.

## Browser / Product

- [ ] Existing relative file links remain openable.
- [ ] File opened from a subdirectory succeeds in the web viewer.
- [ ] File not found copy mentions current terminal directory and Bud workspace if copy changes.
- [x] UI does not reveal raw absolute cwd unless explicitly chosen.
- [x] No absolute-path file actions are introduced by this work.
- [x] No home-relative path actions are introduced by this work.

## Real-Daemon Smoke

- [ ] Start service and web.
- [ ] Start a Bud daemon with terminal/file capabilities.
- [ ] Open a thread terminal.
- [ ] `cd` into a project subdirectory.
- [ ] Produce or send an assistant message containing `src/...` relative to that subdirectory.
- [ ] Click the file action.
- [ ] Confirm `HEAD` succeeds.
- [ ] Confirm `GET` succeeds.
- [ ] Confirm the rendered file is the subdirectory-relative file, not `~/src/...`.
- [ ] Confirm a path that only exists under workspace fallback still opens.
- [ ] Confirm a missing path returns a clear not-found state.

## Documentation

- [x] [implementation-spec.md](./implementation-spec.md) matches the implemented flow.
- [x] [improve-file-cwd.spec.md](./improve-file-cwd.spec.md) lists every plan file.
- [x] `docs/proto.md` documents optional file-open context and result metadata.
- [x] `service/src/files/files.spec.md` documents terminal context propagation.
- [x] `bud/src/files/files.spec.md` documents cwd-first resolution.
- [x] `bud/src/src.spec.md` documents any daemon module contract changes.
- [x] [../../bud.spec.md](../../bud.spec.md) links this plan folder.
