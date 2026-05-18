# Debug: web-proxy-web-view-request-loop

## Environment
- Date: 2026-05-13
- Workspace: `/Users/adam/bud`
- Frontend runtime under review: Vite dev server with React 19 development mode
- Backend runtime under review: local Fastify service
- Browser scenario: existing thread page opened while the Bud daemon may be disconnected
- Investigation method: static code review plus user-provided browser console/network observations; no code changes made in this pass

## Repro Steps
1. Start the local service and web dev servers.
2. Open an existing thread in the web UI.
3. Watch browser DevTools network traffic and console logs.
4. Observe repeated requests for:
   - `GET /api/buds/:budId/proxied-sites`
   - `GET /api/threads/:threadId/web-view`
   - `GET /api/threads/:threadId/agent/stream?after=...`

## Observed
- The three request families repeat every roughly `5-40 ms`.
- The problem happens even when the Bud daemon is disconnected, so the loop is on the browser/service side rather than daemon transport.
- Console logs repeatedly print `[agent-sse] connected { threadId, after }`.
- The browser also reports invalid nested interactive markup:
  - file-link renderer produces an outer `<button>`
  - inline-code path renderer inside that link can produce an inner `<button>`
  - React reports `<button> cannot contain a nested <button>`
- Terminal recovery logs show expected offline `503 bud_offline` responses, but those are not the same request family as the reported `proxied-sites` / `web-view` / `agent/stream` loop.

## Expected
- `proxied-sites` and `web-view` should load once on thread mount and again only for explicit refreshes, local mutations, or relevant tool results.
- `agent/stream?after=...` should stay open as one EventSource connection and should not reconnect on every render.
- React should not render nested interactive controls inside markdown file links.

## Reviewed Files
- `web/src/features/threads/threads.spec.md`
- `web/src/features/threads/use-web-view.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/message-renderers/roles/roles.spec.md`
- `web/src/components/message-renderers/roles/markdown-content.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- Related prior notes:
  - `debug/agent-and-terminal-sse-request-storm.md`
  - `debug/agent-sse-stale-tab-reconnect-loop.md`

## Findings

### 1. `useWebView(...)` automatically refetches whenever `refreshWebViews` identity changes

`web/src/features/threads/use-web-view.ts:107-169` defines `refreshWebViews` and then runs it from an effect:

- `refreshWebViews` depends on `applyError`, `budId`, `requestViewerGrant`, and `threadId`
- the effect depends on `refreshWebViews`
- each run sets hook state (`status`, `iframeSrc`, `sites`, `transport`, etc.)

If `refreshWebViews` is recreated on each render, the effect refires on each render and issues the two observed requests:

- `/api/buds/:budId/proxied-sites`
- `/api/threads/:threadId/web-view`

### 2. The thread route passes a fresh inline `onError` function into `useWebView(...)` every render

`web/src/routes/$budId/$threadId.tsx:137-142` calls:

```tsx
useWebView({
  budId,
  threadId,
  onError: (message) => setError(message),
  shouldAbortForUnauthorized,
})
```

That inline function has a new identity on every render. Inside `useWebView(...)`, `applyError` depends on `onError` at `web/src/features/threads/use-web-view.ts:68-76`, so `applyError` changes every render. That recreates `refreshWebViews`, which retriggers the effect at `web/src/features/threads/use-web-view.ts:167-169`.

This is the strongest explanation for the `proxied-sites` and `web-view` request loop.

### 3. The web-view loop can propagate into the agent stream hook

The thread route extracts `refreshThreadWebView = webView.refreshWebViews` at `web/src/routes/$budId/$threadId.tsx:143`.

`handleToolResultMessage` closes over that function at `web/src/routes/$budId/$threadId.tsx:303-310`, and that handler is passed to `useAgentStream(...)` at `web/src/routes/$budId/$threadId.tsx:315-329`.

`useAgentStream(...)` defines `connectAgentStream` with `onToolResultMessage` in its dependency list at `web/src/features/threads/use-agent-stream.ts:388-400`. Its stream-opening effect depends on `connectAgentStream` at `web/src/features/threads/use-agent-stream.ts:402-431`.

So when `useWebView` recreates `refreshWebViews`, the route recreates `handleToolResultMessage`, `useAgentStream` recreates `connectAgentStream`, and the stream effect tears down and opens a new `EventSource`. That matches repeated `agent/stream?after=...` and repeated `[agent-sse] connected` logs.

### 4. This differs from the older stale-tab reconnect loop

The older `debug/agent-sse-stale-tab-reconnect-loop.md` was a bounded reconnect loop driven by missed heartbeats and normal reconnect delays.

This report is much faster: `5-40 ms`. That speed fits React render/effect churn, not the heartbeat reconnect policy in `thread-stream-timing.ts`.

### 5. Other inline error callbacks may be latent churn risks

The same route also passes inline `onError` functions to:

- `useThreadMessages(...)` at `web/src/routes/$budId/$threadId.tsx:119-125`
- `useFileViewer(...)` at `web/src/routes/$budId/$threadId.tsx:132-136`
- `useTerminalSession(...)` at `web/src/routes/$budId/$threadId.tsx:343-350`

`useThreadMessages(...)` only uses `onError` in the older-message callback dependency path, so it does not appear to auto-fetch from this alone. `useFileViewer(...)` and `useTerminalSession(...)` were not the reported request family in this issue, but they should be checked before any fix is considered complete.

### 6. The nested markdown buttons are a separate bug, not the main request-loop cause

`web/src/components/message-renderers/roles/markdown-content.tsx:71-89` renders local markdown file links as a `<button>`.

The markdown link text can contain inline code. The inline code renderer can also add an open-file `<button>` at `web/src/components/message-renderers/roles/markdown-content.tsx:39-67`.

When both happen, React reports nested `<button>` markup. This can add development-mode warning noise and extra render pressure, but it does not directly explain the three repeating network requests.

## Hypotheses

### 1. Primary cause: unstable `onError` passed into `useWebView(...)`

Confidence: high.

Mechanism:
1. Thread route renders.
2. Inline `onError` function is newly allocated.
3. `useWebView.applyError` changes.
4. `useWebView.refreshWebViews` changes.
5. `useWebView` effect reruns and fetches `proxied-sites` plus `web-view`.
6. State updates from those fetches trigger another render.
7. The loop repeats.

### 2. Agent stream reconnects are secondary fallout from the unstable web-view refresh callback

Confidence: high.

Mechanism:
1. `webView.refreshWebViews` changes identity.
2. `handleToolResultMessage` changes identity.
3. `useAgentStream.connectAgentStream` changes identity.
4. The stream effect cleans up the current EventSource and opens a new one.
5. The console prints `[agent-sse] connected` repeatedly.

### 3. React StrictMode makes the problem easier to see but is not the root cause

Confidence: medium.

Development StrictMode can double-invoke effects during mount, but a persistent every-render loop after mount requires unstable dependencies plus state updates. StrictMode likely amplifies the symptom; it does not explain indefinite requests by itself.

### 4. Offline Bud terminal `503` logs are collateral

Confidence: medium.

The console shows terminal recovery attempts returning `503 bud_offline`. Those are expected when a thread has a terminal session but the daemon is disconnected. They should be monitored, but they are not the same endpoints as the reported request storm.

### 5. Nested markdown button warning is an independent rendering bug

Confidence: high.

The console stack maps directly to `markdown-content.tsx`: outer file-link button plus inner inline-code file-open button. Fixing it should reduce React warnings but probably will not stop the `proxied-sites` / `web-view` / `agent/stream` loop.

## Proposed Fix Direction
- First, stabilize callback identities in `web/src/routes/$budId/$threadId.tsx`:
  - create one `handleFeatureError = useCallback((message: string) => setError(message), [])`
  - pass it to `useThreadMessages`, `useFileViewer`, `useWebView`, and `useTerminalSession`
- Preferably harden `useWebView(...)` so its mount-time fetch effect depends only on actual resource identity (`budId`, `threadId`) and stable internal helpers:
  - store `onError` in a ref, or
  - move parent callback invocation out of dependencies that drive auto-fetch
- Consider hardening `useAgentStream(...)` similarly:
  - keep latest callbacks in refs
  - make the EventSource lifecycle depend primarily on `threadId`
  - avoid reconnecting solely because handler props changed
- Fix markdown rendering separately:
  - avoid rendering an interactive `<button>` inside another interactive markdown file-link control
  - likely options are disabling inline-code file controls when inside file-link children, or rendering file links with a non-button wrapper plus keyboard handling after an accessibility review

## Resolution
- Stabilized the thread route's feature error callback and passed the stable callback into thread feature hooks.
- Hardened `useWebView(...)` by storing `onError` in a ref so auto-fetching remains keyed to resource identity rather than parent callback identity.
- Hardened `useAgentStream(...)` by storing latest event handlers in a ref so the EventSource lifecycle no longer depends on handler prop identity.
- Fixed the markdown nested-button warning by rendering local file-link button labels as plain text instead of reusing already-rendered children that may contain inline-code open buttons.

## Current Validation
- `pnpm --dir /Users/adam/bud/web exec tsc -b`
- `pnpm --dir /Users/adam/bud/web test`

## Validation Plan
- Start service and web locally.
- Open an existing thread with the Bud disconnected.
- Confirm `proxied-sites` and `web-view` fire once on mount, not continuously.
- Confirm there is only one active `agent/stream?after=...` connection after mount.
- Leave the page idle for at least one minute and confirm no tight request loop.
- Trigger an agent `web_view.*` tool result or manual Web view refresh and confirm the web-view state refreshes once.
- Revisit the markdown transcript that produced the console warning and confirm no nested-button warning remains after the separate renderer fix.

## Files Likely Affected If Fixed
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/features/threads/use-web-view.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/components/message-renderers/roles/markdown-content.tsx`
- Specs likely needing updates:
  - `web/src/routes/$budId/budId.spec.md`
  - `web/src/features/threads/threads.spec.md`
  - `web/src/components/message-renderers/roles/roles.spec.md`
