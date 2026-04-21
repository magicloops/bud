# Web Architecture Review

Date: 2026-04-20

## Scope

Static architectural review of `web/` based on the checked-in specs, route/components/lib source, and package/config files.

- Reviewed the `web/` specs first, then the implementation files under `web/src/`.
- Did not run `pnpm build` or `pnpm lint`; this is a code-and-architecture review, not a runtime verification pass.
- No automated frontend tests were found in `web/`.

## Executive Summary

The web app is functional and the current product concepts are visible, but the architecture is heavily concentrated in route/controller files rather than split into feature modules. The main risk is not one isolated “god file”; it is a pattern:

- routes own transport wiring, optimistic state, reconnection logic, and rendering
- shared transport/types/auth helpers are concentrated in `web/src/lib/api.ts`
- the new-thread and existing-thread workspaces intentionally duplicate behavior
- performance-sensitive UI paths are still fully manual and unvirtualized
- the package currently has no frontend test harness

The biggest hotspot is `web/src/routes/$budId/$threadId.tsx` at 2,071 lines. That file currently acts as page component, transcript store, agent-stream client, terminal-session client, xterm lifecycle manager, reconnect coordinator, and terminal UI.

## Largest Hotspots

Based on current line counts:

| File | LOC | Notes |
|------|-----|-------|
| `web/src/routes/$budId/$threadId.tsx` | 2071 | Primary god file; owns most runtime behavior |
| `web/src/routes/devices.claim.$flowId.tsx` | 439 | Polling, approval, redirect, mobile handoff all mixed |
| `web/src/routes/settings.tsx` | 355 | Route + form controller + auth linking flow |
| `web/src/components/workbench/chat-timeline.tsx` | 347 | Render, measurement, copy, payload viewer |
| `web/src/lib/api.ts` | 333 | Transport, auth redirects, EventSource, API types, terminal decode |
| `web/src/components/bud-sessions-modal.tsx` | 328 | Fetch, mutation, modal UI, session formatting |
| `web/src/components/workbench/thread-panel.tsx` | 283 | Sorting, destructive mutation, confirmation UI |
| `web/src/routes/$budId.tsx` | 249 | Bud layout + thread cache + theming + navigation |
| `web/src/routes/$budId/new.tsx` | 248 | Duplicated workspace logic |

## Findings

### 1. `/$budId/$threadId` is the primary god file

`web/src/routes/$budId/$threadId.tsx:308-2071` mixes at least six responsibilities:

- page-level loader hydration and state initialization
- transcript paging and optimistic message reconciliation
- agent SSE subscription and reconnect handling
- terminal session creation, recovery, history replay, and resize/input transport
- xterm lifecycle and browser keyboard/paste translation
- the final workspace UI

You can see the responsibility sprawl directly in the file:

- local state and refs: `web/src/routes/$budId/$threadId.tsx:323-393`
- transcript/bootstrap helpers: `web/src/routes/$budId/$threadId.tsx:493-542`
- xterm setup and input transport: `web/src/routes/$budId/$threadId.tsx:544-913`
- terminal recovery logic: `web/src/routes/$budId/$threadId.tsx:915-1037`
- agent stream orchestration: `web/src/routes/$budId/$threadId.tsx:1043-1380`
- terminal SSE orchestration: `web/src/routes/$budId/$threadId.tsx:1382-1725`
- optimistic send flow + final rendering: `web/src/routes/$budId/$threadId.tsx:1748-2071`

This is the clearest place where bug density and change risk will keep rising. It is also the hardest part of the app to test in isolation.

### 2. The route layer is acting as the application controller layer

The route files do not just load data; they also own long-lived client behavior, mutation flows, redirects, and UI state.

Examples:

- `web/src/routes/$budId.tsx:93-240` manages Bud layout, thread cache, theming, navigation, and modal state.
- `web/src/routes/settings.tsx:53-139` manages profile mutation, account linking, sign-out, and local success/error state.
- `web/src/routes/devices.claim.$flowId.tsx:79-333` manages claim polling, auto-approval, browser redirects, native handoff, and error mapping.

That makes each route expensive to reason about and encourages copy/paste patterns instead of reusable feature modules.

### 3. Auth gating is duplicated across routes

The root route already loads the current user in `web/src/routes/__root.tsx:11-16`, but several child routes independently call `fetchCurrentUser()` again in `beforeLoad`:

- `web/src/routes/index.tsx:19-25`
- `web/src/routes/$budId.tsx:63-69`
- `web/src/routes/settings.tsx:23-29`

This is both architectural duplication and avoidable network churn. It also spreads auth-redirect behavior across route files instead of making the protected-shell behavior explicit in one place.

### 4. `web/src/lib/api.ts` is a second god file

`web/src/lib/api.ts:1-333` currently owns:

- URL building
- login redirect construction
- unauthorized redirect side effects
- `fetch` wrapper behavior
- EventSource creation/auth-expiry probing
- API error classes
- user/device/thread/message/agent type definitions
- terminal base64 decoding
- optimistic message ID generation
- capability normalization

That is too much surface area for one shared module. It creates high coupling between auth concerns, transport concerns, domain typing, and terminal-specific behavior.

### 5. New-thread and existing-thread workspaces are intentionally duplicated

The code comments already admit the risk:

- `web/src/routes/$budId/new.tsx:1-9`
- `web/src/routes/$budId/$threadId.tsx:1-9`

And the duplication is real:

- model loading is duplicated in `web/src/routes/$budId/new.tsx:96-119` and `web/src/routes/$budId/$threadId.tsx:410-433`
- workspace shell structure is duplicated in `web/src/routes/$budId/new.tsx:177-246` and `web/src/routes/$budId/$threadId.tsx:1855-2068`
- xterm lifecycle logic exists in both routes, with the thread route holding the richer version

The current comment-based “check both files” contract will not scale. It is already a sign that the abstraction boundary is missing.

### 6. The chat timeline is a likely performance hotspot

`web/src/components/workbench/chat-timeline.tsx` is not huge by itself, but it does expensive work on every message change:

- re-sorts messages every render: `web/src/components/workbench/chat-timeline.tsx:71-77`
- recomputes scroll sync keys from message length/content: `web/src/components/workbench/chat-timeline.tsx:79-82`
- measures rendered DOM height for every visible message: `web/src/components/workbench/chat-timeline.tsx:112-125`
- renders all messages without virtualization
- statically imports `@microlink/react-json-view` for every timeline render path: `web/src/components/workbench/chat-timeline.tsx:1`

On long transcripts or streaming-heavy sessions, this will become a real UI cost. The transcript pagination helps, but the render path is still manual and measurement-heavy.

### 7. Heavy rendering dependencies are loaded eagerly

Two notable bundle-cost candidates are loaded synchronously:

- `@microlink/react-json-view` in `web/src/components/workbench/chat-timeline.tsx:1`
- `react-syntax-highlighter` in `web/src/components/ui/code-block.tsx`

These are useful features, but they are not needed for every initial render. Today they are pulled into the normal message rendering path instead of being lazy-loaded behind interaction or code-block visibility.

### 8. Mutation UX is inconsistent

Some destructive flows expose UI feedback; others only log to the console.

Example:

- thread deletion logs failure but does not surface it to the user: `web/src/components/workbench/thread-panel.tsx:113-130`
- session closing in the modal does surface errors: `web/src/components/bud-sessions-modal.tsx:107-125`

This inconsistency will produce “nothing happened” bug reports even when the backend behaves correctly.

### 9. There are several small-but-real technical debt bugs

#### Theme changes do not track OS theme changes in `system` mode

`web/src/components/theme-provider.tsx:32-43` reads `matchMedia('(prefers-color-scheme: dark)')` once, but never subscribes to changes. If the OS theme changes while the app is open, the UI will stay stale until a reload or manual theme toggle.

#### Placeholder UI is shipped as real UI

- The Bud rail has a visible add button with no action: `web/src/components/workbench/bud-rail.tsx:73-78`
- The workspace still exposes a `web` view that is only a placeholder in both routes:
  - `web/src/routes/$budId/new.tsx:199-206`
  - `web/src/routes/$budId/$threadId.tsx:1880-1890`

This is acceptable as short-term product debt, but not as a stable interaction model.

### 10. The package currently has no frontend test harness

`web/package.json:10-15` only defines `dev`, `build`, `lint`, and `preview`. A repository search also found no `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` files under `web/`.

Given how much behavior is now in client-side stream/reconnect/optimistic-state code, the lack of tests is a material risk.

## Potential Bugs / Risk Areas

These are the most actionable correctness risks I saw during review:

1. `system` theme mode will not react live to OS appearance changes.
   Reference: `web/src/components/theme-provider.tsx:32-43`

2. Thread deletion failures are silent to the user.
   Reference: `web/src/components/workbench/thread-panel.tsx:113-130`

3. The thread workspace is relying on a large amount of manual state reconciliation between loader data, optimistic rows, `/agent/state`, SSE events, and paged history. The logic is thoughtful, but the probability of edge-case regressions is high simply because of how much it does in one file.
   Reference: `web/src/routes/$budId/$threadId.tsx:323-1829`

## Concrete Improvements, Ordered By Priority

### P0

1. Split `web/src/routes/$budId/$threadId.tsx` into feature modules immediately.
   Recommended extraction:
   - `useThreadMessages(...)`
   - `useAgentStream(...)`
   - `useTerminalSession(...)`
   - `ThreadWorkspaceLayout`
   - `TerminalPane`
   - `ThreadStatusBar`

2. Break `web/src/lib/api.ts` into domain-specific modules.
   Minimum split:
   - `auth-api.ts`
   - `threads-api.ts`
   - `buds-api.ts`
   - `agent-api.ts`
   - `terminal-api.ts`
   - `transport.ts`
   - `api-types.ts`

3. Add a web test harness before more frontend refactors land.
   Start with:
   - transcript reducer/reconciliation tests
   - agent SSE event handling tests
   - terminal reconnect/recovery tests
   - route-level auth redirect tests

### P1

4. Replace duplicated route auth checks with a protected-route pattern rooted in `__root.tsx`.
   The app already has root user loading; child routes should consume that instead of re-fetching `currentUser` in each `beforeLoad`.

5. Extract shared workspace behavior from `/$budId/new` and `/$budId/$threadId`.
   At minimum:
   - `useModels()`
   - shared `WorkspaceShell`
   - shared terminal pane component
   - shared composer/status wiring

6. Introduce a real client data layer instead of manual fetch + local cache wiring.
   TanStack Query is the obvious fit here, but even a small internal feature store would be an improvement over route-local request code scattered across files.

7. Move chat rendering onto a more scalable path.
   Do this in order:
   - lazy-load payload/code viewers
   - memoize heavier per-message work more aggressively
   - add virtualization if transcript size continues to grow

### P2

8. Normalize mutation feedback patterns.
   All destructive actions should have the same standard:
   - pending state
   - success state or optimistic update
   - visible failure state
   - no console-only failures

9. Consolidate duplicated UI helpers.
   Candidates already duplicated:
   - relative time formatting
   - session-state labels/colors
   - auth redirect helpers
   - model-loading logic

10. Fix low-cost product debt that currently reads like unfinished UI.
   - wire up or remove the Bud rail add button
   - gate or hide the placeholder web-view toggle until it exists
   - subscribe to `matchMedia` changes in `ThemeProvider`

## Suggested Refactor Sequence

If you want to tackle this without destabilizing the app, I would do it in this order:

1. Add tests around transcript reconciliation and stream event handling.
2. Extract `useModels()` and shared workspace shell pieces.
3. Extract `useAgentStream()` from `/$budId/$threadId`.
4. Extract `useTerminalSession()` from `/$budId/$threadId`.
5. Split `api.ts` by domain.
6. Replace route-level auth duplication with a protected-shell approach.
7. Optimize/lazy-load timeline payload and markdown heavy dependencies.

## Bottom Line

The web app is at the point where further feature work will be meaningfully slower and riskier unless the thread workspace and shared API layer are decomposed. The highest-value change is to stop treating the thread route as the application runtime and move that logic into testable feature modules.
