# Phase 9e: Diagnostics And Log Hygiene

## Context

The proxy path now has several moving parts: endpoint-host auth, service
gateway, data-plane carrier, daemon loopback client, and local app. Failures
need enough structured context to debug without leaking private app content or
auth material.

Related docs:

- `phase-5-prep-observability-and-hardening.md`
- `phase-5d-websocket-regression-and-failure-states.md`
- `validation-checklist.md`

## Objective

Make proxy failures observable with canonical error context while keeping
grants, cookies, request/response bodies, and WebSocket payloads out of logs.

## Scope

- Service-side reset/open-failure logs.
- Daemon-side inbound reset/error logs.
- Product-visible diagnostic states where the owning app can observe them.
- Log hygiene assertions for secrets and payload bodies.

## Non-Goals

- No centralized metrics dashboard.
- No gateway extraction metrics.
- No public-sharing audit model.

## Design / Approach

Add structured context to failure logs:

- canonical error code
- stream id
- proxied site id where available
- Bud id
- transport kind
- request path
- target port, but not raw query secrets
- failure phase, for example auth, open, stream, close, reset, local connect

Confirm logs omit:

- viewer grant tokens
- viewer cookies
- Bud auth/session cookies
- request bodies
- response bodies
- WebSocket message payloads

Where useful, surface product-visible state for:

- local WebSocket connect failure
- HTTP local connect failure
- WebSocket connection limit failures
- open timeout
- transport loss after a proxied site is already open

## Spec Files To Update

- [ ] `service/src/proxy/proxy.spec.md`
- [ ] `service/src/transport/transport.spec.md`
- [ ] `service/src/ws/ws.spec.md`
- [ ] `bud/src/src.spec.md` if daemon logging changes
- [ ] `web/src/features/threads/threads.spec.md` if web state changes
- [ ] `web/src/components/workbench/workbench.spec.md` if UI state changes
- [ ] `plan/web-proxy/progress-checklist.md`
- [ ] `plan/web-proxy/validation-checklist.md`

## Impacted Contracts

- [ ] WSS protocol: no
- [ ] SSE events: only if new product-visible state events are added
- [ ] DB schema: no
- [ ] Agent tools: only if tool result diagnostics change
- [ ] Web UI: only if new state fields are shown

## Test Plan

- Add unit tests for log-field construction where practical.
- Add route/runtime tests for failure-state serialization if new API fields are
  introduced.
- Run focused service and daemon tests for touched modules.

Expected service baseline:

```bash
pnpm --dir /Users/adam/bud/service exec tsc --noEmit
```

Expected daemon baseline if Rust logging changes:

```bash
cargo check
```

## Acceptance Criteria

- Reset/open-failure logs have enough structured context to diagnose where a
  proxy request failed.
- Tests or code review demonstrate secrets and payloads are not logged.
- Product-visible states distinguish local connect failure, connection limit,
  open timeout, and transport loss where observable.
