# Debug: location processor upgrade recovery

## Environment and observation

Local development, PostgreSQL, main-service personal-data worker. Before location projection support, `ContactProcessor.processNext` marked visit/significant-change v1 jobs `unsupported`. Adding support only for pending jobs leaves those already ACKed raw observations unavailable to queries.

## Reproduction

Persist a v1 location observation, mark its job unsupported (the previous worker outcome), then run the new processor. The pending-only selector skips it indefinitely.

## Proposed fix

Requeue supported v1 location jobs in bounded owner-locked transactions during worker passes. Never requeue invalid/failed/processed jobs or unsupported health/newer schema versions. Existing immutable raw events and unique projection source IDs make recovery idempotent. Validate two recovery calls, processing, and owner isolation against synthetic PostgreSQL fixtures; update the personal-data spec.
