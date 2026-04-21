# Phase 4: Thread Runtime Decomposition

## Objective

Split the existing-thread route into explicit runtime ownership units so the route becomes a composition layer instead of the application runtime.

This is the core architectural phase of the web refactor.

## Scope

### In scope

- decompose `web/src/routes/$budId/$threadId.tsx`
- extract transcript/message-state ownership
- extract agent SSE ownership
- extract terminal session/xterm ownership
- extract terminal status-bar and overlay presentation from the runtime logic

### Out of scope

- major new UX features
- large-scale performance tuning beyond what is directly required by the split
- backend contract redesign

## Proposed Work

### 1. Extract message/transcript ownership

Create a dedicated unit for:

- bootstrapping transcript + agent-state overlays
- optimistic message insertion
- canonical persistence reconciliation
- draft assistant and pending tool reconciliation
- older-message pagination

Possible ownership shapes:

- `useThreadMessages(...)`
- `thread-message-reducer.ts`
- `agent-overlay.ts`

The key requirement is that message behavior becomes testable without mounting the full thread page.

### 2. Extract agent stream ownership

Create a dedicated unit for:

- SSE attach
- cursor resume logic
- heartbeat/reconnect logic
- explicit resync handling
- event-to-message-state translation
- thread-title update emission

Possible ownership shape:

- `useAgentStream(...)`

It should depend on a narrow message/update interface rather than mutating route-local state ad hoc.

### 3. Extract terminal session ownership

Create a dedicated unit for:

- terminal session creation/ensure
- terminal history replay
- xterm lifecycle
- resize/input/paste/keyboard translation
- reconnect/recovery logic
- terminal readiness/status state

Possible ownership split:

- `useTerminalSession(...)`
- `useXtermInstance(...)`
- `terminal-reconnect.ts`

This is the place to separate pure state transitions from xterm imperative lifecycle concerns where practical.

### 4. Extract presentation-only pieces from runtime code

After the runtime logic is split, the remaining route/component layer should mostly render:

- shared workspace shell
- chat timeline
- terminal pane
- terminal status bar
- menus/overlays

Presentation components should not own reconnect policy or transcript reconciliation.

### 5. Keep ownership seams explicit

The final route should clearly express:

- what it loads
- which feature hooks it composes
- which child presentation components it renders

It should not recreate a second hidden runtime via large inline callbacks and refs.

## Expected File Areas

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/lib/terminal-input.ts`
- new thread/agent/terminal feature modules under `web/src/`

## Testing Strategy

### Automated

- transcript reducer/reconciliation tests
- agent stream event-sequence tests
- terminal reconnect/recovery state tests
- route integration tests covering optimistic send + canonical reconcile

### Manual

- existing thread load
- optimistic user send
- assistant/tool streaming
- reconnect after temporary disconnect
- terminal recovery after Bud offline/online
- thread switching while live streams exist

## Exit Criteria

- `/$budId/$threadId` is reduced to a thin composition layer
- message, agent-stream, and terminal-session logic have explicit ownership modules
- the extracted seams are covered by automated tests
- thread switching and reconnect behavior remain correct after the split
