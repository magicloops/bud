# Phase 6: APNs Smoke Test And Observability

## Goal

Validate that the implemented push pipeline works end-to-end in a real iOS/APNs development environment and add enough visibility to operate it without guessing.

## Scope

This phase focuses on:

- real-device APNs smoke validation
- backend-side inspection of enqueue, suppression, send, retry, and dead-letter behavior
- lightweight operational/debug surfaces for the new outbox worker

This phase does not change the core unread/badge model.

## Implementation Tasks

### Task 1: Define the smoke-test path

Run a real end-to-end development-path test with:

1. APNs credentials configured in the service
2. a real iOS device or simulator-backed development flow where applicable
3. a registered push endpoint via `PUT /api/me/push/endpoints/:installation_id`
4. a thread that receives a final assistant message

Required validations:

- the final assistant message persists
- `thread.last_attention_*` updates
- one outbox row is created
- the worker claims and processes the row
- the device receives the notification
- `GET /api/me/notifications/summary` reflects the unread thread before read acknowledgment
- `POST /api/threads/:thread_id/read` drops the badge count after the thread is actually seen

### Task 2: Add outbox-focused inspection helpers

Add a minimal service-owned inspection path for local/staging debugging.

Recommended options:

- a small script under `service/src/scripts/`
- a narrow internal/debug route if the team prefers HTTP inspection

Minimum useful visibility:

- pending row count
- sending row count
- sent row count
- suppressed row count grouped by `suppressed_reason`
- dead row count grouped by `last_error_code`
- invalidated endpoint count

### Task 3: Improve worker logs

Current worker behavior exists, but the logs should make it easy to answer:

- was a notification enqueued?
- was it suppressed as already seen?
- did APNs reject the token permanently?
- did the worker retry because of transient transport/provider failure?

Recommended structured fields:

- `notification_id`
- `user_id`
- `thread_id`
- `message_id`
- `kind`
- `status`
- `attempt_count`
- `suppressed_reason`
- `last_error_code`
- `endpoint_id`
- `provider`

### Task 4: Document the operational playbook

Add a short operator-facing note describing:

- required APNs env vars
- how to confirm endpoint registration
- how to confirm outbox enqueue
- how to distinguish `already_seen` suppression from delivery failure
- how to identify dead/invalidated endpoints

This can live in:

- a push plan doc in this folder
- or a targeted debug note if the team wants to keep it lightweight

### Task 5: Confirm badge correctness under real delivery

Specifically validate the distinction between delivery and unread truth:

- a notification may be suppressed or fail delivery while `unseen_thread_count` is still correct
- marking a thread read should clear badge state even if the original notification already arrived
- multiple unseen assistant messages on one thread should still count as one unseen thread

### Task 6: Identify follow-up hardening gaps

Use the smoke test to explicitly record any remaining issues such as:

- missing metrics/counters
- weak retry visibility
- awkward env configuration
- worker lifecycle concerns in multi-instance deploys
- missing tooling for invalidated endpoint cleanup

Those findings should feed the next implementation tranche rather than being left implicit.

## Tests / Validation Inputs

Add or run:

- focused unit coverage for any new debug/inspection helper
- a documented manual smoke checklist using a real APNs development path
- full `service` build and test verification after any visibility changes

## Docs / Specs

Update:

- `plan/push-notifications/push-notifications.spec.md`
- `plan/push-notifications/implementation-spec.md`
- `service/src/notifications/notifications.spec.md` if worker observability changes materially
- any new script/spec doc added for inspection tooling

## Exit Criteria

- the team has completed one successful real-device APNs smoke test
- the worker’s path from enqueue to send/suppress/retry/dead is inspectable without code spelunking
- badge correctness is demonstrated independently from provider delivery success
- operational next steps are documented clearly enough for the mobile/backend teams to coordinate the rollout
