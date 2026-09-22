# Debug: Shared-browser startup schema check

## Environment and reproduction
Local HTTPS launcher (`pnpm dev:https`), PostgreSQL with Phase 3k migrations 0044–0046.
Touching `service/src/server.ts` triggers the existing tsx watcher restart.

## Observed
Service startup failed at server.ts:212 with PostgreSQL 42703:
`column "control_state" does not exist`. Port 3000 was not listening and Caddy
returned 502. The daemon and native Chrome were not restarted.

## Cause and fix
The composition readiness query still selected removed workspace authority columns.
Check workspace identity/order on browser_session and shared authority/lifecycle
on browser_resource separately, then run the existing global control recovery.

## Validation
The watcher restarted successfully and the service listens on port 3000.
Direct `/readyz` returned `ok: true` with database and auth schema checks passing.
HTTPS `/api/me` through Caddy returned the expected unauthenticated JSON 401,
confirming backend routing. `/readyz` on the HTTPS frontend serves Vite HTML,
so readiness was checked directly on the service instead.
