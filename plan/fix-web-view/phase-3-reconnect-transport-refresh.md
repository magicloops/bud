# Phase 3: Reconnect Transport Refresh

## Context

After the iframe lifecycle and active-site form fixes were validated, a follow-up
reconnect issue appeared. When a Bud reconnects, the Terminal view recovers, but
the embedded Web view can remain stuck on:

```text
Bud is offline, so this proxied site cannot be reached
```

Clicking the Web view refresh icon briefly changes state but returns to the same
message. Opening the proxied route in a new tab works, and refreshing the whole
Bud web app page restores the embedded Web view.

The debug pass found that `useWebView(...)` stores a REST snapshot of proxy
transport availability. The refresh button only mints a new viewer grant; it
does not refresh the site list, thread attachment, or proxy transport snapshot.

Related debug note:

- [../../debug/web-proxy-reconnect-stale-offline-transport.md](../../debug/web-proxy-reconnect-stale-offline-transport.md)

## Objective

Make Web view recovery converge after Bud reconnect without requiring a whole
page refresh, while preserving the Phase 1 behavior that ordinary Terminal/Web
tab switches do not reload the iframe.

## Scope

- Make explicit Web view Reload refresh current Web view/site/transport state
  before applying a new iframe grant.
- Add a guarded automatic refresh after terminal reconnect when the current Web
  view transport snapshot is unavailable.
- Keep the existing one-time viewer-grant service contract unchanged.
- Keep standalone open behavior unchanged for connected Buds.

## Non-Goals

- No service route changes.
- No daemon protocol changes.
- No new SSE event family for Web view transport state.
- No broad Web view UI redesign.
- No change to normal tab-switch behavior.
- No standalone-open disabled-state change in this phase, unless it falls out
  naturally from shared disabled logic.

## Design / Approach

### Authoritative Reload

Change `useWebView.reloadWebView()` so explicit Reload refreshes the stale state
that can actually block rendering:

- fetch the current Bud proxied-site list
- fetch the current thread Web view attachment
- update top-level `transport` and `websocketTransport`
- update `activeWebView` and its serialized `proxied_site.transport`
- mint and apply a fresh viewer grant for the refreshed active site/path

The simplest implementation can route Reload through the existing
`refreshWebViews()` flow, because that flow already fetches both REST resources
and then mints the iframe grant for the active thread attachment.

Tradeoff: explicit Reload becomes a slightly heavier operation, but it is a
user-initiated recovery action and should be authoritative.

### Guarded Reconnect Refresh

In `/$budId/$threadId`, terminal recovery already exposes
`terminalConnection`. Add a small guarded effect that runs when terminal
connection transitions into `connected`.

The effect should call `webView.refreshWebViews()` only when all are true:

- the current thread has an active Web view
- the previous/current Web view HTTP transport snapshot is unavailable
- the terminal has just transitioned into `connected`

This avoids reloads for healthy Web views and avoids repeated refreshes from
terminal heartbeats, status events, or ordinary tab changes.

Prefer the terminal `connected` transition over raw `BudStatusContext` changes:

- it fires after terminal recovery has proven the service can route work to the
  Bud
- it avoids adding another consumer of global Bud status for this narrow thread
  recovery behavior

### No Tab-Switch Reload

Do not use `viewMode` as a refresh trigger. Phase 1 intentionally keeps the
iframe mounted and hidden while Terminal is active; this phase should not
restore a reload-on-tab-switch behavior.

## Implementation Steps

1. Update `web/src/features/threads/use-web-view.ts`:
   - change `reloadWebView()` to refresh Web view/site/transport state before
     applying the new iframe grant
   - preserve sequence guards so stale concurrent refreshes cannot win
   - keep mount-time and tool-result `refreshWebViews()` behavior unchanged
2. Update `web/src/routes/$budId/$threadId.tsx`:
   - track the previous `terminalConnection`
   - when it transitions into `connected`, call `webView.refreshWebViews()` if
     the current Web view has an active site and unavailable HTTP transport
   - guard against repeated refreshes while terminal remains connected
3. Update specs:
   - `web/src/features/threads/threads.spec.md`
   - `web/src/routes/$budId/budId.spec.md`
   - `web/src/components/workbench/workbench.spec.md` if reload/disabled copy
     changes
4. Keep `WebViewPane` rendering behavior unchanged unless the implementation
   needs a small prop or disabled-state adjustment.

## Edge Cases

- If the Bud is still genuinely unavailable after terminal reconnect, the REST
  refresh should keep the unavailable message.
- If terminal reconnect flaps, the transition guard should prevent repeated
  iframe reloads while the connection stays `connected`.
- If there is no active Web view, reconnect should do nothing.
- If the Web view transport is already available, reconnect should not reload a
  healthy iframe.
- If the thread attachment disappears during reconnect, Reload should converge
  to the normal "No web view selected" state.

## Test Plan

Automated, if practical:

1. Add hook or route-level coverage for Reload calling the full Web view refresh
   path rather than only the viewer-grant path.
2. Add route-level coverage for the terminal reconnect transition guard:
   - unavailable Web view transport + reconnect to `connected` triggers one
     refresh
   - available Web view transport + reconnect to `connected` triggers no
     refresh
   - staying `connected` does not repeatedly refresh

Manual:

1. Open a working attached Web view.
2. Disconnect the Bud and confirm the Web pane shows the unavailable transport
   message.
3. Reconnect the Bud.
4. Confirm Terminal recovers.
5. Confirm the Web pane either recovers automatically or recovers when clicking
   Reload.
6. Confirm browser network logs show REST refresh of:
   - `/api/buds/:budId/proxied-sites`
   - `/api/threads/:threadId/web-view`
7. Confirm ordinary Terminal/Web tab switching does not reload a healthy iframe.
8. Confirm a still-offline Bud continues to show the unavailable transport
   message.

Recommended package checks:

```bash
pnpm --dir /Users/adam/bud/web test
pnpm --dir /Users/adam/bud/web lint
pnpm --dir /Users/adam/bud/web build
```

## Acceptance Criteria

- Explicit Reload clears stale offline Web view transport when the Bud is
  actually connected.
- Bud reconnect triggers at most one guarded Web view refresh for an active Web
  view with unavailable transport.
- Healthy Web views are not reloaded by terminal heartbeats, status events, or
  ordinary Terminal/Web tab switches.
- The iframe lifecycle preservation from Phase 1 remains intact.
- No service, DB, daemon, Cloudflare, or mobile contract changes are required.
