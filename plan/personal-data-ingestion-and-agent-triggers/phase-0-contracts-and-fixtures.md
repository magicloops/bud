# Phase 0: Contracts and fixtures

Status: contracts implemented and exercised by service/mobile fixtures; shared fixture catalog added; live compatibility evidence remains incomplete. Dependencies: none. Parent: [implementation spec](implementation-spec.md).

Credential delivery decision: [app-backend public-key handoff](app-key-handoff.md), with encrypted durable delivery and signed installation receipts. No daemon protocol change is needed. Repository, helper, client review and durable continuation are implemented; local HTTP/PostgreSQL integration passes. Live agent/opposite-client/private-viewer acceptance remains open; this does not complete the phase gate.

## Outcome

Freeze shared fixtures and recovery boundaries before independent service/mobile work. Review the source entry points in the [design](../../design/personal-data-ingestion-and-agent-triggers.md); inventory existing local queues and standalone ingest data without modifying them.

## Work

1. Capture fixtures for v1 location/health envelopes and gzip/plain NDJSON, full/partial/duplicate ACKs and permanent/retryable errors. Preserve `schema_version`, `event_id`, `event_type`, `occurred_at`, `recorded_at`, `actor`, `source`, `consent`, `context`, `payload`. Server receipt time and resolved owner are separate canonical fields.
2. Define an additive contacts payload version with source identity `(installation_id, collection_epoch, contact_store_id, source_contact_id)`, `scan_id`, integer `generation`, `previous_generation`, `scan_mode`, observation timestamps, approved fields and source visibility. Modes: `baseline`, `incremental`, `access_change`, `resync`. Use durable UUID event IDs, never recreate an ID on upload retry. Unknown contact creation time uses an explicit observed-time basis, not a fabricated creation timestamp.
3. Specify scan records plus a completion manifest with expected event count and digest of the canonical sorted event-ID set. An empty scan has a manifest too. State publication requires the full set, predecessor generation and matching digest; an incomplete/missing predecessor is visible and retryable. Bound scan size, stream/chunk locally, and stage server rows without holding one huge transaction. A known source reset establishes a new baseline/epoch rather than waiting forever for a vanished predecessor.
4. Define a single owner publication lock/order for complete scans, domain events, rule activation and bootstrap capture. Choose the Postgres locking helper and transaction order, document deadlock handling, and demonstrate that a late-committing event cannot be skipped. Raw ingest can proceed independently; its ACK is not publication.
5. Define source capabilities/status discovery and main OAuth token-provider interface for mobile. Capture account-switch and legacy-unscoped-queue migration fixtures. Automatic reassignment of old data to the currently signed-in user is forbidden.
6. Define typed invocation outcomes and selected-model availability failures. Offline/unavailable before dispatch waits; model substitution is forbidden. Classify known-safe retry versus uncertain external effects. Fix concrete configurable defaults from the parent in one service contract.
7. Resolve credential handoff before phase 7 coding. Preferred outcome: server-to-app-backend materialization that keeps raw keys out of model/transcript/terminal input-output ledgers. Audit existing setup channels for this property. If none exists, specify the smallest capability-gated daemon operation for writing an approved secret to an owner-approved server environment destination, with no echo, idempotent operation receipt, and interrupted-transfer recovery. An owner-only one-time reveal/manual install may be an explicit old-daemon fallback, but cannot substitute for demonstrating the supported generated-app setup path. Do not route raw keys or redeemable bearer handoff tokens through ordinary persisted tool results. Record whether a daemon release is now needed and update phase 7/rollout accordingly.

## Contract examples to turn into fixtures

Successful ingest returns `batch_id`, explicit `acked_event_ids`, `accepted_count`, `duplicate_count`, `rejected_count`, `rejected` and optional `retry_after_s`. Rejections identify the submitted event/line and a stable code, without echoing sensitive payloads. A valid unknown event type can be stored and ACKed with unsupported-processing status. A duplicate ID with a different payload preserves the original and yields a visible conflict, not replacement or a silent success for changed data.

The [fixture catalog](fixture-catalog.md) identifies shared hash-pinned envelope/ACK bytes and separate behavioral fixtures. Extend shared/copied verification across repos for: valid old events; contacts baseline split across batches; reverse-arrival generations; access change; duplicate scan; same-ID payload conflict; wrong ACK batch/foreign ID; expired authentication; interrupted handoff. Do not make parser snapshots the only validation: assert durable rows and resulting actions.

## Acceptance and handoff

- [ ] Fixtures identify exact required/optional wire fields, limits and error semantics for both implementations.
- [ ] Contact publication and bootstrap boundary have a concurrency test design that covers late commits.
- [ ] Credential handoff has a concrete path, failure recovery and mixed-version story; any protocol addition is listed explicitly.
- [ ] Runtime availability/defaults and remaining implementation choices are recorded, with no reopened health/regions/retention scope.

Update ingest/mobile contract docs and relevant protocol/spec files only as implemented contracts land. Validation families: C, I, M, A, K in the [matrix](validation-checklist.md).
