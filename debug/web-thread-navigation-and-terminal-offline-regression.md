# Debug: web-thread-navigation-and-terminal-offline-regression

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- Service/backend: local backend service already running; an older web tab against the same backend still behaves correctly
- Web bundle under review: latest committed frontend closure slice from `cd267c4` (`tests and linting passes`)
- DB connection style: local dev database already pushed locally
- LLM mode (real/mocked): not relevant to the reported browser regressions

## Repro Steps
1. Open the latest local web app against the local service.
2. Open an existing thread.
3. Observe that the terminal shows `Bud offline`.
4. Click a different thread in the thread panel.
5. Observe that the URL changes to the new thread ID, but the visible UI remains on the first thread.

## Observed
- The newest web bundle shows `Bud offline` for an existing thread even though an older tab pointed at the same backend still works.
- Thread navigation appears partially successful at the URL level, but the rendered UI stays on the originally opened thread.
- The browser console from the failing bundle shows:
  - agent SSE connects
  - terminal SSE connects
  - `terminal.bud_offline` then `terminal.bud_online`
  - repeated `Ignoring status event while disconnected { state: 'ready', connection: 'reconnecting' }`
  - `SSE still connected, polling for terminal recovery`
- The Network tab shows the terminal SSE stream staying connected and sending heartbeats.
- Refreshing the page can leave the tab feeling stuck/unresponsive, which further suggests a client render/lifecycle issue rather than a simple missing request.
- The newest committed `web` changes in `cd267c4` are narrow and lint-driven:
  - provider/context split in `web/src/contexts/*`
  - root provider import rewiring in `web/src/routes/__root.tsx`
  - minor cleanup in `web/src/routes/$budId.tsx`
  - small effect/dependency cleanup in `web/src/routes/$budId/$threadId.tsx`
  - small model-loader cleanup in `web/src/routes/$budId/new.tsx`
- There is no obvious backend-only change in this latest slice that would explain "old tab works, new tab fails" as cleanly as a frontend regression does.

## Expected
- Opening an existing thread should render that thread's transcript and terminal state correctly.
- Navigating to another thread should update the rendered thread view, not just the URL.
- The newest web bundle should match the older tab's behavior against the same local backend.

## Static Review Scope

Reviewed specs:
- `web/src/contexts/contexts.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/components/workbench/workbench.spec.md`

Reviewed current files in full:
- `web/src/routes/__root.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/contexts/auth-session-context.tsx`
- `web/src/contexts/auth-session-provider.tsx`
- `web/src/contexts/bud-status-context.tsx`
- `web/src/contexts/bud-status-provider.tsx`
- `web/src/contexts/layout-context.tsx`
- `web/src/contexts/layout-provider.tsx`
- `web/src/contexts/bud-route-context.tsx`
- `web/src/components/workbench/thread-panel.tsx`
- `web/src/components/workbench/bud-rail.tsx`

Reviewed recent committed delta:
- `git diff ea6de63..cd267c4 -- web/...`
- `git diff fab9e287b01a821fc7fa40ef2f57b52c84391514..HEAD -- web/...`
- `git diff fab9e287b01a821fc7fa40ef2f57b52c84391514..HEAD -- service/...`

Reviewed `origin/main` versions in full:
- `web/src/routes/__root.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/contexts/auth-session-context.tsx`
- `web/src/contexts/bud-status-context.tsx`
- `web/src/contexts/layout-context.tsx`

## Findings
- The provider split itself is structurally simple. By itself it does not present an obvious direct cause for stale thread rendering.
- The strongest suspects remain in `web/src/routes/$budId/$threadId.tsx`, because both reported symptoms center on that route and that file still owns a large amount of long-lived state and refs.
- The two symptoms may share a single stale-route/stale-state root cause.
- The latest lint-driven route changes did not change the terminal protocol, but they did touch long-lived effect closures in the thread route, which makes them worth treating as plausible regression triggers.
- The latest console evidence makes the failure mode more specific: the frontend is still receiving online/status traffic, but local route state is staying in `reconnecting` and suppressing those updates.

## origin/main Comparison

`origin/main` is currently at `a5d966a6cfa9bb4ab54105f115795651a7b3bcfa`.

### 1. The provider/context split is new, but behavior is effectively unchanged

Compared against `origin/main`:

- `web/src/routes/__root.tsx` changed only in import paths
- `web/src/contexts/auth-session-context.tsx` / `auth-session-provider.tsx`
- `web/src/contexts/bud-status-context.tsx` / `bud-status-provider.tsx`
- `web/src/contexts/layout-context.tsx` / `layout-provider.tsx`

The provider logic was not meaningfully rewritten. It was moved out of the original context files into dedicated provider files, but:
- state initialization is the same
- `useEffect(...)` synchronization is the same
- provider values are the same
- consumers still read from the same context objects

This materially weakens the hypothesis that "we changed/added a bunch of context" is the direct code-level cause of the regression.

### 2. The parent Bud route is effectively unchanged

Compared against `origin/main`, `web/src/routes/$budId.tsx` only changed by removing the unused `bud: _bud` loader binding.

The following suspect logic is unchanged from `origin/main`:
- `useMatches()`-based active thread lookup
- the hard-coded `'/\$budId/\$threadId'` route ID string
- the `useEffect(() => setThreads(initialThreads.map(...)), [initialThreads])` thread-summary resync

That means the parent-route stale-selection hypothesis is still plausible in absolute terms, but it was **not introduced by the latest closure slice**.

### 3. Nearly all of the thread-route state logic is unchanged from origin/main

Compared against `origin/main`, the core `ThreadView` architecture in `web/src/routes/$budId/$threadId.tsx` is the same:

- the large retained state/ref surface is unchanged
- the loader-driven message/status resync is unchanged
- the terminal-stream effect is unchanged
- the missing explicit `terminalState` reset on thread change is unchanged
- the `recoverTerminalSession(...)` logic that stamps `bud_offline` is unchanged

This is important because the highest-confidence stale-route/stale-state hypotheses from the first pass are describing code that already existed on `origin/main`.

### 4. The only meaningful thread-route deltas vs origin/main are small

The actual `ThreadView` deltas vs `origin/main` are:

- rename `_terminalDisconnectTime` to an unused tuple slot
- change model-loader effects to use functional `setSelectedModel(...)`
- extract `handleThreadTitleUpdate(...)`
- make `connectAgentStream(...)` depend on that extracted callback

Of those, the only delta with any realistic chance of changing route lifecycle behavior is:
- the new `handleThreadTitleUpdate(...)` / `connectAgentStream(...)` dependency chain

That still looks like a secondary or lower-confidence culprit, but it is the only substantive new behavior inside the compared thread route.

### 5. `bud-rail.tsx` did not gain any new live status behavior

Compared against `origin/main`, `web/src/components/workbench/bud-rail.tsx` only dropped the dead `lastRun` type shape.

The live status resolution:

```ts
const liveStatus = budStatuses[bud.id] ?? bud.status
```

is unchanged in behavior.

## Refined Interpretation

The `origin/main` comparison changes the read of the first-pass hypotheses:

- The provider/context split is now a **low-confidence code-level cause**. It is new, but it is semantically equivalent to the old provider code.
- The strongest stale-route/stale-state hypotheses still describe real risks, but those risks largely predate the latest closure commit.
- If the regression is truly new to the latest bundle, the most plausible explanations are now:
  1. a non-semantic dev-bundle/HMR/module-graph issue triggered by the provider split
  2. the small new `connectAgentStream(...)` dependency churn in `ThreadView`
  3. a regression outside the compared files
  4. a pre-existing thread-route bug that became easier to trigger, but was not introduced by the latest diff

## fab9e287..HEAD Comparison

`fab9e287b01a821fc7fa40ef2f57b52c84391514` is the immediately previous commit in this branch. The entire regression window is therefore a single commit:

- `cd267c4 tests and linting passes`

That matters because it sharply limits the plausible code surface.

### 1. The browser-facing diff in this window is very small

The complete `web` delta in `cd267c4` is:

- provider/context file split:
  - `auth-session-context.tsx` + new `auth-session-provider.tsx`
  - `bud-status-context.tsx` + new `bud-status-provider.tsx`
  - `layout-context.tsx` + new `layout-provider.tsx`
- root import rewiring in `web/src/routes/__root.tsx`
- unused loader binding removal in `web/src/routes/$budId.tsx`
- in `web/src/routes/$budId/$threadId.tsx`:
  - rename `_terminalDisconnectTime` to an ignored tuple slot
  - convert the model defaulting branch to functional `setSelectedModel(...)`
  - add `handleThreadTitleUpdate(...)`
  - make `connectAgentStream(...)` depend on that callback
- the same functional `setSelectedModel(...)` rewrite in `web/src/routes/$budId/new.tsx`

Crucially, this commit does **not** change:

- the terminal SSE effect's thread-change reset logic
- the `handleStatus(...)` branch that ignores `terminal.status` while reconnecting/offline
- the `handleBudOffline(...)` / `handleBudOnline(...)` handlers
- the `recoverTerminalSession(...)` state machine
- the parent route's `useMatches()`-based active-thread lookup

So the code paths directly producing the current console messages were already present before `cd267c4`.

### 2. The service diff in this same window does not match the observed symptom pattern

The `service` side of `cd267c4` is mostly closeout work:

- lint config cleanup
- dead legacy run-schema removal
- typing/normalization cleanup
- readiness payload normalization in `service/src/ws/bud-connection.ts`

The only behavior-adjacent backend change in the terminal path is the new readiness normalization in `bud-connection.ts`, but the new browser console evidence does not point there as the primary failure:

- the browser is already receiving SSE heartbeats
- the browser receives `terminal.bud_offline`
- the browser receives `terminal.bud_online`
- the browser then receives `terminal.status` with `state: 'ready'`

That means the backend/service path is still emitting the events the browser needs. The failing bundle is choosing not to apply them because local state still says `reconnecting`.

### 3. The console trace now points at a frontend state-machine stall, not a transport break

The highest-signal part of the console is:

- `[terminal] Bud went offline`
- `[terminal] Bud came online`
- repeated `[terminal] Ignoring status event while disconnected { state: 'ready', connection: 'reconnecting' }`
- `[terminal] SSE still connected, polling for terminal recovery`

That combination means:

1. the SSE stream is alive
2. the route is receiving terminal lifecycle events
3. the local route state never gets back to the branch that accepts `terminal.status`

So the current failure is not "the terminal stream never reconnects." It is "the thread route remains locally stuck in the disconnected/reconnecting state machine even while fresh events arrive."

### 4. The latest commit still leaves only a few realistic new regression candidates

Given the single-commit window, the only latest-change-specific candidates still worth serious attention are:

1. provider/module-boundary churn from the context split, especially in dev/Fast Refresh conditions
2. the new `handleThreadTitleUpdate(...)` callback and its effect on `connectAgentStream(...)` identity/lifecycle
3. a pre-existing `ThreadView` stale-state bug that `cd267c4` makes easier to surface, without directly changing the broken terminal handler itself

The provider-split hypothesis is still mechanically weak at the code level, but after narrowing the diff to one commit it remains one of the only new browser-meaningful changes left.

## Updated Read After Console Evidence

The earlier "backend vs frontend" split is now much clearer:

- This does **not** look like a dead terminal stream.
- This does **not** look like a missing Bud connection.
- This **does** look like the browser route getting stuck in a stale local state machine and refusing to transition back to the live thread/session state.

That also explains why the two reported symptoms cluster together:

- thread switch updates the URL but not the rendered thread
- terminal SSE is connected but the overlay stays on `Bud offline`

Both are consistent with the same route instance holding onto stale state/ref values longer than it should.

## Hypotheses: Terminal Always Shows `Bud offline`

### 1. Shared stale-thread state is persisting inside `ThreadView`

`ThreadView` keeps substantial loader-derived and connection-derived state in long-lived React state and refs (`messages`, `messagePage`, `terminalState`, `terminalConnection`, `agentCursorRef`, `lastConnectedThreadIdRef`, `currentSessionIdRef`, etc.) around `web/src/routes/$budId/$threadId.tsx:323-393`.

If the route instance is being reused unexpectedly across param changes, the component can keep the first thread's terminal state alive. That would explain both:
- why the terminal overlay can stay on an old `bud_offline` state
- why clicking another thread updates the URL but not the visible thread view

### 2. `terminalState` is not explicitly reset when `threadId` changes

In the terminal-stream effect (`web/src/routes/$budId/$threadId.tsx:1382-1415`), thread changes reset:
- terminal output
- terminal readiness
- current session ID
- connection state

But they do **not** explicitly reset `terminalState` itself when moving between two valid thread IDs. `terminalState` is only forced back to `'idle'` when `threadId` is missing. That means a previous `bud_offline` state can survive a thread switch until a new status or recovery path overwrites it.

If the new thread's reconnect/recovery path does not win quickly, the UI can remain stuck on `Bud offline`.

### 3. `recoverTerminalSession(...)` may be surfacing an offline state earlier or more aggressively than the previous web bundle

`recoverTerminalSession(...)` in `web/src/routes/$budId/$threadId.tsx:915-989` stamps:
- `terminalConnection = 'reconnecting'`
- `terminalState = 'bud_offline'`
- `updateBudStatus(budId, 'offline')`

as soon as `/api/threads/:threadId/terminal/ensure` returns `{ error: 'bud_offline' }`.

If the latest bundle is reaching `ensure` on the wrong stale thread, or if it now shows this result before a later history/status replay corrects it, the UI would present `Bud offline` even though an already-established older tab continues to work.

### 4. Less likely: the provider split introduced a dev-bundle/module-boundary issue

The latest commit split the providers into new modules and rewired the root route to import:
- `AuthSessionProvider` from `auth-session-provider.tsx`
- `LayoutProvider` from `layout-provider.tsx`
- `BudStatusProvider` from `bud-status-provider.tsx`

via `web/src/routes/__root.tsx:23-32`.

In principle, a module-graph or HMR inconsistency could explain "old tab works, new tab fails." But this is lower confidence because:
- the provider split is mechanically small
- the terminal overlay state comes from `ThreadView`, not directly from provider logic
- it does not independently explain why the thread view itself appears stuck
- compared against `origin/main`, the provider behavior is effectively unchanged at the code level

## Hypotheses: URL Changes But UI Stays On The First Thread

### 1. `ThreadView` is not fully resetting when the route param changes

The route stores thread-specific UI state in both React state and refs, then only partially re-syncs from loader data:
- initial state/ref seeding at `web/src/routes/$budId/$threadId.tsx:323-393`
- loader-driven sync at `web/src/routes/$budId/$threadId.tsx:435-447`

If the component is reused across thread param changes, one incomplete reset is enough to keep the first thread's visible state alive even after navigation.

This is the highest-confidence shared explanation for both reported symptoms.

### 2. `activeThreadId` depends on a hard-coded route ID lookup

In `web/src/routes/$budId.tsx:105-110`, the active thread is derived with:

```ts
const threadMatch = matches.find(m => m.routeId === '/$budId/$threadId')
```

If the generated route ID differs from this string, or if the match resolution is stale in the current bundle, the parent may keep treating the original thread as active.

This more directly explains stale thread selection/highlighting than stale transcript content, so it is a medium-confidence hypothesis unless the observed "UI stays on the first thread" is specifically referring to thread-panel state.

Compared against `origin/main`, this logic is unchanged, so it is not a latest-commit-specific regression candidate.

### 3. The route sync path keys visible content to loader objects, not directly to `threadId`

The thread route resets messages/status from:
- `initialMessagePage`
- `initialAgentState`

in `web/src/routes/$budId/$threadId.tsx:435-443`, and computes the visible thread fallback from `initialThread` in `:453-467`.

If the router reuses cached data temporarily, or if loader completion lags while the component remains mounted, the UI can keep showing the first thread until those loader objects change.

That would produce exactly the reported symptom: URL changes immediately, but the visible content does not.

### 4. The lint-driven `handleThreadTitleUpdate` / `connectAgentStream` dependency change may have introduced extra effect churn

The latest commit added:
- `handleThreadTitleUpdate(...)` at `web/src/routes/$budId/$threadId.tsx:1039-1041`
- `connectAgentStream` now depends on it at `:1354-1355`
- the auto-connect effect depends on `connectAgentStream` at `:1357-1380`

This is not an obvious primary cause, but it is one of the only recent changes inside the thread route itself. If the new dependency chain changes cleanup/reconnect ordering, it could leave first-thread stream state alive longer than intended during navigation.

Compared against `origin/main`, this is the only meaningful new route-lifecycle delta in the compared thread file. It remains a plausible secondary regression path and is now one of the few latest-change-specific candidates worth validating early.

## Most Likely Shared Root Cause

The strongest current read is:

1. the `/$budId/$threadId` route is not fully transitioning its internal state when the selected `threadId` changes or when a disconnected thread recovers, and
2. the stale first-thread/disconnected state then leaks into both visible symptoms:
   - stale terminal `bud_offline` overlay
   - stale rendered thread UI despite URL updates

In other words, the two user-visible failures are likely not independent.

## Proposed Validation Before Any Fix

1. Confirm whether `ThreadView` sees the new param on navigation:
   - log `threadId`
   - log `initialThread.thread_id`
   - log `currentThread.thread_id`

2. Confirm whether terminal state is stale rather than freshly computed:
   - log `terminalState` immediately before and after the thread-change branch at `web/src/routes/$budId/$threadId.tsx:1397-1415`
   - log whether `recoverTerminalSession(...)` is being called with the newly selected `threadId`

3. Confirm whether the parent route match is reporting the right active thread:
   - log the `matches` array and resolved `activeThreadId` in `web/src/routes/$budId.tsx:105-110`

4. Check whether the new bundle reproduces after a full hard refresh / dev-server restart:
   - if yes, this is likely a real route-state bug
   - if no, the provider split/HMR hypothesis rises in confidence

## Proposed Fix
- No code changes yet.
- First validate whether the problem is a stale `threadId` / stale route-state issue in `ThreadView`, or only a stale `activeThreadId`/selection issue in `BudLayout`.
- If the params are changing but the route state is not, the first code pass should focus on explicit thread-change resets inside `web/src/routes/$budId/$threadId.tsx`, not on the provider split.
