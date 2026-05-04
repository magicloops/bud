# Design: File Viewer Overlay Actions

Status: Draft

Audience: Web UI

Last updated: 2026-05-04

## Context

The file viewer chrome went through two small layout experiments:

- moving the full file header from the top to the bottom
- replacing the bottom header with a lightweight bottom gradient

The bottom file identity was useful for review, but the simpler product direction is now to remove bottom file chrome entirely. The file viewer should maximize file content and keep all actions in one quiet top-right overlay.

## Goals

1. Remove the bottom path / metadata component from the file viewer.
2. Keep content starting at the top of the viewer while action buttons overlay the content.
3. Put file path copying in the top-right action cluster as a link icon.
4. Keep copy-content, reload, and close actions in the same top-right cluster.
5. Keep the change presentation-only: no file-session, path-resolution, terminal-preservation, or fetch-flow changes.

## Non-Goals

- tabbed file viewer UI
- line/column scrolling or highlighting
- Markdown-preview recursive file links
- new file metadata fields
- changes to file session reuse, reload, or authorization behavior

## Proposed Layout

The file viewer pane has two layers:

1. **Scrollable file content**
   - Takes the full pane.
   - Uses normal viewer padding.
   - Starts at the top of the view; it does not reserve top space for the overlay controls.

2. **Top-right action overlay**
   - Absolutely positioned at the pane's top-right.
   - Contains, left to right:
     - copy path
     - copy content
     - reload
     - close
   - Buttons are always visible for mobile/touch, transparent by default, and visually quiet until hover/focus.
   - Copy path is disabled until an entry exists.
   - Copy content remains disabled unless the current entry is ready and text content exists.

## Interaction Details

- The link icon copies the full relative path.
- The content copy icon copies file contents when ready.
- Both copy actions use checkmark feedback after success.
- Reload keeps the current loading spinner behavior.
- Close returns to the previous non-file workspace view exactly as it does today.
- All icon buttons use pointer cursor when interactive.

## Implementation Scope

Expected code changes:

- `web/src/components/workbench/file-viewer-pane.tsx`
  - remove the bottom path / metadata gradient
  - add a path-copy icon button before the content-copy button
  - keep existing copy/reload/close callbacks and state
- `web/src/components/workbench/workbench.spec.md`
  - update the file viewer description to match the simplified chrome

No backend, service route, daemon, protocol, or route-state changes are expected.

## Acceptance Criteria

- No bottom path or metadata component is rendered.
- Copy path, copy content, reload, and close are all in the top-right overlay.
- The copy path button uses a link icon and copies the full relative path.
- File content starts at the top of the view.
- `pnpm --dir /Users/adam/bud/web build` passes.
