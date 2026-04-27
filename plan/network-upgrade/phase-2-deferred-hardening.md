# Phase 2 Deferred Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Phase 2**: [phase-2-http2-grpc-control-plane.md](./phase-2-http2-grpc-control-plane.md)
**Status**: Deferred backlog

---

## Purpose

Phase 2 now has an opt-in gRPC control-plane slice: grpc-js on the service, tonic/prost on the daemon, `BudControl.Connect`, durable session registration, heartbeat/offline handling, reconnect reconciliation, terminal control/result routing, and WebSocket fallback.

This file captures hardening work that should not block the Phase 3 HTTP/2 data-plane design, but must be resolved before file viewing or web-serving capabilities depend on gRPC control in production.

## Defer Until After The Local Acceptance Gate

- **Hosted/front-door gRPC validation**: prove staging can route native HTTP/2 gRPC end to end, including TLS termination, proxy headers, idle timeouts, and deploy restarts.
- **Device identity hardening**: replace the shared-secret transition credential with keypair challenge, mTLS, or short-lived token binding tied to the authenticated control session.
- **Generated service bindings**: decide whether isolated `@grpc/proto-loader` remains acceptable or switch `service/src/grpc/` to Buf-managed grpc-js TypeScript generation.
- **gRPC status taxonomy**: map daemon/control errors to canonical grpc-js statuses and trailers instead of relying mostly on JSON `error` frames.
- **Lifecycle/load validation**: add production-shaped churn, reconnect, slow-receiver, and gateway-drain tests outside the spike harness.
- **Observability**: add control stream metrics for active sessions, auth failures, heartbeat lag, reconnect decisions, drain, backpressure, and transport kind.
- **Operator controls**: add explicit config/runbook coverage for enabling/disabling gRPC control, fallback behavior, listener placement, and drain windows.
- **Security review for file/web-serving**: require hardened control identity plus daemon local policy before file reads or localhost web serving can be exposed.

## Acceptance Gate Before Phase 3

Run a small local validation now:

- service starts with `GRPC_CONTROL_ENABLED=true`
- daemon connects with `BUD_GRPC_CONTROL_URL`
- enrollment or reconnect auth succeeds
- service records `device_session` and `transport_session.transport_kind = "h2_grpc"`
- daemon sends heartbeat and reconnect report
- service sends reconciliation decision
- terminal ensure/send/observe still works through the composite router
- WebSocket fallback still builds/tests

If this gate passes, Phase 3 can proceed while the backlog above remains tracked.

## Local Smoke Notes - 2026-04-27

- Service started locally with `GRPC_CONTROL_ENABLED=true` on `127.0.0.1:55051`.
- Daemon connected with `BUD_GRPC_CONTROL_URL` and the dev transition token.
- Service registered an active gRPC Bud tracker for `b_01KQ644R2GS0GXWR0WE0628RPS`.
- The DB recorded active `device_session` / `transport_session` rows with `transport_kind = "h2_grpc"` and fresh heartbeat timestamps.
- Daemon-initiated shutdown closed the gRPC stream and marked the Bud, device session, and transport session offline/closed.
- Reconnect with the same identity file created a new active h2 gRPC session while preserving the prior closed session.
- Service-first shutdown left the newest session marked active in the DB because the dev-server stop path did not finalize active gRPC rows. Track this under graceful shutdown finalization before production use.

## Phase 2.1 Update - 2026-04-27

[phase-2.1-control-hardening.md](./phase-2.1-control-hardening.md) fixed the local graceful shutdown gap for normal process signals. `SIGTERM` now runs Fastify `onClose`, the gRPC gateway finalizes active trackers, and local smoke coverage confirmed Bud/device/transport closure with `close_reason = "grpc_control_gateway_shutdown"`.

The remaining lifecycle item is broader production validation: hosted drain behavior, deployment front-door timeouts, load/churn, and observability.
