# Debug: web-same-browser-multi-tab-thread-regression

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- Frontend runtime: Vite dev server
- Backend/service: local Fastify service proxied through the Vite dev server
- DB connection style: local dev database already pushed locally
- Browser behavior under comparison:
  - same browser, multiple tabs: broken
  - different browser, same account: works

## Repro Steps
1. Start the local web dev server and local backend service.
2. Open one browser tab on the workbench.
3. Confirm that thread switching and terminal input work when only one tab is open.
4. Open a second tab in the same browser.
5. Observe that both tabs break, even when they point at:
   - different thread IDs
   - or different Bud IDs
6. Observe that a different browser logged into the same account still works correctly.

## Observed
- With only one tab open, thread switching works.
- With two tabs open in the same browser, both tabs break.
- The first tab can still show terminal connected, but terminal input stops working.
- The second tab can show `Bud offline`.
- Clicking a different thread changes the URL, but the rendered view stays static.
- The console shows only the parent-route selection logs:
  - `select thread { budId, targetThreadId, activeThreadId }`
- A different browser can still:
  - view threads correctly
  - switch threads correctly
  - type in the terminal and see output reflected in the other browser

## Expected
- Multiple tabs in the same browser should not poison each other.
- Changing the URL to a new thread should also update the rendered thread view.
- Terminal input in one tab should continue to work even if another tab is open.

## Static Review Scope

Reviewed specs:
- `web/src/lib/lib.spec.md`
- `web/src/contexts/contexts.spec.md`
- `web/src/routes/routes.spec.md`

Reviewed current frontend files in full:
- `web/src/lib/api.ts`
- `web/vite.config.ts`
- `web/src/routes/__root.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/contexts/auth-session-provider.tsx`
- `web/src/contexts/bud-status-provider.tsx`
- `web/src/contexts/layout-provider.tsx`
- `web/src/components/theme-provider.tsx`

Referenced earlier debug notes:
- `debug/web-thread-navigation-and-terminal-offline-regression.md`
- `debug/web-thread-terminal-multi-tab-regression.md`

## Findings

### 1. The context refactor did not add any new cross-tab storage mechanism

From the current frontend implementation:

- `auth-session-provider.tsx` has no storage
- `bud-status-provider.tsx` has no storage
- `layout-provider.tsx` still only reads/writes `localStorage.threadPanelOpen`

Compared against the pre-refactor version of `layout-context.tsx`, the `threadPanelOpen` localStorage behavior is unchanged. It was moved into `layout-provider.tsx`, but the logic is the same.

Other app-shell persistence found in the frontend:

- `theme-provider.tsx` uses `localStorage.bud-ui-theme`
- `devices.claim.$flowId.tsx` uses `sessionStorage` for claim-route redirect guards

None of that is new to the context refactor, and none of it plausibly explains:

- thread switching freezing across tabs
- terminal input stopping in one tab when another opens
- failures across different Buds and different threads

So the answer to "did the context refactor change anything related to localStorage?" is effectively:

- no meaningful new cross-tab behavior was introduced there
- the one relevant context localStorage key (`threadPanelOpen`) is unchanged in behavior

### 2. By default, the frontend sends both fetch and SSE traffic through the Vite dev origin

In `web/src/lib/api.ts`:

- `buildApiUrl(path)` returns a relative path when `VITE_API_BASE_URL` is not set
- `createAuthEventSource(path)` also uses `buildApiUrl(path)`

In `web/vite.config.ts`:

- the dev server proxies `/api` to `http://localhost:3000` by default

That means in normal local dev, the browser is not connecting directly to the service origin. It is connecting to the **web dev origin** first, for both:

- regular `fetch(...)`
- long-lived `EventSource(...)`

So from the browser's point of view, all of these requests share the same origin and the same per-browser connection budget.

### 3. Each thread tab opens two long-lived SSE streams

In `web/src/routes/$budId/$threadId.tsx`, every active thread tab opens:

- one agent stream: `/api/threads/:threadId/agent/stream`
- one terminal stream: `/api/threads/:threadId/terminal/stream`

Those are both long-lived `EventSource` connections.

So with two open workbench tabs in the same browser, the app already holds at least:

- 4 long-lived SSE connections

before counting any normal loader or mutation traffic.

### 4. Thread switching and terminal interaction both depend on additional fetches completing

The thread route loader does three parallel requests on navigation:

- `/api/threads/:threadId/messages`
- `/api/threads/:threadId/agent/state`
- `/api/threads/:threadId`

The terminal path also issues additional requests:

- `POST /api/threads/:threadId/terminal`
- `POST /api/threads/:threadId/terminal/ensure`
- `GET /api/threads/:threadId/terminal`
- `GET /api/threads/:threadId/terminal/history`
- `POST /api/threads/:threadId/terminal/input`
- `POST /api/threads/:threadId/terminal/resize`

So the UI depends on short-lived fetch requests being able to complete promptly even while the long-lived SSE streams stay open.

### 5. The new same-browser fact fits per-origin connection starvation better than any context/localStorage theory

The strongest new facts are:

- same browser, two tabs: broken
- different browser, same account: works
- tabs can break even when they are on different Buds and different threads

That weakens the earlier shared-thread-session theory as the primary explanation, because different Buds and different threads do not share:

- a thread route instance
- a terminal session row
- a terminal event buffer

What they **do** share, in the same browser profile, is:

- the same cookie jar
- the same localStorage/sessionStorage
- the same per-origin browser connection behavior

Given the implementation above, the per-origin transport explanation is much stronger than a storage/context explanation.

### 6. The frozen-thread symptom matches “URL changed, but loader fetches never completed”

The console log you captured shows:

- the parent route click handler runs
- the URL changes
- but nothing else changes visually

That is consistent with:

- TanStack Router accepting the navigation
- the location changing immediately
- the child route remaining visually stuck because its loader-backed data never resolves

This is a better fit for network starvation than for localStorage corruption.

### 7. The broken terminal input symptom also matches queued/blocked fetches

The first tab still showing terminal connected but refusing input is also consistent with the same mechanism:

- the terminal UI remains mounted
- the tab still has an existing SSE stream
- but `POST /api/threads/:threadId/terminal/input` cannot complete promptly

That makes “transport starvation for normal fetches” a cleaner explanation than “terminal UI state alone is corrupted.”

### 8. The previous terminal replay/recovery theory may still be real, but it is no longer the primary root cause

The earlier multi-tab debug note identified a real risk in terminal replay semantics:

- fresh terminal viewers replay buffered lifecycle events
- replayed `terminal.bud_offline` can wedge the browser into `reconnecting`

That could still amplify failure, especially when two tabs view the same thread.

But the newest fact pattern is broader:

- different tabs on different Buds also break
- a different browser works fine

That makes same-browser origin-level transport pressure the stronger root cause candidate.

## Most Likely Current Read

The strongest current read is:

1. In local dev, the web app sends both fetch and SSE traffic through the Vite origin.
2. Each thread tab consumes two long-lived SSE connections.
3. With multiple tabs open in the same browser, the origin-level connection budget is exhausted or starved.
4. Navigation URLs still update locally, but the loader fetches needed to render the new thread do not complete promptly.
5. Terminal input requests can also stall, so the first tab looks connected but becomes effectively non-interactive.
6. The second tab is more likely to fall into terminal recovery/offline UI because its bootstrap requests are the ones that lose the race.

This is a frontend/dev-topology issue first, not a context/localStorage issue.

## Refined Hypotheses

### 1. Strongest: same-origin connection starvation in dev due to two SSE streams per tab

Root mechanism:

- relative API URLs + Vite proxy keep fetch and SSE on the same browser origin
- each thread tab opens 2 persistent EventSource connections
- multi-tab usage starves the origin's short-lived fetch traffic

Why it fits:

- explains why one tab works and two tabs break
- explains why different Buds/threads still break
- explains why a different browser works
- explains why URL changes can happen without rendered data changing
- explains why terminal input can stop while the tab still looks connected

### 2. Strong: thread switching is failing because loader requests stall, not because the route tree cannot navigate

Root mechanism:

- parent click handler runs and updates the URL
- child-route loader requests do not complete promptly
- old loader data remains on screen

Why it fits:

- matches the captured console output
- matches the “URL changes but nothing else changes” symptom directly

### 3. Medium: terminal recovery/offline logic is amplifying the failure once transport is already stressed

Root mechanism:

- terminal bootstrap/recovery requests get delayed or fail under connection pressure
- browser enters reconnecting/offline UI paths
- later terminal status updates are suppressed or delayed

Why it fits:

- explains why the second tab tends to present as `Bud offline`
- likely stacks on top of the transport issue rather than replacing it

### 4. Low: the context refactor’s localStorage behavior is the root cause

This is now weak because:

- the context refactor did not add new storage listeners or cross-tab coordination
- `threadPanelOpen` behavior is unchanged
- the symptom pattern is much better explained by shared browser transport behavior

## Recommended Next Validation

Before changing structure again, the highest-value validation steps are:

1. Inspect the Network tab with two tabs open and confirm whether loader/input requests sit pending while the two SSE streams per tab remain open.
2. Check whether setting `VITE_API_BASE_URL` to the backend origin directly changes the behavior by moving API/SSE traffic off the Vite same-origin proxy path.
3. Compare the failure rate with:
   - one tab on `/new` vs one tab on an existing thread
   - one tab with only agent SSE active vs both agent + terminal SSE active
4. Use the temporary Phase 9 logs to confirm whether the child thread route stops progressing because its loader data never updates, rather than because params fail to change.

## Proposed Fix Direction

No code changes yet.

The next fix plan should start with the dev/browser transport model:

1. validate same-origin SSE/fetch starvation as the primary mechanism
2. decide whether local dev should use a direct backend origin for API/SSE instead of proxying through the Vite origin
3. only after that, revisit terminal replay/recovery semantics and any browser-side stale-state cleanup
