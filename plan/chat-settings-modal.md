# Plan: Chat settings modal

## Objective
Move conversation Automations and Data access into a modal opened beside the transcript expand/contract control. Preserve filters, refresh, and management links.

## Approach and ownership
- Pass an optional chat-settings control through WorkspaceShell to WorkspaceTopBar; keep both chat controls together in split and full-width layouts.
- ChatDataContext owns a native modal with an accessible title, focus trapping, Escape/Close, and lazy reads while open.
- The authenticated viewer comes from AuthSession. Existing APIs authorize thread/Bud ownership before automation reads; grant/source reads remain owner-wide. No writes, row stamping, new endpoints, or protocol/schema changes.
- Remount on viewer/thread changes and abort reads on close/unmount.

## Specs and validation
- Update components, workbench and thread-route specs.
- Run focused lint and the web production build. Manually verify icon placement, both sections, keyboard dismissal/focus, and responsive layouts when browser testing is available.

## Rollout
Web-only; no service or daemon upgrade required.

## Validation result
- Focused ESLint and production build pass; build retains the existing large-chunk warning.
- Browser interaction and visual verification remain pending.
