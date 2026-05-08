# Design: Daemon-Owned File Path Resolution

Status: Draft

Audience: Daemon, service, web, iOS, and product

Last updated: 2026-05-03

Related:
- [file-serving-user-initiated-viewer.md](./file-serving-user-initiated-viewer.md)
- [file-viewer-path-roots-and-thread-cwd.md](./file-viewer-path-roots-and-thread-cwd.md)
- [network-upgrade-file-serving-productization.md](./network-upgrade-file-serving-productization.md)
- [../docs/proto.md](../docs/proto.md)

## Context

The first file viewer pass opens user-clicked paths by creating short-lived `file_session` rows for workspace-relative paths. The service authorizes the thread, creates the session, and `HEAD` / `GET` on the session sends daemon `file_open` work. The daemon then enforces local file policy before statting or reading.

In practice, the daemon's current `workspace` root is usually the user's home directory, while the thread's terminal frequently moves into a project or subdirectory. That means a file link such as `src/files/file-session.ts` is often interpreted as:

```text
~/src/files/file-session.ts
```

when the user expects:

```text
<current terminal directory>/src/files/file-session.ts
```

The simplest high-value change is to resolve clicked relative paths against the thread terminal's current tmux pane directory first, then fall back to the existing workspace-relative behavior.

## Product Stance

Bud's normal assumption should remain that one Bud can serve a machine and multiple threads can work in different projects. Project-scoped Buds are still a useful isolation mode, but they should not be required for file viewing to work.

This design intentionally narrows the first daemon-owned resolution slice:

- keep the current user-clicked file-session model
- keep first-pass client inputs relative-only
- do one fresh daemon-side tmux `pane_current_path` lookup per open/stat/read attempt
- try terminal-cwd-relative resolution before today's workspace-root-relative resolution
- leave absolute paths, home-relative paths, basename search, disambiguation, and broader policy roots for later

## Goals

1. Fix the common `cd project/subdir` case with minimal product and protocol churn.
2. Keep browser/mobile API behavior close to today's `POST /api/threads/:thread_id/files/open` flow.
3. Keep the daemon as the filesystem authority.
4. Avoid service-owned live-cwd tracking.
5. Preserve existing workspace-relative behavior as a fallback.
6. Make the `pane_current_path` unknown easy to test before expanding the design.

## Non-Goals

- agent-managed file reads or a model-facing file tool
- file writes, edits, uploads, or saves
- a general file browser
- absolute path support in the first slice
- `~/...` home-relative path support in the first slice
- basename-only search or fuzzy matching
- recursive filesystem search
- service-side cwd inference from prompts, commands, or cached terminal status
- requiring users to install or start one Bud per workspace

## Core Decision

For relative file viewer paths, the daemon should try the active terminal pane cwd before the existing workspace root.

Current behavior:

```text
workspace_root + relative_path
```

First daemon-owned resolution behavior:

```text
if terminal pane cwd is available:
  try pane_current_path + relative_path
fallback:
  try workspace_root + relative_path
```

Every candidate still goes through daemon policy:

- canonicalize before opening
- reject parent traversal and invalid path forms
- reject symlinks under current policy
- reject directories and non-regular files
- reject canonical paths outside the configured workspace/allowed root
- enforce max bytes and content identity rules

The service should not persist or trust the pane cwd. It only passes enough context for the daemon to find the relevant terminal session and ask tmux at the time of the file operation.

## One Fresh Tmux Pane CWD Query

"One fresh tmux pane cwd query" means:

1. A user clicks `src/foo.ts`.
2. The service authorizes the thread and opens or fetches the file session.
3. The service includes the thread terminal session id, when available, in daemon `file_open` context.
4. The daemon asks tmux for that pane's current path at that moment, equivalent to `#{pane_current_path}`.
5. The daemon tries `<pane_current_path>/src/foo.ts` if that cwd is usable and allowed.
6. The daemon falls back to the existing workspace-root path if the pane cwd is unavailable, outside policy, or does not contain the file.

This is not continuous cwd tracking. It is not a service-owned cached cwd. It is a best-effort host-local lookup for a single file operation.

The UI can expose this in display-safe language when useful:

- `Opened from terminal directory`
- `Resolved from current terminal directory`
- `Fell back to Bud workspace`

Raw absolute cwd display should remain optional and policy-aware.

## Minimal Architecture

### Browser / Mobile API

Keep the product route:

```http
POST /api/threads/:thread_id/files/open
```

The first slice should not require web or mobile to send absolute paths or resolution hints. Clients keep sending the same relative path candidate and optional line/column metadata.

### Service Flow

Keep today's service shape as much as possible:

1. authenticate the viewer
2. authorize the thread
3. derive the Bud from the thread
4. parse and validate a relative file-viewer path
5. create a short-lived viewer `file_session`
6. on `HEAD` / `GET`, include terminal-session context in the daemon `file_open` request when the file session has a thread

The route can continue creating the session before daemon stat/read. The resolution improvement can live in the edge open path, where daemon `file_open` already happens.

This should not require a database migration unless the team decides `resolved_against` or fallback reason metadata must be persisted on the `file_session`. Logging and response metadata are enough for the first validation slice.

### Daemon Flow

The daemon `file_open` handler should:

1. validate the existing `root_key` / `relative_path` frame
2. derive a candidate list
3. if terminal context is present, query `pane_current_path`
4. try `pane_current_path + relative_path`
5. fall back to `workspace_root + relative_path`
6. use the first candidate that exists, is regular, and passes policy
7. return `file_open_result` metadata indicating how the path resolved

No standalone `file_resolve` frame is required for this slice.

## Candidate Resolution Order

For accepted relative path inputs:

1. `terminal_cwd`: if a terminal session id is available and tmux returns a cwd, try cwd-relative resolution.
2. `workspace`: try the existing workspace-root-relative resolution.
3. reject with the same kind of not-found or policy-denied result the file edge already handles.

If both candidates exist and differ, first slice should prefer `terminal_cwd`.

Reasoning:

- the clicked path usually came from work happening in the current terminal context
- this avoids a disambiguation UI in the first slice
- fallback preserves today's home/workspace-relative behavior for paths such as `bud/service/src/foo.ts`
- metadata can report `resolved_against: "terminal_cwd"` or `resolved_against: "workspace"` for debugging and UI copy

## Accepted Inputs

First slice:

| Input Form | Example | Scope |
|------------|---------|-------|
| relative with separators | `src/files/file-session.ts` | Yes |
| leading `./` | `./src/main.rs` | Yes |
| line/column suffix | `src/foo.ts:12:4`, `src/foo.ts#L12` | Metadata only |

Still deferred:

| Input Form | Example | Reason |
|------------|---------|--------|
| home-relative | `~/bud/service/src/foo.ts` | Needs explicit path expansion and policy display decisions. |
| absolute POSIX path | `/Users/adam/bud/service/src/foo.ts` | Needs absolute-path policy and display decisions. |
| basename only | `foo.ts` | Needs search or stronger ambiguity handling. |
| directory | `src/files/` | Viewer currently opens files, not directories. |
| traversal | `../secrets.txt` | Keep rejected. |
| URL | `https://example.com/file.ts` | Not a local host file path. |

## Metadata

Accepted daemon `file_open_result` frames should include enough metadata for audit, debugging, and UI state:

```json
{
  "resolved_against": "terminal_cwd",
  "display_path": "src/files/file-session.ts",
  "root_key": "workspace",
  "relative_path": "service/src/files/file-session.ts"
}
```

Exact field names can follow the existing file-session serializer, but the important distinction is:

- `requested_path`: what the user clicked
- `resolved_against`: `terminal_cwd` or `workspace`
- `relative_path`: the daemon-approved workspace-relative target used for the pinned session/read, if representable

The browser does not need full absolute host paths for the first slice.

If `HEAD` and `GET` each perform their own daemon `file_open`, they may each query tmux. Existing content identity checks should prevent silently reading a different file if the terminal cwd changes between stat and read. Persisting a pinned resolved target can be a later hardening step if this edge shows up in practice.

## Policy Model

The first slice should not broaden local file permissions.

Keep current daemon constraints:

- only the configured workspace root is readable
- default workspace root may be home for a machine-wide Bud
- canonical resolved targets must stay under that root
- only regular files are served
- symlinks remain denied
- viewer sessions keep the 1 MiB display byte cap

If `pane_current_path` is outside the workspace/allowed root, skip terminal-cwd resolution and fall back to workspace-root resolution.

## Error Model

Reuse the current file-edge error model where possible.

New or clarified reasons:

| Reason | Meaning |
|--------|---------|
| `terminal_cwd_unavailable` | Tmux did not return a usable cwd; fallback was used. Likely debug metadata, not user-facing failure. |
| `terminal_cwd_outside_root` | Pane cwd was outside allowed policy; fallback was used. Likely debug metadata, not user-facing failure. |
| `not_found` | Neither terminal-cwd nor workspace candidate produced an allowed regular file. |
| `policy_denied` | A candidate existed but failed daemon policy. |

The user-facing copy can stay simple:

- `File not found from the current terminal directory or Bud workspace.`
- `This file is outside the Bud file-viewer scope.`

## Test Spike: Does `pane_current_path` Hold Up?

Before building broader resolver behavior, validate tmux behavior directly.

Cases to test on macOS:

1. plain shell at `~`
2. shell after `cd ~/bud/service`
3. long-running foreground command from a subdirectory
4. `less` / pager from a subdirectory
5. editor or TUI from a subdirectory
6. REPL from a subdirectory
7. Codex/Claude-style TUI from a subdirectory, if practical
8. nested shell after `cd`
9. process started from one cwd that later changes cwd internally, if easy to construct

Validation question:

Does tmux report the host directory that matches where users expect relative file paths to resolve while these programs are active?

If the answer is mostly yes, this first slice likely covers the large majority of useful file links. If not, the broader resolver/search work should be revisited before implementation.

## Phased Plan

### Phase 0: Validate Tmux CWD Behavior

Run a small manual or scripted spike against tmux `pane_current_path` for the cases above.

Deliverable:

- debug note or design appendix with observed behavior
- explicit go/no-go for `pane_current_path` as the first resolver source

### Phase 1: Pass Terminal Context To Daemon File Open

Extend the service file edge to include the thread's active terminal session id, when available, on daemon `file_open`.

Scope:

- preserve existing file-session create route behavior
- no absolute path support
- no new browser/mobile API shape
- add tests that thread-owned file sessions include terminal context when opened

### Phase 2: Daemon Tries Pane CWD First

Update daemon `file_open` resolution.

Scope:

- query tmux pane cwd at most once for a file operation
- try `pane_current_path + relative_path`
- fall back to current `workspace_root + relative_path`
- canonicalize and enforce the same current policy for both candidates
- return `resolved_against` metadata
- add daemon unit tests for candidate ordering and policy rejection

### Phase 3: UI Copy And Diagnostics

Expose resolution basis lightly.

Scope:

- viewer can show `Opened from terminal directory` or `Opened from Bud workspace`
- errors mention both current terminal directory and Bud workspace
- logs/audit include cwd-query fallback reasons for debugging

### Later: Broader Daemon-Owned Resolution

Only after this slice proves useful:

- absolute path support
- `~/...` support
- configured extra roots
- basename search
- ambiguity/disambiguation UI
- standalone `file_resolve` frame if needed

## Open Questions

1. Does tmux `pane_current_path` remain useful while foreground TUIs, editors, pagers, and REPLs are active?
2. How does the daemon map a thread file session to the correct terminal pane when a terminal has not been created yet?
3. If the pane cwd candidate and workspace candidate both exist, is `terminal_cwd` precedence always acceptable for first slice?
4. Should `terminal_cwd_unavailable` and fallback reasons be stored on `file_session.display_metadata`, audit only, or logs only?
5. Should the UI display any root label for the Bud workspace, or only generic copy?

## Known Unknowns

- Tmux `pane_current_path` behavior for TUIs and processes that change cwd internally.
- Whether relative paths emitted by sub-agents or tools usually align with the pane cwd.
- Whether the current daemon workspace root is always broad enough for pane-cwd candidates in machine-wide Bud usage.
- How this behaves for remote shells, `ssh`, containers, or devcontainers where the visible path may not be a host path.

## Recommendation

Implement the narrow `pane_current_path`-first resolution slice before broader daemon-owned path resolution.

This changes the file viewer from "home/workspace-relative only" to "current terminal directory first, workspace fallback" while preserving the current user-clicked session model and daemon policy boundary. It should cover most project/subdirectory file links and gives us a concrete way to test the biggest unknown before adding absolute paths, search, or disambiguation.
