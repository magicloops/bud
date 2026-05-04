# Implementation Spec: File Viewer Current-CWD Resolution

**Status**: Draft
**Created**: 2026-05-03
**Design Doc**: [../../design/daemon-owned-file-path-resolution.md](../../design/daemon-owned-file-path-resolution.md)
**Folder Spec**: [improve-file-cwd.spec.md](./improve-file-cwd.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-pane-current-path-spike.md](./phase-0-pane-current-path-spike.md)
**Phase 1**: [phase-1-service-terminal-context.md](./phase-1-service-terminal-context.md)
**Phase 2**: [phase-2-daemon-cwd-first-resolution.md](./phase-2-daemon-cwd-first-resolution.md)
**Phase 3**: [phase-3-ui-diagnostics-and-docs.md](./phase-3-ui-diagnostics-and-docs.md)

---

## Context

The file viewer currently creates short-lived `file_session` rows from user-clicked, workspace-relative paths. The web/mobile contract is intentionally simple: the user clicks a relative path from an assistant message, the service authorizes the thread, and the existing file edge streams `HEAD` / `GET` through daemon `file_open`.

The failure mode is path base selection. The daemon file adapter resolves:

```text
workspace_root + relative_path
```

For a machine-wide Bud whose workspace root is `~`, a path emitted while the terminal is in `~/bud/service` resolves incorrectly:

```text
src/files/file-session.ts -> ~/src/files/file-session.ts
```

The narrow improvement is:

```text
src/files/file-session.ts -> <fresh tmux pane cwd>/src/files/file-session.ts
fallback -> <workspace root>/src/files/file-session.ts
```

The service should not track cwd. The daemon should query tmux once per file-open operation when terminal context is available, then apply the same local policy checks it already applies today.

## Objective

Implement current-terminal-directory-first file resolution for relative file viewer paths:

1. validate tmux `pane_current_path` behavior before code changes
2. pass thread terminal context from service file edge to daemon `file_open`
3. extend the daemon file-open frame with optional terminal context
4. resolve relative file paths against fresh tmux pane cwd before workspace root
5. preserve existing workspace fallback, root policy, symlink rejection, content identity, byte caps, and viewer behavior
6. add lightweight resolution-basis metadata for logs, diagnostics, and optional UI copy

## Fixed Decisions

- First implementation keeps relative path inputs only.
- `POST /api/threads/:thread_id/files/open` remains the product route.
- `HEAD` / `GET /api/files/:file_session_id` remain the byte-serving routes.
- No new browser/mobile request fields are required.
- No standalone `file_resolve` frame is added.
- No database migration is required unless implementation deliberately persists new metadata.
- The daemon queries tmux at most once per `file_open`.
- If both terminal-cwd and workspace candidates exist, terminal-cwd wins for this slice.
- If terminal cwd is unavailable, outside the workspace root, or missing the file, fallback behavior remains today's workspace-root resolution.
- Absolute paths, `~/...`, basename search, extra roots, directory preview, and disambiguation are deferred.

## Target Flow

```text
user clicks relative path
  |
  v
POST /api/threads/:thread_id/files/open
  |
  v
service creates viewer-owned file_session
  |
  v
web/mobile HEADs or GETs /api/files/:file_session_id
  |
  v
service sends file_open with terminal_session_id when available
  |
  v
daemon queries tmux pane_current_path once
  |
  v
daemon tries terminal-cwd candidate, then workspace candidate
  |
  v
daemon returns file_open_result and streams bytes
```

## Wire Contract

Add optional fields to `file_open`:

```json
{
  "terminal_session_id": "bud-b_123-thread-456"
}
```

Add optional accepted-result metadata to `file_open_result`:

```json
{
  "resolved_against": "terminal_cwd",
  "resolved_relative_path": "service/src/files/file-session.ts"
}
```

The exact names can change during implementation, but they should follow snake_case at the JSON/protocol boundary and map into typed protobuf fields if the active typed payload is updated.

Compatibility requirements:

- older daemons ignore missing `terminal_session_id` and continue workspace-relative behavior
- newer daemons accept old `file_open` frames without terminal context
- service treats missing `resolved_against` as `workspace` / unknown
- metadata must not be required for HTTP correctness

## Ownership And Security

The change must preserve current browser-facing boundaries:

- file sessions remain user-owned and short-lived
- all `/api/files/:file_session_id` requests authorize by `file_session.created_by_user_id`
- thread ownership is established before session creation
- the client cannot select a Bud for the thread route
- daemon remains the final local filesystem policy gate
- terminal cwd is a resolution hint, not permission
- canonical accepted paths must still remain under the daemon workspace root
- symlinks, directories, non-regular files, traversal, and unsupported roots remain denied

## Expected Code Areas

### Service

- `service/src/files/file-edge.ts`
  - include terminal context in `file_open`
  - include terminal context in operation/audit request metadata
  - optionally surface `resolved_against` metadata in audit/logging
- `service/src/files/file-runtime.ts`
  - accept optional result metadata in `FileOpenResultSchema`
- `service/src/files/file-runtime.test.ts`
  - verify metadata is parsed and preserved
- `service/src/files/files.spec.md`
  - update file-edge description

### Daemon

- `bud/src/protocol.rs`
  - add optional terminal context fields to `FileOpenFrame`
- `bud/src/files/mod.rs`
  - resolve terminal-cwd candidate first
  - preserve workspace fallback
  - include accepted-result metadata
- `bud/src/terminal/mod.rs` / related modules
  - expose a narrow method for resolving a Bud terminal session id to fresh pane cwd, or pass a cwd lookup callback into the file manager
- `bud/src/terminal/backend.rs` and `bud/src/terminal/tmux.rs`
  - no core behavior change expected; `pane_cwd(...)` already exists
- `bud/src/files/files.spec.md`, `bud/src/src.spec.md`
  - update daemon file adapter and source overview specs

### Protocol / Docs

- `docs/proto.md`
  - document optional `terminal_session_id`
  - document optional result metadata
  - clarify terminal-cwd-first fallback behavior
- `proto/bud/v1/bud.proto`
  - add fields if typed protobuf payloads are updated in this same slice
- service and daemon protobuf/wire tests if typed fields change

### Web

- existing file viewer behavior can remain unchanged
- optional copy/diagnostics can show `Opened from terminal directory` when response metadata is available
- no web parser expansion for absolute or home-relative paths

## Phase Overview

| Phase | Document | Priority | Outcome |
| --- | --- | --- | --- |
| 0 | [phase-0-pane-current-path-spike.md](./phase-0-pane-current-path-spike.md) | Urgent | Confirm tmux `pane_current_path` is reliable enough for the first resolver source |
| 1 | [phase-1-service-terminal-context.md](./phase-1-service-terminal-context.md) | Urgent | Service sends terminal session context on daemon `file_open` without changing client APIs |
| 2 | [phase-2-daemon-cwd-first-resolution.md](./phase-2-daemon-cwd-first-resolution.md) | Urgent | Daemon resolves relative paths from fresh pane cwd first, then workspace fallback |
| 3 | [phase-3-ui-diagnostics-and-docs.md](./phase-3-ui-diagnostics-and-docs.md) | High | Docs/specs/protocol/UI diagnostics describe and verify the new resolution basis |

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `pane_current_path` is stale or surprising in foreground TUIs | Medium | High | Run Phase 0 first and keep workspace fallback |
| `HEAD` and `GET` resolve to different files if cwd changes between requests | Low | Medium | Existing content identity detects mismatch; pin resolved targets later if needed |
| Service cannot find a terminal session for a file session | Medium | Low | Omit terminal context and keep workspace fallback |
| Daemon file manager cannot access terminal backend cleanly | Medium | Medium | Add a narrow cwd resolver trait/callback instead of coupling file code to terminal internals |
| Protocol additions break older daemon/service pairs | Low | High | Make all fields optional and keep old workspace path behavior |
| Metadata leaks absolute paths | Low | High | Return basis and workspace-relative path only; keep raw cwd out of browser responses by default |

## Rollout Strategy

1. Run the tmux cwd spike and record observations.
2. Land additive protocol/schema parsing for optional fields.
3. Land service terminal-context propagation with tests.
4. Land daemon terminal-cwd-first resolution with tests.
5. Update docs/specs and, if useful, UI copy.
6. Run a real-daemon smoke from a subdirectory.
7. Leave broader path support as explicit follow-up work.

## Definition Of Done

- [ ] Phase 0 observations are recorded.
- [ ] Service sends terminal session context for thread-owned file sessions when available.
- [ ] Daemon accepts old and new `file_open` frames.
- [ ] Daemon queries tmux pane cwd at most once per file-open operation.
- [ ] Daemon tries terminal-cwd-relative path before workspace-root-relative path.
- [ ] All accepted files still canonicalize under the workspace root.
- [ ] Existing symlink, directory, traversal, max-byte, and content-identity protections remain intact.
- [ ] Workspace fallback still works when terminal context is missing or unusable.
- [ ] Accepted result metadata identifies `terminal_cwd` versus `workspace` when available.
- [ ] Protocol docs and affected specs are updated.
- [ ] Focused service and daemon tests pass.
- [ ] Real-daemon smoke proves a file linked from a subdirectory opens correctly.
