# Debug: grpc-control-shutdown-finalization

## Environment

- macOS local development
- Service dev server with `GRPC_CONTROL_ENABLED=true`
- Bud daemon using `BUD_GRPC_CONTROL_URL`
- Local PostgreSQL through the service `DATABASE_URL`

## Repro Steps

1. Start the service with the gRPC control gateway enabled.
2. Start the Bud daemon with a gRPC control URL and a dev transition token.
3. Confirm the daemon enrolls and heartbeats over `h2_grpc`.
4. Stop the service before stopping the daemon.
5. Inspect the newest `device_session` and `transport_session` rows for the Bud.

## Observed

- Daemon-initiated disconnect closes the active gRPC control stream and marks the Bud, `device_session`, and `transport_session` offline/closed.
- Service-first shutdown stops the gateway and the daemon retries, but the newest `device_session` and `transport_session` can remain `active` in the DB.

## Expected

- Service shutdown should finalize every active gRPC tracker before the DB pool closes.
- Active gRPC `device_session` and `transport_session` rows should be closed with a shutdown/drain reason even if the daemon does not disconnect first.
- The Bud should be marked offline when no WebSocket or gRPC transport remains online.

## Hypotheses

- `startGrpcControlGateway().close()` starts gateway drain and ends active gRPC calls, but does not await the per-connection `handleClose(...)` path.
- Fastify `onClose` then closes shared DB pools, so late stream events cannot reliably persist session closure.

## Proposed Fix

- Add an explicit shutdown finalization path for active gRPC session trackers.
- Delete trackers from the active gRPC router before closing durable rows so routing immediately reports offline.
- Mark durable transport/device rows closed with a service-shutdown reason and `drainStartedAt`.
- Run Bud offline side effects when no alternate transport remains online.
- Prevent late stream close handlers from overwriting an already-finalized tracker as `superseded`.
- Add focused unit coverage for the tracker finalization path.

## Resolution

- Added `SIGINT` / `SIGTERM` handling in `service/src/server.ts` so process shutdown calls `server.close()`.
- Added explicit gRPC tracker finalization during gateway close.
- Added `finalizing` / `finalized` tracker state so late stream-close events do not skip durable shutdown work or rewrite close reasons.
- Local SIGTERM smoke confirmed Bud offline plus closed `device_session` and `transport_session` rows with `close_reason = "grpc_control_gateway_shutdown"`.
- Local invalid-token smoke confirmed gRPC returns a typed `AUTH_FAILED` frame.

## Remaining Caveat

PTY Ctrl-C against the local `pnpm exec tsx` wrapper can kill the wrapper before the app receives a graceful signal. Validation of service-first shutdown should use actual `SIGTERM` or the deploy process manager's graceful stop path.

## Spec Files Affected

- `service/src/grpc/grpc.spec.md`
- `plan/network-upgrade/phase-2-deferred-hardening.md`
- `plan/network-upgrade/validation-checklist.md`
