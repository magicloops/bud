# Phase 4: Route And Gateway Decomposition

## Objective

Decompose the large transport files so route registration and websocket runtime concerns are easier to reason about, while keeping ownership and authorization checks explicit at every browser-visible boundary.

## Scope

### In scope

- split `routes/threads.ts` into smaller route modules
- split `ws/gateway.ts` into clearer handshake, tracker, routing, and offline-transition units
- thin down `server.ts` so it becomes a composition root rather than a mixed bootstrap file
- remove any remaining references to deleted legacy runtime surfaces

### Out of scope

- redesigning browser API shapes beyond what earlier bug fixes or boundary cleanup already required
- changing ownership semantics
- introducing new browser-visible features

## Proposed Work

### 1. Split the thread route family by resource ownership

A likely shape is:

```text
routes/threads/
  index.ts
  threads.ts
  messages.ts
  agent.ts
  terminal.ts
  shared.ts
```

The important part is not the exact layout. It is that:

- thread CRUD
- message creation/history
- agent state/stream/cancel
- terminal create/ensure/input/history/stream

stop living in one nearly-1000-line file.

### 2. Keep ownership checks at the route boundary

Do not centralize so aggressively that ownership enforcement becomes implicit. Each browser-visible path should still make it obvious:

- how the viewer is resolved
- how the owned thread or Bud is resolved
- where `401` vs `404` behavior is determined

### 3. Split websocket gateway ownership

Likely boundaries:

- hello/auth/enrollment handshake
- active session tracking
- frame routing by message type
- Bud online/offline transition behavior

This should leave `gateway.ts` as a thinner shell or export surface rather than the primary implementation unit.

### 4. Thin the top-level server bootstrap

After the route and gateway splits, `server.ts` should mainly:

- construct shared services
- register routes/plugins
- register the websocket gateway
- expose health/readiness endpoints

It should stop owning legacy stream routes or runtime-specific transport behavior directly.

## Expected File Areas

- `service/src/routes/threads.ts`
- new files under `service/src/routes/threads/`
- `service/src/ws/gateway.ts`
- new files under `service/src/ws/`
- `service/src/server.ts`

## Testing Strategy

### Automated

- route registration tests or route-level integration coverage for thread/message/agent/terminal endpoints
- gateway-level tests for handshake, tracker replacement, and offline transitions across the new seams
- regression coverage that browser-visible streams still attach only after ownership resolution

### Manual

- open a thread and attach to agent/terminal streams from the browser
- reconnect a Bud and confirm terminal/gateway behavior still recovers correctly
- verify that multi-user ownership behavior remains unchanged for the browser-facing routes

## Exit Criteria

- thread route ownership is split across smaller modules
- websocket handshake/tracker/frame-routing/offline-transition logic have clearer units
- `server.ts` is mainly a composition root
- no deleted legacy runtime surface is still referenced from route or gateway bootstrap
