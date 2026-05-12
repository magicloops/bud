# PR Summary: File Viewer Productization

**Branch:** `file-viewer`
**Base reviewed:** `origin/main`
**Date:** 2026-05-11

## Overview

This branch productizes user-initiated file viewing from assistant message file
references. A user can click an eligible relative or absolute POSIX file path in
an assistant message, create an authorized thread-scoped file session, and
preview the file in the web UI as Markdown, source/code, or plain UTF-8 text.

The branch also hardens relative path resolution so links work from project
subdirectories and remain stable after a thread changes projects. Markdown
previews in the web file viewer can now open absolute POSIX links through the
same user-initiated flow instead of navigating the browser to same-origin 404s.

## Product Scope

Included:

- user-clicked file opens only
- assistant-message file references in web
- workspace-relative path inputs
- daemon-preflighted absolute POSIX path inputs
- absolute POSIX links inside web Markdown previews
- line and column metadata carried through the contract
- 1 MiB display cap for the first viewer pass
- Markdown, code, and plain text preview states
- web reference implementation plus mobile-ready backend contract

Deferred:

- agent file-read authority
- home-relative `~/...`
- relative recursive clickable links inside opened Markdown files
- broad plain-text prose path detection
- binary, image, PDF, directory, and large-file viewers
- remote/container/devcontainer path mapping

## Backend And Service

- Adds `POST /api/threads/:thread_id/files/open` for the product file-open flow.
- Authorizes through the owning thread, derives the Bud from that thread, and
  stamps created file sessions with the acting user.
- Validates relative path inputs, classifies absolute POSIX inputs for daemon
  preflight, and rejects home-relative, traversal, Windows, URL, NUL, and empty
  path forms.
- Parses and carries line/column metadata from `:line`, `:line:column`, and
  `#Lline` path suffixes.
- Creates viewer-scoped `file_session` rows with `root_key: "workspace"`,
  `["stat", "read", "range"]`, short TTL, and `max_bytes: 1048576`.
- Extends file-edge request construction so thread-created sessions can include
  active terminal session context and, when available, a server-created
  `resolution_hint` from the clicked source message.
- Persists daemon-reported cwd on terminal sessions and exposes a small
  path-context helper for transcript stamping.
- Stamps user/assistant messages with `metadata.path_context` and terminal tool
  rows with `metadata.path_context_before` / `metadata.path_context_after`.
- Loads source-message path context only from the same authorized thread; missing
  or foreign source messages do not disclose cross-thread existence.
- Adds a `file_resolve` pending-result bridge for absolute POSIX preflight and
  creates normalized file sessions from daemon-approved relative paths.
- Persists daemon preflight content identity on absolute sessions and stores
  `requested_path_kind: "absolute_posix"` plus `resolved_against:
  "absolute_path"` in display metadata.

## Bud Daemon

- Resolves contextless file opens against fresh tmux `pane_current_path` first,
  then workspace root.
- Adds optional `terminal_send_result.host_cwd` and
  `terminal_observe_result.host_cwd` reporting from tmux pane cwd.
- Accepts service-created `file_open.resolution_hint.kind = "host_cwd"` for
  source-message file opens.
- Resolves context-bearing file opens against message-time cwd first, then
  workspace root, and intentionally skips click-time terminal cwd fallback.
- Keeps all existing daemon policy checks: canonical workspace containment,
  symlink denial, regular-file requirement, range/content identity checks, and
  max-byte enforcement.
- Adds metadata-only `file_resolve` / `file_resolve_result` handling for
  absolute POSIX paths.
- Advertises `files.resolve.absolute_posix` in daemon capabilities.

## Web

- Adds a shared file-path parser for local Markdown links and inline-code
  candidates, including high-confidence absolute POSIX paths.
- Adds explicit file-open actions in assistant message rendering.
- Opens absolute POSIX links inside Markdown file previews with
  `source.kind = "markdown_preview"`.
- Keeps unsupported local/relative preview links inert so they do not navigate
  to same-origin web-app 404s.
- Fixes long inline/path wrapping so file actions remain visible and messages do
  not force confusing horizontal scroll.
- Adds the right-pane file viewer state machine and pane:
  - lazy open route call only on user click
  - session reuse and reload
  - `HEAD` before `GET`
  - 1 MiB display cap enforcement
  - Markdown/code/plain text rendering
  - not-found, denied, expired, offline, too-large, content-changed,
    unsupported-binary, and generic error states
  - one fresh-session retry if the daemon reports `content_changed`
  - copy path, copy content, refresh, and close controls
- Preserves the terminal mounted while viewing files so returning to terminal
  does not show a blank xterm component.
- Moves the terminal footer/header treatment to match the file viewer layout and
  anchors xterm to avoid bottom gaps.
- Uses source-aware file-viewer keys so the same relative path from different
  assistant messages cannot reuse the wrong historic cwd file session.

## Protocol And Contracts

- Updates `docs/proto.md` for:
  - thread file-open route behavior
  - daemon `file_resolve` / `file_resolve_result`
  - daemon `file_open.resolution_hint`
  - `resolved_against: "message_cwd"`
  - terminal result `host_cwd`
  - transcript `path_context` metadata
- Updates `proto/bud/v1/bud.proto` with optional terminal result `host_cwd`
  fields and `file_resolve` / `file_resolve_result` payloads.
- Keeps wire changes additive and optional for mixed-version rollout. Older
  daemons can omit `host_cwd`; contextless opens keep terminal-cwd-first
  behavior.
- No database migration is required; the implementation reuses existing
  `terminal_session.cwd` and `message.metadata`.

## Documentation Added

- Design docs:
  - `design/file-serving-user-initiated-viewer.md`
  - `design/daemon-owned-file-path-resolution.md`
  - `design/daemon-owned-file-path-resolution-advanced.md`
  - `design/file-viewer-path-roots-and-thread-cwd.md`
  - `design/file-viewer-historic-cwd-preservation.md`
  - `design/file-viewer-bottom-header.md`
- Implementation plans:
  - `plan/file-viewer/*`
  - `plan/improve-file-cwd/*`
- Debug notes:
  - `debug/file-viewer-terminal-pane-black-after-close.md`
  - `debug/file-viewer-stale-content-identity-409.md`
  - `debug/message-file-path-overflow.md`
  - `debug/terminal-xterm-bottom-anchor.md`
- Mobile handoff:
  - `reference/IOS_FILE_VIEWER_HANDOFF.md`
  - `reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md`

## Verification

Completed automated checks:

```bash
(cd /Users/adam/bud/bud && cargo test)
(cd /Users/adam/bud/bud && cargo fmt --check)
(cd /Users/adam/bud/bud && cargo test files::)
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/proto/wire.test.ts src/runtime/terminal/request-dispatcher.test.ts src/runtime/terminal-session-manager.test.ts src/agent/transcript-writer.test.ts src/files/file-edge.test.ts src/routes/threads/files.test.ts
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/threads/messages.test.ts
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/files/file-session.test.ts src/proto/wire.test.ts src/routes/threads/files.test.ts
pnpm --dir /Users/adam/bud/service exec tsc --noEmit
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/lib/file-paths.test.ts src/components/message-renderers/roles/markdown-file-actions.test.ts src/features/threads/file-viewer-flow.test.ts
pnpm --dir /Users/adam/bud/web test
pnpm --dir /Users/adam/bud/web exec tsc -b
pnpm --dir /Users/adam/bud/web lint
pnpm --dir /Users/adam/bud/web build
git diff --check
```

Manual validation completed:

- web happy path against a real Bud flow
- foreground TUI `pane_current_path` behavior
- old assistant-message link after changing project directories in one thread
- terminal visibility after opening/closing file viewer
- file viewer header/footer control iterations

The web build currently emits the existing Vite large-chunk warning but exits
successfully.

## Remaining Follow-Ups

Non-blocking smokes deferred by decision:

- outside-workspace denial against a real daemon
- symlink/non-regular/directory denial where practical
- too-large file viewer state against a real daemon
- daemon offline/carrier unavailable mapping

Product follow-ups:

- home-relative `~/...` support
- relative Markdown-preview file links
- binary/image/PDF/directory viewers
- server-assisted path parsing or structured file references
- remote/container/devcontainer path mapping
- optional visible cwd boundary messages
- optional `terminal_ready.host_cwd` for manual terminal cwd changes that happen
  without a later terminal send/observe result

## Branch Notes

Compared to `origin/main`, this branch also contains a few adjacent docs/checklist
changes that are not core file-viewer implementation:

- `reference/IOS_LLM_MODELS_HANDOFF.md`
- `reference/MOBILE_TERMINAL_INPUT_CONTRACT_HANDOFF.md`
- `plan/init-auth/validation-checklist.md`

Decide before opening the PR whether these should remain in this branch or move
to a separate documentation-only branch.

Unrelated local scratch files are present and should not be staged:

- `git_loc_breakdown.py`
- `test_git_loc_breakdown.py`
- `worker.js`
