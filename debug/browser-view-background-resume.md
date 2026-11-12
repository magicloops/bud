# Debug: Browser view disappears after switching tabs

## Environment
- macOS, Chrome, local service on port 3000 and Vite on port 5173.
- Branch: `browserview`, after the development WebSocket proxy fix.

## Repro Steps
1. Open a thread with a live browser view.
2. Switch to another browser tab, then return to Bud.
3. The browser canvas is blank while the toolbar still says Watching agent.

## Observed
- The visibility handler calls `failPrivate` for both passive and private viewers.
- That clears and closes the media client before its close callback runs, so the
  callback is correctly ignored but the connected UI state remains true.
- Visibility is absent from the media effect's dependencies. Refreshing unchanged
  session metadata on return does not create a replacement media client.

## Expected
- Hidden views detach media and release any private lease.
- Returning to Bud attaches a fresh passive view even if session metadata has not
  changed. Private control is never acquired automatically.

## Proposed Fix
- Track page visibility in the viewer and gate live/saved media work on it.
- Clear connection state explicitly when detaching, retaining late-callback fences.
- Reattach on visibility restoration, including page restoration after pagehide.
- Add mounted passive/private lifecycle regression coverage and update
  `web/src/features/browser/browser.spec.md`.

## Ownership
- No route, schema, or authorization changes. Media remains bound to the existing
  session and viewer, using the current ownership checks and tickets.
- Backgrounding releases only this viewer's exact private override.

## Validation
- Before the fix, running from `web/`:
  `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/state-feed.test.tsx`
  reproduced the passive failure: `returning to unchanged session metadata
  attaches fresh media`, `1 !== 2` (one attachment instead of two).
- After the fix, the following command passed all 25 tests, including passive and
  private visibility restoration, pagehide/pageshow, late callbacks, mobile
  suspension, takeover, input fencing and authorization loss:
  `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/state-feed.test.tsx src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx src/features/browser/mobile-bridge.test.tsx`
- `pnpm build` passed. Vite reported its existing large-chunk warning.
- Live Chrome check: switched from the local Bud tab to a blank tab and back.
  The previous connection closed at 08:41:55 UTC; a fresh connection opened on
  return at 08:42:01 UTC, drew its first frame in 140 ms, and displayed the page
  with Watching agent / Take control. No reload or control acquisition was needed.

## Rollout
- Web-only change; reload the deployed web client after deploying it. Local Vite
  hot reload is already serving the fix. No daemon/service restart or migration.
