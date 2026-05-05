# Progress Checklist: File Viewer Current-CWD Resolution

## Phase 0: Tmux CWD Spike

- [ ] Create spike/debug note for `pane_current_path` observations
- [ ] Validate plain shell at home
- [ ] Validate shell after `cd` into project subdirectory
- [ ] Validate foreground long-running command
- [ ] Validate pager
- [ ] Validate editor/TUI
- [ ] Validate REPL
- [ ] Validate agent-style TUI if practical
- [ ] Validate nested shell
- [ ] Decide go/no-go for implementation

## Phase 1: Service Terminal Context

- [x] Identify canonical terminal session id derivation for a thread file session
- [x] Add optional terminal context to service `file_open`
- [x] Add context to durable operation/audit metadata
- [x] Update service runtime schema for optional result metadata
- [x] Add service tests for frames with and without terminal context
- [x] Add service tests for result metadata parsing
- [x] Update service file spec

## Phase 2: Daemon CWD-First Resolution

- [x] Add optional terminal context to daemon `FileOpenFrame`
- [x] Add narrow cwd resolver boundary for file manager
- [x] Query tmux cwd at most once per file-open operation
- [x] Try terminal-cwd candidate before workspace candidate
- [x] Preserve workspace fallback
- [x] Keep canonical root checks for both candidates
- [x] Return optional `resolved_against` metadata
- [x] Add daemon unit tests for candidate ordering
- [x] Add daemon unit tests for policy failures
- [x] Update daemon specs

## Phase 3: UI Diagnostics And Docs

- [x] Decide whether resolution metadata is browser-visible, headers-only, or logs/audit-only
- [x] Add lightweight UI copy if metadata is browser-visible (not applicable; metadata stays service/runtime/docs-only in this pass)
- [x] Add UI/service tests for exposed metadata if applicable (not applicable; no browser-visible metadata surface changed)
- [x] Update `docs/proto.md`
- [x] Update `proto/bud/v1/bud.proto` and wire tests if typed fields change (proto unchanged because file/proxy opens still use transitional `frame_json`; wire test updated)
- [x] Update root/spec docs
- [x] Record follow-up work for absolute paths, home-relative paths, search, and pinned resolved targets

## Verification

- [x] Run focused service tests
- [x] Run focused daemon tests
- [x] Run `cargo test` for affected daemon modules if feasible
- [x] Run service build/check if service code changed
- [ ] Run real-daemon smoke from a subdirectory
- [x] Confirm existing workspace-relative file open still works
