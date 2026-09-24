# Debug: Healthy browser status polling

## Environment / reproduction

2026-09-24 macOS development checkout, Fastify service and shared web/mobile viewer.
User supplied successful inventory and metadata requests for four thread IDs and
one viewer. Open several Bud thread tabs and leave a passive browser image idle.
No evidence in this excerpt proves leaked components.

## Observed and expected

Inventory repeats after five seconds, metadata and Bud lifecycle after three.
Private renewal is independently five seconds. Fastify's default pair of INFO
access logs expands each request across many lines. Phase 7e only backs off failures.
Expected: one reconciled snapshot followed by notifications; no healthy idle GETs.

## Implementation approach

Phase 7f: database commit notifications cover browser resource/session/handoff,
Bud presence/capability and thread ownership/deletion changes across writers.
Filtered triggers omit timestamps, dispatch sequence and renewal-only updates.
A dedicated PostgreSQL LISTEN connection fans out hints; reconnecting the listener
invalidates every attached client before subscriptions resume. No durable event log.
This requires a custom migration (no new rows/columns). Browser relay/control still
requires one gateway instance; notification delivery can cross database clients.

Authorized thread/session/Bud state WebSockets expose only ready/changed/heartbeat,
not page or controller data. Mobile can subscribe only to its granted session.
Existing metadata remains authoritative. One visit-owned feed is shared by pane,
viewer and lifecycle controls. Hidden passive reads wait for resume; private
renewal is preserved. State-channel loss fences private input pending reconciliation.

Authentication/ownership is checked before attachment and before change delivery;
a separate periodic authorization check handles expiration/revocation even when
idle. Transport heartbeats do not read browser metadata or capture pixels.
No operation or cell is replayed. Initial reads follow subscription readiness.

## Validation

Implemented; focused tests and builds pass as recorded below. Physical iPhone
and real web traffic acceptance remain manual gates.

## Validation notes

- `pnpm --dir web exec tsc -b` initially rejected a constructor parameter property
  under `erasableSyntaxOnly`; replaced with an explicit field.
- `pnpm --dir service db:push` proposed the unrelated existing
  `agent_invocation_dedupe_key` constraint on 291 rows and offered truncation.
  Canceled without applying/truncating (`drizzle-kit push exited with code 1`).
  This phase has no Drizzle table/column changes; its generated custom SQL
  migration is applied separately as a transaction.

## Producer/consumer audit

| State producer | Delivery / consumer |
| --- | --- |
| Workspace creation, close, runtime boot/generation replacement | Session trigger → thread/session feed → inventory and metadata |
| Takeover, Return, release, lease expiry, stop/reset intent and completion | Resource trigger → all Bud scopes → metadata/lifecycle |
| Controller installed after acquire completes | Local post-install hint → all Bud scopes; renewal emits none |
| Handoff create/resolve/cancel | Handoff trigger → owning thread/session inventory/metadata |
| Capability, persisted presence, ownership or device-secret change | Bud trigger → all affected scopes with reauthorization |
| WS/gRPC registry attach/detach | Post-registry local presence hint → current gateway viewers |
| Thread reparent/delete/owner change | Old/new scope notifications → live authorization closure |
| Other worker's committed mutation | Shared PostgreSQL NOTIFY → gateway's pinned LISTEN connection |

Embedded consumers share a visit-owned thread feed; standalone/mobile use a session
feed, and standalone lifecycle can use a Bud feed. Disposal aborts readers and
closes the last subscription. Independent open browser documents remain independent
visits. No global cache, chat-content subscription or new replay log is introduced.

## Final validation (2026-09-24)

- `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/access-log.test.ts src/browser/state-events.test.ts src/browser/state-stream.test.ts src/browser/state-routes.test.ts src/browser/control.test.ts src/browser/media-idle.test.ts src/browser/mobile-auth.test.ts` from `service/`: 29 passed, zero skipped.
- `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/state-feed.test.tsx src/features/browser/pane.test.tsx src/features/browser/lifecycle.test.tsx src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx src/features/threads/client-recovery.test.tsx` from `web/`: 34 passed, zero skipped.
- `pnpm --dir service build` and `pnpm --dir web build`: passed. Existing Vite large-chunk warning remains.
- Applied generated migration 0042 SQL transactionally to local DB. Isolated DB regression applies that exact SQL, verifies commit/rollback and renewal filtering, and terminates its own LISTEN backend to test reconnection.
- Fake-clock mounted tests count no recurring idle inventory/metadata/resource requests or canvas redraws for 60 seconds; private mode retains 12 renewals. They do not measure physical daemon screenshots.

Rollout: migrate 0042, start updated service/shared web, reload clients. Reserve one
additional session-preserving PG pool slot per gateway; no transaction-mode pooler
for LISTEN. Existing single-gateway media/controller routing remains required.
No daemon/native iOS build, runtime restart, commit or deployment was performed.
Real signed-in web/ngrok and physical iPhone idle/takeover/Return/reconnect traffic
measurements remain unverified and are carried into Phase 8.
