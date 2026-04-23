# Phase 3: APNs Delivery Worker

## Goal

Deliver pending notification candidates to iOS devices through APNs without coupling provider behavior to transcript persistence.

## Scope

This phase adds:

- provider abstraction
- APNs implementation
- in-process worker loop
- retry and invalidation rules

This phase does not require Android delivery.

## Implementation Tasks

### Task 1: Add notification worker module

Recommended new area:

- `service/src/notifications/`

Suggested modules:

- `outbox-worker.ts`
- `providers/apns.ts`
- `payload.ts`
- `types.ts`

### Task 2: Define provider seam

Recommended interface:

```text
PushProvider.send(notification, endpoint) -> PushSendResult
```

Result classification should distinguish:

- sent
- temporary failure, retryable
- permanent failure, invalidate endpoint
- suppressed

### Task 3: Add APNs implementation

The APNs provider should map endpoint rows plus outbox payloads into:

- alert title/body
- custom data payload
- thread collapse key

Required behavior:

- support sandbox vs production environments
- classify invalid token responses as permanent endpoint failure
- preserve the outbox row for retryable transport failures

### Task 4: Add claim-and-send loop

Recommended V1 approach:

- a service-owned polling loop
- claim rows where:
  - `status = pending`
  - `next_attempt_at <= now()`
- mark claimed rows `sending`
- fan out to eligible endpoints for `user_id`

Recommended endpoint filter:

- `enabled = true`
- `invalidated_at is null`
- preference flag for the row’s notification kind is enabled

### Task 5: Add suppression behavior

Before provider send, the worker should load:

- current `thread_read_state`
- current `thread.last_attention_*`

Suppress when:

- the row’s message is no longer newer than the user’s read watermark

Recommended suppression reason examples:

- `already_seen`
- `no_enabled_endpoints`

### Task 6: Add retry policy

Recommended behavior:

- transient provider/network failures increment `attempt_count`
- `next_attempt_at` uses bounded exponential backoff
- permanent endpoint failures invalidate the endpoint and do not keep retrying that same send target
- an outbox row can become `dead` after a bounded retry count if no endpoint can eventually accept it

### Task 7: Add basic observability

Recommended logs and counters:

- claimed row count
- sent row count
- suppressed row count
- invalidated endpoint count
- retry count
- dead-letter count

## Tests

Add focused coverage for:

- outbox claim logic
- already-seen suppression
- APNs permanent vs retryable error classification
- endpoint invalidation on invalid token
- per-thread collapse key generation

## Docs / Specs

Update:

- `service/src/src.spec.md`
- `service/service.spec.md`
- `service/src/routes/routes.spec.md` if any read/write routes or summary semantics change
- `docs/proto.md` for new API routes and payload notes

## Exit Criteria

- APNs delivery is asynchronous
- invalid tokens stop retrying
- already-seen rows can be suppressed safely
- transcript persistence does not depend on provider availability
