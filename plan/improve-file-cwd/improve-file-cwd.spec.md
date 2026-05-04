# improve-file-cwd

Implementation planning documents for making file viewer paths resolve against the current thread terminal directory before falling back to the existing Bud workspace root.

## Purpose

This folder turns [../../design/daemon-owned-file-path-resolution.md](../../design/daemon-owned-file-path-resolution.md) into a phased implementation spec.

The plan assumes:

- the current user-clicked file-session workflow remains the product entry point
- first-pass browser/mobile inputs remain relative-only
- the service continues to authorize viewer-owned threads and file sessions
- the daemon remains the final filesystem policy authority
- daemon `file_open` should try tmux `pane_current_path` before the existing workspace root
- absolute paths, `~/...`, basename search, disambiguation, and broader policy roots remain deferred
- no database migration is required for the first validation slice

## Files

### `implementation-spec.md`

Parent implementation spec for the simplified file-cwd improvement.

Documents:

- target behavior
- wire-contract additions
- ownership/security constraints
- phase sequencing
- expected code areas
- risks, rollout, and definition of done

### `phase-0-pane-current-path-spike.md`

Validation spike for tmux `pane_current_path` behavior across shells, foreground commands, pagers, TUIs, REPLs, nested shells, and agent-style TUIs.

### `phase-1-service-terminal-context.md`

Service phase for attaching the thread terminal session id to daemon `file_open` frames from `openFileEdgeStream(...)`.

### `phase-2-daemon-cwd-first-resolution.md`

Daemon phase for resolving accepted relative paths against the fresh tmux pane cwd before the existing workspace-root fallback.

### `phase-3-ui-diagnostics-and-docs.md`

Client, logging, protocol, and spec cleanup phase for exposing resolution basis lightly and documenting the new behavior.

### `progress-checklist.md`

Running checklist for implementation progress.

### `validation-checklist.md`

Automated and manual validation checklist for the tmux spike, service context, daemon resolution, UI diagnostics, and docs.

## Dependencies

- [../../design/daemon-owned-file-path-resolution.md](../../design/daemon-owned-file-path-resolution.md) - simplified design and target behavior
- [../../design/file-serving-user-initiated-viewer.md](../../design/file-serving-user-initiated-viewer.md) - existing file viewer product design
- [../../plan/file-viewer/implementation-spec.md](../file-viewer/implementation-spec.md) - shipped file viewer implementation plan
- [../../docs/proto.md](../../docs/proto.md) - daemon-service file-open protocol and browser-facing file routes
- [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto) - typed BudEnvelope file-open payloads
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md) - service file-session and file-edge spec
- [../../service/src/routes/threads/threads.spec.md](../../service/src/routes/threads/threads.spec.md) - thread-scoped file-open route spec
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md) - daemon file adapter spec
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon source overview
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

- Absolute path, home-relative path, basename search, and multiple allowed-root support remain intentionally out of scope.
- If `HEAD` and `GET` resolving separately causes real mismatches, add a follow-up to pin resolved file targets on the session.
- If tmux `pane_current_path` is unreliable in important TUIs, revisit broader daemon-owned resolution before expanding UI affordances.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
