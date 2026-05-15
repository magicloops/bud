# Phase 9c: Browser-To-Local Gateway Echo

## Context

Service runtime tests prove isolated WebSocket forwarding behavior, and daemon
tests will prove local WebSocket bridge behavior. This phase covers the seam
between them: an authorized endpoint-host browser upgrade reaching a local echo
server through the data-plane bridge.

Related docs:

- `phase-5b-gateway-upgrade-and-browser-bridge.md`
- `phase-5d-websocket-regression-and-failure-states.md`
- `phase-9b-daemon-local-websocket-echo.md`

## Objective

Prove that an authenticated browser can open a proxied endpoint-host WebSocket
and round-trip messages to a local WebSocket server through the Bud daemon path.

## Scope

- Endpoint-host WebSocket upgrade.
- Viewer-cookie authorization.
- Service `proxy_ws_open` dispatch.
- Daemon/local acceptance.
- Text/binary round trips.
- Browser close and local close propagation.
- Open timeout and oversized-message behavior through the gateway path.

## Non-Goals

- No broad browser matrix beyond Chrome/local test harness.
- No public/password access.
- No production edge validation; Phase 9f owns deployment checks.

## Design / Approach

Prefer an integration-style harness that runs:

- service route/gateway handler
- fake or real data-plane carrier
- Bud daemon local WebSocket bridge, if feasible
- in-process local echo server
- test browser WebSocket client

If one harness is too expensive, split into two deterministic tests:

- service endpoint-host gateway with a fake data-plane carrier that echoes
  `proxy_ws_message` frames
- daemon local echo test from Phase 9b

At least one manual or automated smoke should exercise both sides together
before production rollout.

## Spec Files To Update

- [x] `service/src/routes/routes.spec.md`
- [x] `service/src/proxy/proxy.spec.md`
- [x] `service/src/transport/transport.spec.md` if carrier harness changes
- [x] `bud/src/src.spec.md` if daemon harness changes
- [x] `plan/web-proxy/progress-checklist.md`
- [x] `plan/web-proxy/validation-checklist.md`

## Impacted Contracts

- [ ] WSS protocol: only if frame semantics change
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no

## Test Plan

The first implemented harness is the split deterministic approach: service
gateway tests use a fake data-plane carrier, and daemon tests use the Phase 9b
local echo server.

Expected service coverage:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/proxied-sites.test.ts src/proxy/proxy-ws-runtime.test.ts
pnpm --dir /Users/adam/bud/service exec tsc --noEmit
```

Daemon-side validation should reuse the Phase 9b test command.

## Implemented Coverage

- `service/src/routes/proxied-sites.test.ts` now covers an authorized
  endpoint-host WebSocket upgrade through viewer-cookie auth, sanitized
  subprotocol forwarding, browser text and binary frames sent to the daemon,
  daemon text and binary frames delivered to the browser, daemon/local close
  delivered to the browser, browser close propagated back to the daemon,
  oversized browser-message failure, and local-open timeout failure.
- A full service+daemon+browser automated smoke is still open; the current
  coverage intentionally keeps the gateway and daemon echo harnesses separate
  for deterministic unit-level feedback.

## Acceptance Criteria

- Authorized endpoint-host upgrade reaches the proxy WebSocket bridge.
- Text and binary messages round-trip browser to local server and back.
- Browser close reaches the local server.
- Local close reaches the browser with code/reason where supported.
- Oversized and open-timeout failures close with typed service behavior.
