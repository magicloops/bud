# Phase 2: Daemon CWD-First Resolution

## Objective

Make daemon `file_open` resolve accepted relative paths against a fresh tmux pane cwd first, then fall back to the existing workspace root.

## Current Code

Relevant daemon files:

- `bud/src/protocol.rs`
- `bud/src/files/mod.rs`
- `bud/src/terminal/backend.rs`
- `bud/src/terminal/tmux.rs`
- `bud/src/terminal/mod.rs`
- `bud/src/app.rs`

Current `FileManager` behavior:

```rust
let relative = validate_relative_path(&frame.relative_path)?;
let candidate = self.workspace_root.join(relative);
```

Current terminal backend already exposes:

```rust
fn pane_cwd<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, String>;
```

The daemon app currently dispatches `file_open` directly to `self.file_manager.handle_open(...)`, so file resolution does not yet have access to terminal manager/backend state.

## Implementation Shape

Add a narrow cwd lookup boundary rather than coupling file code directly to terminal internals.

Possible shapes:

1. `FileManager` receives an optional async cwd resolver callback at construction.
2. `BudApp` resolves terminal context before calling `file_manager.handle_open(...)`.
3. `TerminalManager` exposes a method such as `fresh_pane_cwd_for_session_id(...)`, and `FileManager` stores a clone of `TerminalManager`.

Recommendation: prefer a small resolver trait/callback so `bud/src/files/mod.rs` remains testable and does not need to know tmux backend internals.

The resolver should:

- accept the Bud terminal `session_id` from `FileOpenFrame`
- map it to the backend session name using existing terminal naming rules
- query `pane_cwd(...)`
- return `None` on missing session, unavailable tmux, or query failure
- not create a terminal session just to resolve a file path

## Frame Changes

Update `FileOpenFrame` in `bud/src/protocol.rs`:

```rust
pub terminal_session_id: Option<String>,
```

If result metadata is added to typed structs elsewhere, keep it optional.

## Resolution Algorithm

Input:

- `frame.relative_path`
- `frame.terminal_session_id`
- daemon `workspace_root`

Steps:

1. Validate `frame` exactly as today.
2. Convert `relative_path` with existing `validate_relative_path(...)`.
3. Build candidate list:
   - if `terminal_session_id` exists and cwd resolver returns a cwd under workspace root, push `cwd + relative`
   - always push `workspace_root + relative`
4. For each candidate:
   - use `symlink_metadata`
   - if not found, continue to next candidate
   - reject symlink
   - reject non-regular files
   - canonicalize
   - reject if canonical path escapes workspace root
   - accept first candidate that passes
5. If no candidate exists, return `FILE_NOT_FOUND`.
6. If a candidate exists but fails policy, return the existing typed policy denial.

First slice should prefer terminal cwd when both candidates exist.

## Result Metadata

Accepted `file_open_result` should include optional metadata:

```json
{
  "resolved_against": "terminal_cwd",
  "resolved_relative_path": "service/src/files/file-session.ts"
}
```

Avoid returning raw absolute cwd by default.

Implementation detail:

- `resolved_relative_path` can be computed with `canonical.strip_prefix(workspace_root)` and normalized to POSIX separators.
- If strip fails, do not accept the path.

## Policy Constraints

Do not broaden the daemon file policy:

- `root_key` remains `workspace`
- `relative_path` validation remains root-relative and traversal-safe
- terminal cwd candidate must canonicalize under `workspace_root`
- symlinks remain denied
- directories and non-regular files remain denied
- content identity and max-byte checks remain unchanged

If `pane_current_path` is outside `workspace_root`, skip it and use workspace fallback.

## Tests

Add daemon unit tests for:

- workspace fallback still works without terminal context
- terminal-cwd candidate is preferred when both terminal and workspace candidates exist
- workspace fallback is used when terminal-cwd file is missing
- terminal cwd outside workspace is ignored
- terminal-cwd symlink is denied
- terminal-cwd directory/non-regular file is denied
- expected content identity still rejects changed files
- `resolved_against` metadata is returned for terminal and workspace candidates

If the current `FileManager` tests need filesystem fixtures, use temp directories under the test runtime. Do not depend on the real developer home directory.

## Spec Updates

Update in the same implementation slice:

- `bud/src/files/files.spec.md`
- `bud/src/src.spec.md`
- `docs/proto.md`
- `proto/bud/v1/bud.proto` / `bud/src/proto_wire.rs` if typed payloads are updated

## Acceptance Criteria

- Daemon supports old `file_open` frames without terminal context.
- Daemon queries cwd at most once for a frame with terminal context.
- Relative paths from a subdirectory resolve via pane cwd.
- Existing workspace-root behavior remains the fallback.
- No absolute path support is added accidentally.
