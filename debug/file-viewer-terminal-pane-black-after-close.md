# Debug: File Viewer Leaves Terminal Pane Black After Close

## Environment

- Area: `web` existing-thread workspace
- Route: `web/src/routes/$budId/$threadId.tsx`
- Components/hooks reviewed:
  - `web/src/components/workbench/thread-terminal-pane.tsx`
  - `web/src/components/workbench/file-viewer-pane.tsx`
  - `web/src/features/threads/use-terminal-session.ts`
  - `web/src/features/threads/use-file-viewer.ts`
- Reported behavior date: 2026-05-04

## Repro Steps

1. Open an existing thread with a visible terminal.
2. Click a file path in an assistant message.
3. Confirm the file viewer opens and renders the file correctly.
4. Close the file viewer or switch back to Terminal.
5. Observe the right pane.

## Observed

- The terminal status bar comes back and shows `Terminal: ready`.
- The terminal content area is black/empty.
- Refreshing the page restores the terminal content.
- Switching to the Web view placeholder and back does not trigger the issue.

## Expected

- Returning from File view should show the same xterm instance/content as before, or should reattach/replay terminal history into a new xterm container.

## Current Implementation Findings

- `/$budId/$threadId.tsx` switches to file mode by replacing the entire right pane:
  - `viewMode === 'file' ? <FileViewerPane ... /> : <ThreadTerminalPane ... />`
  - See `web/src/routes/$budId/$threadId.tsx:453`.
- Closing the file viewer calls `closeFileViewer()` and sets `viewMode` back to `terminal`.
  - See `web/src/routes/$budId/$threadId.tsx:289`.
- Web view behaves differently: `ThreadTerminalPane` remains mounted, overlays the placeholder, and marks the terminal container `invisible`.
  - See `web/src/components/workbench/thread-terminal-pane.tsx:76` and `web/src/components/workbench/thread-terminal-pane.tsx:91`.
- `useTerminalSession(...)` owns `terminalRef` and `fitAddonRef`, while `ThreadTerminalPane` owns only the DOM node assigned to `terminalPaneRef`.
  - Terminal creation only runs when `terminalPaneRef.current` exists and `terminalRef.current` is null.
  - See `web/src/features/threads/use-terminal-session.ts:153`.
- The terminal initialization effect does not depend on `viewMode` or on the ref target changing, and refs do not trigger effects by themselves.
  - See `web/src/features/threads/use-terminal-session.ts:341`.
- Output events keep writing to `terminalRef.current` if it exists.
  - See `web/src/features/threads/use-terminal-session.ts:727`.
- The hook can refresh history through `refreshTerminalSnapshot(...)`, which resets the current xterm and replays terminal history, but that only runs as part of recovery paths.
  - See `web/src/features/threads/use-terminal-session.ts:463` and `web/src/features/threads/use-terminal-session.ts:564`.

## Hypotheses

1. **Most likely: File view unmounts the xterm host DOM while the hook keeps the xterm instance.**
   The file pane replaces `ThreadTerminalPane`, so React removes the div that xterm opened into. The hook remains mounted and keeps `terminalRef.current`, so when the terminal pane remounts the init effect does not create/open a new xterm instance in the new div. This matches why Web view works: the terminal DOM is never unmounted there.

2. **The returning terminal pane is an empty new container, but UI state suppresses the empty-terminal overlay.**
   `terminalHasOutput` can remain true from before file mode, while the new `terminalPaneRef` div has no xterm DOM/content. The status bar can truthfully show `ready`, but the content region is just the black container.

3. **Output and history continue targeting a detached xterm instance.**
   While File view is open, terminal SSE remains attached and writes to `terminalRef.current`. If that xterm's element was removed with the old pane, new output updates the xterm buffer but not the newly mounted terminal container. A full page refresh works because the hook reconstructs xterm and replays history from the service.

4. **Returning from file mode does not force a fit or history replay.**
   `fitTerminal()` runs on `threadPanelOpen` changes, initial xterm readiness, window resize, and recovery history refresh, but not on `viewMode` changes. Even if the xterm DOM survived some browser path, the return from File view has no explicit reattach/fit/replay step.

5. **Less likely: file renderer side effects.**
   `FileViewerPane`, `MarkdownContent`, and `CodeBlock` appear presentation-local. `CodeBlock` lazy-loads syntax highlighting, but there is no obvious global xterm/style mutation. The issue correlates more strongly with the route-level unmount/remount difference between File view and Web view.

## Proposed Fix Direction

Prefer preserving the terminal pane across view modes, matching the Web view behavior:

- Always render `ThreadTerminalPane` in the right pane.
- Render `FileViewerPane` as an overlay/sibling when `viewMode === 'file'`.
- Hide or disable terminal pointer input while File view is active, but keep the terminal host DOM mounted.

Alternative if unmounting remains desirable:

- Teach `useTerminalSession(...)` to detect that `terminalRef.current.element` is detached or no longer under `terminalPaneRef.current`.
- Dispose/recreate xterm or re-open/replay history when returning to `terminal`.

The preserve-mounted approach is simpler and aligns with the already-working Web placeholder behavior.

## Implemented Follow-Up

The first fix uses the preserve-mounted approach:

- `/$budId/$threadId.tsx` now always renders `ThreadTerminalPane` in the right pane.
- `FileViewerPane` renders as an absolute overlay only while `viewMode === "file"`.
- The terminal hook still receives the real `viewMode`, so keyboard/paste input remains blocked while the file overlay is active.
- The presentation prop sent to `ThreadTerminalPane` remains `terminal` or `web`, preserving the existing placeholder behavior without expanding that component's public view-mode type.
