# Debug: Web Proxy Reconnect Stale Offline Transport

## Environment

- Date: 2026-05-18
- Workspace: `/Users/adam/bud`
- Reported environment: web client after `*.bud.show` staging/local web-view
  validation
- Client behavior confirmed by user:
  - iframe lifecycle preservation works
  - active-site Port field sync works
  - terminal view recovers when the Bud reconnects
  - Web view remains on the offline transport message until whole-page refresh
- Investigation method: static implementation review only; no code changes made

## Repro Steps

1. Open a thread with an attached proxied Web view.
2. Put the Bud offline or reconnect it in a way that makes the Web view show:
   `Bud is offline, so this proxied site cannot be reached`.
3. Reconnect the Bud.
4. Observe the Terminal view recover and show current terminal state.
5. Switch to or stay on the Web view.
6. Click the Web view refresh icon.
7. Observe a brief loading/authorizing state, then the same offline transport
   message remains.
8. Click Open in new tab.
9. Observe the proxied route load externally.
10. Refresh the whole Bud web app page.
11. Observe the embedded Web view load correctly.

## Observed

- Terminal recovery works.
- The embedded Web view's transport state remains stale after Bud reconnect.
- The Web view refresh icon changes status briefly but does not clear the
  offline transport gate.
- Open in new tab can still work because it mints a fresh grant and navigates
  outside the in-pane transport gate.
- Full page refresh works because it remounts `useWebView(...)` and reloads the
  current transport snapshot from REST.

## Expected

- When a Bud reconnects and terminal recovery succeeds, the Web view should
  update its HTTP/WebSocket proxy transport snapshot.
- Clicking the Web view refresh icon should be an authoritative recovery path:
  it should refresh the active site/transport state before or while minting a
  new iframe grant.
- If the Bud is truly unavailable, standalone-open controls should probably be
  disabled or should show a clear unavailable state. That is related UX work,
  not the root cause of this stale embedded state.

## Reviewed Files

- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/features/threads/use-web-view.ts`
- `web/src/components/workbench/web-view-pane.tsx`
- `web/src/features/threads/use-terminal-session.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/contexts/bud-status-context.tsx`
- `web/src/contexts/bud-status-provider.tsx`
- `web/src/contexts/contexts.spec.md`
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxy-session.ts`
- `service/src/runtime/terminal-session-manager.ts`

## Current Flow

### Initial Web View Load

1. `useWebView.refreshWebViews()` calls:
   - `GET /api/buds/:budId/proxied-sites`
   - `GET /api/threads/:threadId/web-view`
2. The service computes current proxy transport from runtime data-plane state
   with `resolveProxyTransportStatus(...)`.
3. The hook stores the response in local React state:
   - `transport`
   - `websocketTransport`
   - `activeWebView`
4. `WebViewPane` computes:

```ts
const transportAvailable = transport?.available ?? activeSite?.transport?.available ?? true
const iframeUrl = !activeSiteUnavailable && transportAvailable ? iframeSrc : null
```

5. If `transport.available` is `false`, the pane renders the offline message
   instead of the iframe.

Relevant code:

- `web/src/features/threads/use-web-view.ts:113`
- `web/src/features/threads/use-web-view.ts:137`
- `web/src/features/threads/use-web-view.ts:152`
- `web/src/components/workbench/web-view-pane.tsx:59`
- `web/src/components/workbench/web-view-pane.tsx:67`
- `web/src/components/workbench/web-view-pane.tsx:295`
- `web/src/components/workbench/web-view-pane.tsx:305`

### Bud Reconnect

1. Terminal SSE receives `terminal.bud_online`.
2. `useTerminalSession(...)` updates `BudStatusContext` to `online`.
3. `useTerminalSession(...)` calls terminal recovery.
4. The terminal view refreshes from `/terminal/ensure` and `/terminal/history`.
5. `useWebView(...)` does not consume `BudStatusContext`, terminal connection
   state, or any Bud-online callback.
6. The previously stored `transport.available === false` remains in Web view
   state.

Relevant code:

- `web/src/features/threads/use-terminal-session.ts:807`
- `web/src/features/threads/use-terminal-session.ts:813`
- `web/src/features/threads/use-terminal-session.ts:817`
- `web/src/routes/$budId/$threadId.tsx:85`
- `web/src/routes/$budId/$threadId.tsx:140`

### Web View Refresh Button

1. The refresh icon calls `webView.reloadWebView`.
2. `reloadWebView()` only calls `requestViewerGrant(activeSite, activePath, ...)`.
3. `requestViewerGrant(...)` updates `iframeSrc`, `grantExpiresAt`, and
   `status`.
4. It does not refresh:
   - `transport`
   - `websocketTransport`
   - `activeWebView.proxied_site.transport`
5. `WebViewPane` still gates the iframe behind the stale
   `transport.available === false`, so the new `iframeSrc` is ignored and the
   offline message remains.

Relevant code:

- `web/src/features/threads/use-web-view.ts:84`
- `web/src/features/threads/use-web-view.ts:105`
- `web/src/features/threads/use-web-view.ts:286`
- `web/src/features/threads/use-web-view.ts:293`
- `web/src/components/workbench/web-view-pane.tsx:59`
- `web/src/components/workbench/web-view-pane.tsx:67`

### Open In New Tab

1. Standalone open also mints a fresh grant.
2. It then navigates a top-level popup/window to the bootstrap URL.
3. This path does not consult the Web pane's stale `transportAvailable` value.
4. If the server's current runtime transport is actually available, the
   standalone page can succeed even while the embedded pane still shows stale
   offline UI.

Relevant code:

- `web/src/features/threads/use-web-view.ts:302`
- `web/src/features/threads/use-web-view.ts:315`
- `web/src/features/threads/use-web-view.ts:325`
- `web/src/components/workbench/web-view-pane.tsx:280`
- `web/src/components/workbench/web-view-pane.tsx:287`

## Findings

### 1. `useWebView` owns a snapshot of proxy transport state

The hook stores transport status returned by the proxied-site REST endpoints.
That is correct for rendering product-visible proxy readiness, but it means the
hook needs a refresh trigger when runtime connectivity changes.

Today that refresh happens on mount, create/open, site selection, agent
`web_view.*` tool results, and full page refresh. It does not happen on Bud
online/offline transitions.

### 2. Terminal reconnect and Web view transport are independent state machines

Terminal recovery listens to `terminal.bud_online` and can prove that the Bud is
back. The Web view hook has no input from that signal, so it can remain on an
older unavailable transport snapshot while the terminal is already connected.

### 3. Refresh does not refresh the stale thing

The Web view refresh icon refreshes only the viewer grant. In this failure mode,
the viewer grant is not the stale value that blocks rendering; the stale value
is `transport.available`.

That explains the "fakes loading for a few ms" symptom: `status` briefly moves
through `granting` and back to `ready`, but `iframeUrl` is still forced to
`null` because `transportAvailable` is still false.

### 4. Whole-page refresh works because it reloads transport

A browser refresh remounts `useWebView(...)`. The mount effect calls
`refreshWebViews()`, which re-fetches both site list and thread attachment from
the service. If the Bud is connected, the service returns a fresh available
transport snapshot and the iframe is allowed to render.

### 5. Standalone open bypasses the stale embedded transport gate

The standalone path mints a new grant and navigates a separate window. It does
not depend on `WebViewPane`'s `transportAvailable` gate, so it can work even
when the embedded pane's local transport state is stale.

The standalone controls are currently disabled only for `!activeSite` or
`isLoading`, not for `!transportAvailable`.

## Hypotheses

### 1. Primary: stale `transport.available=false` blocks iframe rendering after reconnect

Confidence: high.

Mechanism:

1. Web view stores an offline transport snapshot.
2. Bud reconnects.
3. Terminal state updates via terminal SSE and recovery.
4. Web view state does not refresh.
5. Refresh icon mints a grant but keeps stale transport.
6. `WebViewPane` continues rendering the offline state because
   `transportAvailable` is false.

This matches every reported recovery path.

### 2. Secondary: `activeSite.transport` can also stay stale

Confidence: medium-high.

`transport` takes precedence in `WebViewPane`, but the serialized active site
also carries `transport`. If a future code path removes the top-level transport
or if the thread attachment is refreshed without the site list, stale
`activeSite.transport` can produce the same false offline UI.

### 3. Secondary: refresh should probably use an authoritative site refresh path

Confidence: high.

`reloadWebView()` should either call a "refresh active web view" helper that
updates transport plus active site before minting a grant, or call the existing
`refreshWebViews()` flow. Minting only a grant is insufficient when the failure
state is transport metadata.

### 4. Timing risk: refreshing too early after `terminal.bud_online`

Confidence: medium.

The service emits `terminal.bud_online` after Bud registration and `hello_ack`,
so the data plane should usually be routeable. Still, the safest UI trigger may
be terminal recovery success or `terminalConnection === "connected"` rather
than the raw online event alone.

### 5. The issue is unlikely to be Cloudflare, cookies, or viewer grants

Confidence: high.

Open in new tab and full page refresh both work. The embedded pane is blocked
before iframe navigation because `iframeUrl` becomes `null` locally when
`transportAvailable` is false.

## Proposed Fix Direction

No code changes were made in this pass.

Minimal robust fix:

1. Make the Web view refresh action authoritative.
   - On reload, refresh the active thread Web view and proxy transport snapshot
     from REST before minting or applying a new iframe grant.
   - This should make the refresh icon recover from stale offline transport
     without a full page refresh.

2. Add an automatic reconnect refresh trigger.
   - When terminal recovery reaches `connected`, or when the Bud status
     transitions to `online`, call `refreshWebViews()` if there is an active Web
     view and the current Web view transport is unavailable.
   - Prefer a guard so normal terminal reconnect noise does not reload a healthy
     iframe.

3. Keep tab-switch behavior unchanged.
   - Do not reload or remount the iframe on ordinary Terminal/Web tab switches.
   - This fix should target Bud reconnect/offline recovery only.

4. Follow-up UX:
   - Disable standalone-open controls when the current transport snapshot is
     unavailable, or relabel them as an external recovery attempt.
   - This is separate from the stale embedded recovery bug.

## Validation Plan

1. Start with a working attached Web view.
2. Disconnect the Bud and confirm the Web pane enters the unavailable state.
3. Reconnect the Bud and wait for Terminal to recover.
4. Confirm the Web pane automatically refreshes its transport snapshot and
   shows the iframe, or at minimum that the refresh icon does.
5. Confirm the refresh icon causes a REST refresh of:
   - `/api/buds/:budId/proxied-sites`
   - `/api/threads/:threadId/web-view`
   before or alongside the viewer-grant call.
6. Confirm a healthy iframe is not reloaded by ordinary Terminal/Web tab
   switching.
7. Confirm a healthy iframe is not repeatedly reloaded by terminal heartbeat or
   status events.
8. Confirm Open in new tab behavior remains unchanged for connected Buds.

## Files Likely Affected If Fixed

- `web/src/features/threads/use-web-view.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/web-view-pane.tsx` if standalone/reload disabled
  states are adjusted
- Specs likely needing updates:
  - `web/src/features/threads/threads.spec.md`
  - `web/src/components/workbench/workbench.spec.md`
  - `web/src/routes/$budId/budId.spec.md`
