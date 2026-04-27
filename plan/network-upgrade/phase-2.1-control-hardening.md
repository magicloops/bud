# Phase 2.1: Control-Plane Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Phase 2**: [phase-2-http2-grpc-control-plane.md](./phase-2-http2-grpc-control-plane.md)
**Status**: Implemented local hardening slice

---

## Objective

Close the small set of Phase 2 gaps that directly affect Phase 3 data-plane correctness without pulling in the larger production hardening backlog.

Phase 3 can now assume the service can shut down active gRPC control streams through Fastify's close lifecycle, persist durable session closure, and reject invalid transition credentials with a typed protocol error.

## Implemented

- Service `SIGINT` / `SIGTERM` handling now calls `server.close()` so Fastify `onClose` runs during normal process shutdown.
- The gRPC gateway shutdown path explicitly finalizes active gRPC trackers before DB pools close.
- Finalization removes the active tracker, closes `device_session` and `transport_session` with `grpc_control_gateway_shutdown`, stamps drain timestamps, and runs Bud offline side effects when no alternate transport remains.
- Trackers distinguish in-progress finalization from completed finalization so late stream-close events cannot overwrite shutdown closure as `superseded`.
- Invalid enrollment credentials over gRPC return a typed `AUTH_FAILED` error frame.
- Focused unit coverage protects the gRPC tracker finalization path.

## Validation

- Focused service tests:
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/grpc/control-gateway.test.ts src/grpc/envelope-codec.test.ts src/ws/gateway.test.ts`
- Local SIGTERM smoke:
  - service started with `GRPC_CONTROL_ENABLED=true`
  - daemon enrolled over `BUD_GRPC_CONTROL_URL`
  - `SIGTERM` sent to the Node service process
  - DB recorded Bud offline plus closed `device_session` and `transport_session` rows with `close_reason = "grpc_control_gateway_shutdown"` and drain timestamps
- Invalid-token smoke:
  - local grpc-js client sent `hello` with an invalid token
  - gateway returned `error { code: "AUTH_FAILED", message: "Enrollment token invalid or expired" }`

## Still Deferred

- Hosted/front-door native HTTP/2 validation.
- Keypair, mTLS, or short-lived token binding to replace the shared-secret transition credential.
- Generated grpc-js TypeScript bindings from Buf, if the isolated proto-loader adapter becomes too noisy.
- Production-shaped churn/load/backpressure validation.
- Metrics and operator runbooks.
- Full terminal ensure/send/observe manual smoke through authenticated browser routes.

## Phase 3 Handoff

Phase 3 should build on the existing control stream as the metadata and lifecycle authority:

- keep authentication, capability exchange, reconnect reports, stream-open directives, resets, and drain notices on `BudControl.Connect`
- add a separate HTTP/2 data attachment service for high-volume terminal/proxy/file bytes
- continue persisting stream lifecycle in `bud_stream`
- treat data streams as subordinate to an authenticated control session
- keep WebSocket compatibility carrying the same stream frames with lower limits
