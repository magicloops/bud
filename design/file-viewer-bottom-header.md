# Design: File Viewer Bottom Header

Status: Draft

Audience: Web UI

Last updated: 2026-05-05

## Context

The file viewer chrome has been tested with a top-right overlay, a bottom gradient, and a bottom header. After reviewing the interaction, the preferred direction is to restore the bottom header because it keeps the file identity and file actions together without covering file content.

This remains a presentation-only change. File sessions, path resolution, terminal preservation, authorization, and fetch behavior are unchanged.

## Goals

1. Render the file viewer chrome as a bottom header.
2. Show the active filename in the bottom header.
3. Let clicking the filename copy the full relative path.
4. Keep copy-content, reload, and close controls in the same bottom header.
5. Use a compact treatment that fits the existing workbench without feeling heavy.

## Non-Goals

- tabbed file viewer UI
- line/column scrolling or highlighting
- Markdown-preview recursive file links
- new file metadata fields
- changes to file session reuse, reload, or authorization behavior

## Proposed Layout

The file viewer pane uses normal flex layout:

1. **Scrollable file content**
   - Takes the available space above the header.
   - Uses normal viewer padding.
   - Is not covered by overlay controls.

2. **Bottom header**
   - Sits below the scrollable content as a normal flex child.
   - Uses a compact surface: the normal app `background` surface, black top border, reduced height.
   - Left side shows a file icon and filename.
   - Right side contains quiet full-opacity copy-content, reload, and close icon buttons without neobrutalist borders.
   - Button hover states use a black/white tint so they remain visible in both light and dark mode.

## Interaction Details

- Clicking the filename copies the full relative path.
- Filename copied state uses a visible `Copied` label and green text feedback.
- Copy-content copies file contents when ready.
- Reload keeps the current loading spinner behavior.
- Close returns to the previous non-file workspace view exactly as it does today.
- Controls remain disabled when their backing action is not available.

## Implementation Scope

Expected code changes:

- `web/src/components/workbench/file-viewer-pane.tsx`
  - move controls from the top-right overlay back to a bottom header
  - remove the separate path-copy icon
  - use the filename as the path-copy trigger
  - keep existing copy/reload/close callbacks and state
- `web/src/components/workbench/workbench.spec.md`
  - update the file viewer description to match the bottom header

No backend, service route, daemon, protocol, or route-state changes are expected.

## Acceptance Criteria

- The file viewer has no top-right action overlay.
- The bottom header shows the filename on the left and file controls on the right.
- The bottom header is shorter than the first restored version, uses the app background surface, and its icon controls do not use neobrutalist button borders.
- Clicking the filename copies the full relative path.
- File content is not obscured by viewer chrome.
- `pnpm --dir /Users/adam/bud/web build` passes.
