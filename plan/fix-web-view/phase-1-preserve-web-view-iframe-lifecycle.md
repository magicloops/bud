# Phase 1: Preserve Web View Iframe Lifecycle

## Context

The current workbench composition preserves the terminal DOM when Web view is
active, but it removes the Web view overlay when Terminal is active. Because
`useWebView` holds the original one-time `bootstrap_url`, remounting the iframe
after a Terminal/Web tab switch replays a consumed viewer grant and the service
returns `invalid_viewer_grant`.

## Objective

Keep the Web view subtree mounted for the lifetime of the thread workbench so
ordinary Terminal/Web tab switches preserve the iframe instead of recreating it.

## Scope

- Change `ThreadTerminalPane` so `webViewPane` is mounted whenever present.
- Toggle Web view visibility and interactivity from `viewMode`.
- Preserve current terminal, file-overlay, and Web view layering behavior.
- Avoid adding tab-switch refresh or grant-minting side effects.

## Non-Goals

- No iframe bootstrap state machine.
- No change to viewer-grant API responses.
- No proxy gateway changes.
- No standalone-open behavior changes.

## Implementation Steps

1. Update `web/src/components/workbench/thread-terminal-pane.tsx` so the Web
   view overlay is rendered whenever `webViewPane` is non-null.
2. Replace conditional rendering with CSS classes that:
   - show the overlay above the terminal only when `viewMode === "web"`
   - hide the overlay while Terminal is active
   - disable pointer events while hidden
   - keep the subtree mounted so iframe state is preserved
3. Confirm the file overlay still wins above both terminal and Web view when a
   file is open.
4. Confirm the terminal host remains mounted and usable when returning from Web.
5. Confirm no code path mints a viewer grant solely because `viewMode` changes.
6. Update `web/src/components/workbench/workbench.spec.md`.
7. Update `web/src/routes/$budId/budId.spec.md` if route composition changes.

## Edge Cases

- If no Web view has been opened yet, the hidden overlay may still mount an
  empty Web view pane. That is acceptable if it stays inert and does not create
  a grant by itself.
- Hidden iframes keep timers, HMR sockets, and local app state running. This is
  intentional for UX and matches the goal of not reloading on tab switches.
- If a viewer session cookie expires while the iframe is already loaded, this
  phase does not add proactive renewal. Explicit Reload/Open remain the recovery
  paths.

## Test Plan

Automated, if practical:

1. Component-render `ThreadTerminalPane` with a sentinel `webViewPane`.
2. Switch `viewMode` from Web to Terminal to Web.
3. Assert the sentinel subtree remains mounted rather than remounted.

Manual:

1. Open a proxied Web view.
2. Switch Terminal -> Web at least three times.
3. Confirm the iframe does not visibly reload.
4. Confirm DevTools does not show another request to the same
   `/__bud/bootstrap?grant=...` URL.
5. Confirm the proxied app remains interactive and HMR still works.

## Acceptance Criteria

- Terminal/Web tab switching keeps the same iframe instance alive.
- No `invalid_viewer_grant` response occurs from tab switching.
- No viewer-grant API call happens only because the user changed tabs.
- Explicit Reload/Open still mint fresh grants and recover a broken Web view.
