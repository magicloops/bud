# Phase 9d: Daemon Disconnect Cleanup

## Context

Manual HMR validation proved the happy path, but production users will
disconnect daemons, reload browsers, and reconnect while proxy work is active.
The service must close browser-visible work and clear runtime state rather than
leaving stale streams or indefinite loading states.

Related docs:

- `phase-5b-gateway-upgrade-and-browser-bridge.md`
- `phase-5d-websocket-regression-and-failure-states.md`
- `phase-9c-browser-to-local-gateway-echo.md`

## Objective

Prove that daemon disconnect and data-plane finalization cleanly reset active
HTTP and WebSocket proxy work.

## Scope

- Active WebSocket session cleanup on daemon disconnect.
- Active HTTP proxy stream cleanup on daemon disconnect.
- Runtime map cleanup.
- `proxied_site.active_stream_id` cleanup where applicable.
- Reconnect/reload recovery without stale stream ids.
- Idle Vite HMR reset-storm validation.

## Non-Goals

- No new reconnect protocol design unless tests expose an existing bug.
- No UI redesign for failure presentation.
- No gateway extraction.

## Design / Approach

Add service runtime/transport tests around data-plane finalization:

- register active HTTP proxy runtime stream and finalize carrier
- register active WebSocket proxy runtime session and finalize carrier
- assert browser WebSocket closes with typed transport-lost behavior
- assert HTTP stream resets/completes with typed transport-lost behavior
- assert runtime stream maps and proxy runtime session maps are empty
- assert durable active stream state is cleared when the owning site is known
- assert repeated reload after reconnect allocates a fresh stream id

Add a manual or automated Vite idle smoke:

- open proxied Vite dev server
- leave HMR socket idle for at least one minute
- confirm no request/reset storm in browser network logs and daemon/service
  logs
- disconnect daemon
- confirm browser/app exits loading state or reports transport loss
- reconnect and reload
- confirm recovery

## Spec Files To Update

- [x] `service/src/transport/transport.spec.md`
- [ ] `service/src/ws/ws.spec.md`
- [x] `service/src/proxy/proxy.spec.md`
- [x] `service/src/routes/routes.spec.md` if route behavior changes
- [x] `plan/web-proxy/progress-checklist.md`
- [x] `plan/web-proxy/validation-checklist.md`

## Impacted Contracts

- [ ] WSS protocol: only if disconnect/reset semantics change
- [ ] SSE events: only if new failure-state events are added
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: only if failure-state surfacing changes

## Test Plan

Expected focused service tests:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/transport/data-plane-router.test.ts src/ws/bud-connection.test.ts src/proxy/proxy-ws-runtime.test.ts src/routes/proxied-sites.test.ts
pnpm --dir /Users/adam/bud/service exec tsc --noEmit
```

Manual Vite reset-storm runbook should be recorded in this doc once executed.

## Implemented Coverage

- `service/src/routes/proxied-sites.test.ts` now opens an authorized proxied
  WebSocket, finalizes the selected data-plane carrier through
  `resetRuntimeStreamsForDataPlaneTracker(...)`, and asserts browser close,
  runtime map cleanup, data-plane runtime-stream cleanup, and durable
  `proxied_site.active_stream_id` cleanup.
- `service/src/proxy/proxy-edge.test.ts` now opens an accepted durable HTTP
  proxied-site stream, finalizes the selected data-plane carrier, and asserts
  HTTP response stream destruction, proxy runtime cleanup, data-plane
  runtime-stream cleanup, and durable `proxied_site.active_stream_id` cleanup.
- Reconnect/reload stale-stream behavior and the idle Vite reset-storm run
  remain follow-up checks.

## Acceptance Criteria

- Active WebSockets close on daemon disconnect.
- Active HTTP proxy streams reset or complete on daemon disconnect.
- Runtime state and durable active stream state do not remain stale.
- Reload after reconnect recovers with a new stream.
- Idle Vite HMR does not produce a request/reset storm.
