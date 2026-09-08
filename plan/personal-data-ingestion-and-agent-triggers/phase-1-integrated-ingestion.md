# Phase 1: Integrated ingestion

Status: main API ingestion, owner-scoped storage/jobs, ACKs and routing implemented; public-origin mobile and deployment acceptance remain open. Dependencies: phase 0. Parent: [implementation spec](implementation-spec.md).

## Outcome and source boundaries

Main service accepts mobile batches, authenticates their owner, stores events and durable work, then explicitly ACKs. No LLM, daemon or projection must be available to ingest. Port useful parser/validator code from `bud-ingest/src/ingest` and `src/routes/ingest.ts`; adapt to main auth rather than importing standalone HS256/dev-user behavior.

## Implementation

- Add an encapsulated ingestion plugin/module with `/v1/events/batches`; retain `/ingest` only if compatibility inventory shows consumers, and route it to the same handler. Accept existing plain/gzip NDJSON and installation/batch headers. Register raw-body parsing locally, leaving other Fastify parsers intact.
- Resolve the OAuth/cookie viewer using main auth; mobile uses bearer. Register or validate an owner-bound installation before accepted writes. Reject actor-owner mismatch, revoked epoch and unsupported installation claims. Never map an invalid bearer to a development user.
- Add installation/epoch, immutable raw event and processing-job schema plus constraints. Existing envelopes without new source metadata remain stored with limited coverage. Transactionally insert each new event and its processor job; respond only after committed acceptance. Duplicate same-owner/same-payload events are ACKable without duplicate jobs. Preserve conflicts for explicit remediation.
- Enforce compressed/uncompressed/line/event limits while reading, including truncated gzip, disconnect and decoder failures. Start from standalone bounds (5 MB compressed, 25 MB decoded, 500 events, 256 KB line); confirm exact byte definitions in fixtures. A request-wide parse failure produces no success ACK; already committed events remain safe on retry.
- Partial acceptance explicitly lists only accepted/identical-duplicate submitted IDs. Errors distinguish retryable service failures, oversized batches and permanent per-event rejection. Include bounded retry hints and redacted diagnostic IDs. DB failure cannot produce an ACK for uncommitted rows.
- Add feature/status discovery for supported envelope/projection versions. Upload status is distinct from projection readiness. Unknown valid types are retained but do not generate unsupported domain events.
- Update Cloudflare Worker path classification and route bindings, Vite and applicable local HTTPS/Caddy routing. Exercise the actual public origin: an HTML fallback must never count as ingestion success.

## Ownership and operational controls

Every accepted row is stamped from the authenticated owner, not envelope identity. Jobs inherit that owner. Apply per-owner request/concurrency limits and configurable development storage budgets; storage exhaustion is visible backpressure, never silent event deletion. Routine logs contain event/batch IDs, counts and codes, not raw contacts/location/health.

## Acceptance

- [ ] Public-origin gzip upload from mobile fixture reaches main DB and returns a matching explicit ACK.
- [ ] Lost ACK/retry creates one raw event and one processing job; same-ID conflict preserves original.
- [ ] Malformed/oversized/mixed batches and DB failures satisfy I-series tests; unrelated Fastify routes still parse normally.
- [ ] Two owners cannot upload into each other's installation or read each other's status.
- [ ] Old health/location fixtures are accepted without enabling health features.

Update service/source/routes/auth/DB specs, new ingestion child spec, deploy docs and migration index. Schema implementation requires package-local `pnpm db:push`, `pnpm db:generate`, reviewed migration SQL and staging migration verification; local schema application and generated migration evidence are recorded in the progress checklist; staging verification remains open. Roll out additive ingestion with automation disabled; do not retire standalone data yet.
