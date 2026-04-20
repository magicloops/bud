# Debug: web-thread-terminal-multi-tab-regression

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- Backend/service: local Fastify service with local Bud daemon already connected
- Frontend bundle: latest local dev web bundle after the service-refactor closeout work
- DB connection style: local dev database already pushed locally
- LLM mode (real/mocked): not relevant to the reported terminal/thread-view regression

## Repro Steps
1. Start from a clean local dev server and a working Bud connection.
2. Open one browser tab on an existing thread.
3. Confirm that the page works correctly with only that one tab open.
4. Open a second tab on the same local web app and thread/workbench flow.
5. Observe that the second tab fails.
6. Observe that the first tab also starts failing after the second tab opens.

## Observed
- The single-tab case can work correctly.
- A second tab is enough to trigger the regression.
- Once the second tab is opened, the first tab can also start failing.
- The browser still shows terminal SSE connectivity and heartbeats.
- Prior console evidence still applies inside the failing state:
  - terminal SSE connects
  - `terminal.bud_offline` / `terminal.bud_online` can appear
  - `terminal.status` with `state: 'ready'` is received but ignored while local connection state is `reconnecting`

## Expected
- Multiple browser tabs should be able to view the same thread without poisoning each other.
- A fresh viewer attach should reflect the current terminal state, not transient stale lifecycle events.
- One tab opening a thread should not destabilize another tab that is already attached to the same thread.

## Validated Outcome

- This note captured a real secondary risk in the terminal attach/recovery contract, but it was not the primary cause of the broader regression.
- The validated primary root cause was same-browser, same-origin dev transport pressure: each thread tab opens both agent SSE and terminal SSE, and proxying all API/SSE traffic through the Vite origin could stall the short-lived fetches needed for navigation and terminal interaction.
- That is why the problem generalized beyond one shared thread/session and reproduced across different Buds and threads inside the same browser profile.
- Direct local browser traffic via `VITE_API_BASE_URL=http://localhost:3000` resolved the breakage.
- The terminal replay/recovery behavior described below remains worth keeping in mind as follow-up product/runtime debt, especially because stale disconnected UI can still be amplified once a tab gets wedged.

## Why This Changes The Read

The earlier leading hypothesis was a pure route/render-state bug in `ThreadView`.

The new multi-tab fact weakens that substantially:

- two tabs do not share React state
- two tabs do not share in-memory route refs
- the only meaningful shared surfaces are browser storage and the service-side thread/session runtime

There is no relevant cross-tab browser state here beyond `localStorage.threadPanelOpen`, which cannot explain terminal lifecycle poisoning.

That means the new fact points much more strongly at:

- shared service-side thread terminal state
- shared terminal event replay semantics
- or a multi-viewer attach/recovery contract bug between the service and the browser

## Static Review Scope

Reviewed specs:
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/routes/routes.spec.md`

Reviewed implementation files in full:
- `service/src/routes/threads/terminal.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/runtime/event-bus.test.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/terminal/session-store.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal/output-store.ts`
- `web/src/lib/api.ts`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/contexts/bud-status-provider.tsx`
- `web/src/contexts/layout-provider.tsx`

Referenced prior debug note:
- `debug/web-thread-navigation-and-terminal-offline-regression.md`

## Key Findings

### 1. A fresh terminal viewer replays the full buffered terminal event history

In `service/src/runtime/event-bus.ts`:

- `attach(...)` replays the full channel buffer when no `lastEventId` is provided
- `GET /api/threads/:threadId/terminal/stream` in `service/src/routes/threads/terminal.ts` attaches with no cursor for a fresh browser tab

That means a new tab does **not** get only the current terminal state. It gets the recent buffered history of terminal events for that shared session, including transient lifecycle events such as:

- `terminal.bud_offline`
- `terminal.bud_online`
- old `terminal.status`
- old `terminal.ready`

For terminal streams, that is a dangerous contract:

- `terminal.bud_offline` is a transient event, not durable current state
- replaying it to a fresh viewer can push that viewer into a reconnecting/offline UI path even when the Bud is currently healthy

### 2. The browser terminal route is explicitly written to wedge on stale offline replay

In `web/src/routes/$budId/$threadId.tsx`:

- `handleBudOffline(...)` sets:
  - `terminalConnection = 'reconnecting'`
  - `terminalState = 'bud_offline'`
- `handleStatus(...)` then refuses to apply new status updates while local connection is `reconnecting` or `offline`

So if a newly opened tab replays an old `terminal.bud_offline` event:

1. the tab enters `reconnecting`
2. later replayed or live `terminal.status { state: 'ready' }` is ignored
3. the tab is pushed into the recovery path instead of simply reflecting the already-live session

This is a strong code-level explanation for why the **second tab** can fail even when the underlying terminal session is healthy.

### 3. Recovery is shared per thread session, not isolated per viewer

Every tab opening a thread runs the same shared terminal path:

- `POST /api/threads/:threadId/terminal`
- `GET /api/threads/:threadId/terminal/stream`
- `POST /api/threads/:threadId/terminal/ensure`
- then additional `recoverTerminalSession(...)` retries if local UI thinks it is disconnected

On the service side, `TerminalSessionStore.ensureSession(...)` is keyed only by the shared thread/session row. There is no per-viewer attach model and no in-flight ensure dedupe for multiple browser viewers.

That means once one tab is pushed into the recovery loop, it is no longer a harmless local UI problem. It starts sending shared recovery traffic against the same terminal session that the first tab is using.

This is the strongest implementation-level explanation for why the **first tab can start failing after the second tab opens**.

### 4. `ensureSession(...)` is not multi-viewer-safe if recovery churn starts

In `service/src/runtime/terminal/session-store.ts`:

- if the session row is `ready` / `active` / `idle` and the Bud is online, `ensureSession(...)` resumes cleanly
- otherwise it sends `terminal_ensure` again and sets the shared session row to `creating`

There is no guard like:

- "ensure already in flight for this session"
- "viewer attach should not re-ensure an already-healthy shared session"
- "fresh tab attach should bootstrap from canonical state instead of replaying transients"

So once multiple tabs start recovery churn against the same thread session, the backend contract is exposed as session-global, not viewer-local.

### 5. The prior pure-React/context theory is now much weaker

The new fact materially demotes:

- provider-split / Fast Refresh as the primary explanation
- pure `ThreadView` stale-state as the whole root cause
- parent-route `useMatches()` as the main explanation

Those may still contribute to how a tab remains visually stuck once it enters the bad state, but they do not explain why a second tab can poison an already-working first tab.

Cross-tab poisoning strongly implies a shared runtime/contract issue.

### 6. The current tests do not cover the multi-tab attach case

Current gaps from the reviewed tests:

- `service/src/runtime/event-bus.test.ts` covers replay behavior, but not terminal-specific multi-listener semantics or transient-event replay hazards
- there is no direct test that a fresh terminal-stream attach should bootstrap current state rather than replay stale transient lifecycle events
- there is no direct test for two concurrent browser viewers attached to the same thread terminal session

That makes this regression class plausible: the code supports generic replay, but the terminal stream may need stricter semantics than the generic bus currently provides.

## Refined Hypotheses

### 1. Strongest: fresh terminal tabs replay stale transient offline events from the shared terminal buffer

Root mechanism:

- `terminal/stream` attaches with no cursor
- `TerminalEventBus.attach(...)` replays the full buffered event history
- the new tab consumes old `terminal.bud_offline`
- browser code enters `reconnecting`
- browser then ignores later `terminal.status ready`

Why it fits:

- explains why a second/fresh tab fails while the first tab initially works
- directly matches the current browser logic
- directly follows from current service attach semantics

### 2. Strongest: once a tab is wedged, its shared recovery loop perturbs the underlying thread session for every viewer

Root mechanism:

- the wedged tab repeatedly calls `/terminal/ensure`
- `ensureSession(...)` operates on the shared thread session row
- there is no per-viewer isolation or in-flight ensure dedupe
- recovery churn now targets the same shared session the first tab is using

Why it fits:

- explains why opening the second tab can then poison the first tab too
- matches the fact that thread terminals are thread-scoped, not viewer-scoped

### 3. Medium: the browser terminal route is too eager to treat replayed `bud_offline` as authoritative current state

Root mechanism:

- `handleBudOffline(...)` mutates local connection state immediately
- `handleStatus(...)` refuses to recover from that local state
- there is no notion of "this was replayed history, not current transport state"

Why it fits:

- explains the sticky local failure mode once the bad event ordering occurs
- likely contributes even if the service-side replay semantics are the deeper bug

### 4. Lower: pure route/render-state bugs are secondary, not primary

The earlier `ThreadView` stale-state theory still explains some symptoms:

- URL changes without visible thread change
- sticky `Bud offline` overlay

But with the new multi-tab fact, the better read is:

- route/render state is likely part of how the browser stays wedged
- shared terminal attach/recovery semantics are more likely what triggers the wedge in the first place

### 5. Lowest: the provider split / Fast Refresh boundary change is probably not the root issue

After a clean dev-server restart, the multi-tab poisoning still points away from provider-module churn:

- two separate tabs do not share React trees
- one tab breaking another strongly implies shared service/runtime behavior

Fast Refresh could still affect reproducibility during development, but it is no longer a strong root-cause candidate.

## Most Likely Current Read

The current best read is a combined contract bug:

1. a fresh terminal viewer replays stale transient session events from the shared terminal event buffer
2. the browser interprets replayed `terminal.bud_offline` as current truth and wedges itself into `reconnecting`
3. that wedged viewer starts shared recovery traffic against the same thread session
4. because the session is thread-scoped and not viewer-isolated, the recovery churn can destabilize the first tab too

In other words:

- the initial failure likely starts at the **terminal stream attach/replay contract**
- the sticky UI failure is amplified by the **browser reconnect/status suppression logic**
- the cross-tab poisoning happens because the underlying session is **shared per thread**

## Recommended Next Validation

Before structural fixes, the highest-value validation steps are:

1. Use the temporary Phase 9 logs to confirm whether the second tab enters failure immediately after replayed `terminal.bud_offline`, before any true current offline transition.
2. Inspect service logs for `/api/threads/:threadId/terminal/ensure` frequency with one tab vs two tabs.
3. Confirm whether the second tab's attach is receiving a replay buffer containing old `terminal.bud_offline` / `terminal.bud_online` / `terminal.status` events.
4. Confirm whether the first tab starts failing only after the second tab begins recovery polling.

## Proposed Fix Direction

No code changes yet.

The next fix plan should prioritize the shared contract, not the provider split:

1. terminal attach semantics for fresh viewers
2. whether transient events like `terminal.bud_offline` should ever be replayed
3. whether `/terminal/stream` needs a canonical current-state bootstrap similar to `/agent/state`
4. whether `/terminal/ensure` needs per-session in-flight dedupe or viewer-safe attach behavior

Only after that should the browser-side reconnect/status suppression logic be adjusted.
