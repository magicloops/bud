# Phase 7: Staging APNs Topic And Account-Switch Hardening

## Goal

Prepare the backend for staging push-notification testing with the mobile team's split app identity model and close the backend gaps surfaced by `reference/IOS_PUSH_NOTIFICATIONS_BACKEND_HANDOFF.md`.

## Context

The iOS app now uses distinct APNs topics:

- production: `chat.bud.app`
- local/debug and staging: `chat.bud.app.staging`

The current backend implementation already:

- stores `app_id` from `PUT /api/me/push/endpoints/:installation_id`
- sends `apns-topic: <endpoint.app_id>`
- sends `provider_environment = "sandbox"` and `"development"` to `api.sandbox.push.apple.com`
- sends any other provider environment, including `"production"`, to `api.push.apple.com`
- uses `apns-collapse-id: thread:<thread_id>`
- emits the expected V1 `assistant_completed` payload fields

The remaining staging-readiness work is mostly configuration, validation, and hardening around ownership/account switching and APNs topic/environment failures.

## Scope

This phase covers:

- explicit APNs topic allowlisting for `chat.bud.app` and `chat.bud.app.staging`
- staging APNs environment configuration validation
- APNs error classification for topic/environment mismatch cases
- same-install account-switch ownership safety
- staging smoke validation against `chat.bud.app.staging`
- documentation updates tying the mobile reference handoff to the backend plan

This phase does not implement:

- Android/FCM
- `human_input_requested`
- `aps.thread-id` unless the team chooses to add iOS Notification Center grouping now

## Implementation Tasks

### Task 1: Add APNs topic allowlist config

Add backend configuration for allowed APNs topics.

Recommended env:

```text
APNS_ALLOWED_TOPICS=chat.bud.app,chat.bud.app.staging
```

Route behavior:

- `PUT /api/me/push/endpoints/:installation_id` should reject unknown APNs `app_id` values.
- Rejection should be a client-visible `400 invalid_app_id` or similarly specific error.
- The allowlist should apply only to `provider = "apns"`.

Why:

- prevents arbitrary APNs topics from being stored
- makes staging and production topic support explicit
- catches mobile configuration mistakes before the worker attempts provider delivery

### Task 2: Confirm staging APNs host/topic matrix

Validate that registration and delivery behave as:

| Target | `app_id` | `provider_environment` | APNs host |
| --- | --- | --- | --- |
| local/debug | `chat.bud.app.staging` | `sandbox` | `api.sandbox.push.apple.com` |
| staging distributed build | `chat.bud.app.staging` | `production` | `api.push.apple.com` |
| production | `chat.bud.app` | `production` | `api.push.apple.com` |

Current implementation already has the host routing behavior. This task is about locking it down in staging validation and tests.

### Task 3: Harden APNs error classification

Update APNs permanent-failure classification to include topic/environment/configuration mismatch cases called out by the mobile handoff.

Expected permanent endpoint/configuration errors:

- `BadDeviceToken`
- `Unregistered`
- `DeviceTokenNotForTopic`
- `BadTopic`
- other clear topic/environment mismatch responses observed during staging validation

Recommended behavior:

- invalid-token reasons should invalidate the endpoint
- topic/configuration mismatch reasons should not be retried blindly
- logs should include `app_id`, `provider_environment`, APNs topic, APNs host, and APNs reason

Whether `BadTopic` invalidates the endpoint or marks the outbox row dead should be decided during implementation. It should not remain a generic transient retry.

### Task 4: Make account-switch behavior explicit

The mobile handoff expects this safety property:

- if the same `installation_id` registers under a different authenticated user, the previous user must not continue receiving notifications on that endpoint

Recommended backend behavior:

- treat `(provider, token)` as globally unique
- when registering an endpoint for a new user/token pair, disable or invalidate any existing endpoint rows for the same provider/token that belong to another user
- optionally also disable rows with the same `installation_id` for other users when the app reuses a stable install id across account switches

Acceptance criteria:

- account A registers an endpoint
- account B registers the same app install/token
- account A no longer has an enabled deliverable endpoint for that token/install
- account B receives future notifications

### Task 5: Add route-level and provider-level tests

Add focused coverage for:

- APNs topic allowlist accepts `chat.bud.app`
- APNs topic allowlist accepts `chat.bud.app.staging`
- APNs topic allowlist rejects unknown topics
- staging registration can use `app_id = chat.bud.app.staging` with `provider_environment = production`
- APNs classifier handles `BadTopic` and topic/environment mismatch responses as non-retryable
- account-switch registration disables or reassigns the prior owner endpoint safely

### Task 6: Run staging smoke test

Using a staging-distributed iOS build:

1. register endpoint:

```json
{
  "platform": "ios",
  "provider": "apns",
  "provider_environment": "production",
  "app_id": "chat.bud.app.staging",
  "token": "<apns-token>",
  "enabled": true,
  "alerts_agent_completed": true,
  "alerts_human_input_requested": false,
  "include_message_preview": true
}
```

2. create or open a thread
3. trigger a final assistant response
4. confirm outbox enqueue
5. confirm APNs delivery through `api.push.apple.com`
6. tap notification and route to thread
7. mark newest visible persisted message read
8. confirm badge summary drops as expected

### Task 7: Decide whether to add `aps.thread-id`

Current backend behavior is acceptable for V1:

- `apns-collapse-id: thread:<thread_id>` is already sent
- `aps.thread-id` is not sent

If iOS wants Notification Center grouping during staging validation, add:

```json
{
  "aps": {
    "thread-id": "<thread_id>"
  }
}
```

This should not change tap routing or read-state semantics.

## Tests / Validation Inputs

Required before staging sign-off:

- service build passes
- service tests pass
- focused APNs classifier tests cover new permanent reasons
- push endpoint route tests cover topic allowlisting and account-switch safety
- manual staging device smoke test is recorded with app id `chat.bud.app.staging`

## Implementation Notes

Implemented backend behavior:

- `APNS_ALLOWED_TOPICS` controls accepted APNs registration topics and defaults to `chat.bud.app,chat.bud.app.staging`
- `PUT /api/me/push/endpoints/:installation_id` rejects unknown APNs `app_id` values with `400 invalid_app_id`
- push registration removes stale endpoint rows for the same provider token or reused installation id when they belong to another user before upserting the current endpoint
- APNs topic/environment mismatch reasons are permanent failures instead of transient retries
- APNs invalid token reasons still invalidate the endpoint
- push worker logs include the registered app id, provider environment, APNs topic, resolved APNs authority, and provider error reason

## Docs / Specs

Update:

- `plan/push-notifications/mobile-handoff.md`
- `service/src/config.ts` and `service/src/src.spec.md` if new env vars are added
- `service/src/notifications/notifications.spec.md` if APNs classification/logging changes
- `service/src/routes/routes.spec.md` if route validation behavior changes
- `docs/proto.md` if mobile-facing error shapes or APNs payload fields change

## Exit Criteria

- staging backend accepts `chat.bud.app.staging` as an APNs topic
- staging backend rejects unknown APNs topics
- staging production APNs builds route to `api.push.apple.com`
- local debug sandbox builds route to `api.sandbox.push.apple.com`
- account switching cannot leave the previous user with a deliverable endpoint for the same install/token
- topic/environment APNs failures are visible and not retried indefinitely
- the mobile team can complete staging push validation with the current split app ID setup
