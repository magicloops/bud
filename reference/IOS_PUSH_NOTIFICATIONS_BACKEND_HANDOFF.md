# iOS Push Notifications Backend Handoff

**Status:** Current backend setup handoff  
**Last Updated:** 2026-04-23  
**Audience:** Backend and iOS  
**Related docs:** `reference/push-notifications-mobile-handoff.md`, `design/chat/push-notifications-thread-attention.md`, `plan/push-notifications/implementation-spec.md`

## Summary

iOS push notification support is now wired for the `assistant_completed` tranche. The mobile app registers an APNs endpoint with the backend after auth, uses server-owned notification summary state for badge/unread UI, routes notification taps directly to a target thread, and marks a thread read only after the newest persisted visible message is actually on screen.

The biggest backend-facing change is app identity: production and non-production now use distinct bundle IDs.

- Production app ID / APNs topic: `chat.bud.app`
- Local debug and staging app ID / APNs topic: `chat.bud.app.staging`

Backend should use the `app_id` from endpoint registration as the APNs `apns-topic`, and should use `provider_environment` from registration to choose the APNs host.

## Current Mobile Environment Matrix

| Build / scheme | Backend target | Bundle ID / `app_id` | URL scheme | OAuth callback | `aps-environment` | Registered `provider_environment` | APNs host |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Bud` / `Debug` | local defaults | `chat.bud.app.staging` | `chat.bud.app.staging` | `chat.bud.app.staging://oauth/callback` | `development` | `sandbox` | `api.sandbox.push.apple.com` |
| `Bud Staging` / `Staging` | `https://staging.bud.dev` | `chat.bud.app.staging` | `chat.bud.app.staging` | `chat.bud.app.staging://oauth/callback` | `production` | `production` | `api.push.apple.com` |
| `Bud` / `Release` | `https://bud.dev` | `chat.bud.app` | `chat.bud.app` | `chat.bud.app://oauth/callback` | `production` | `production` | `api.push.apple.com` |

Notes:

- `app_id` in the registration request is the bundle identifier and should be treated as the APNs topic.
- `aps-environment` is the signed iOS entitlement. `provider_environment` is the value iOS sends to backend so backend can route to the correct APNs host.
- Staging is intended to behave like a production APNs build for `chat.bud.app.staging`. For real-device staging push testing, use a build signed/distributed with a production APNs entitlement/profile, such as TestFlight, Ad Hoc, or another distribution profile. Direct Xcode debug installs should use the Debug/local sandbox path.
- Older handoff docs that mention staging using `chat.bud.app://oauth/callback` are superseded by this split-app-ID setup.

## Apple Developer And APNs Setup

Required Apple App IDs:

- `chat.bud.app`: production app ID, Push Notifications capability required before production validation.
- `chat.bud.app.staging`: staging/debug app ID, Push Notifications capability confirmed enabled.

Recommended APNs auth model:

- Use token-based APNs provider authentication with a `.p8` key.
- No per-bundle APNs certificates are required when using token-based APNs auth.
- APNs certificates are only needed if the backend intentionally uses certificate-based APNs auth. In that case, certificates are per App ID/environment and must cover both `chat.bud.app` and `chat.bud.app.staging`.

Backend secrets/config expected for token-based APNs auth:

- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY` or equivalent secure secret reference for the `.p8` private key

Backend topic/environment rules:

- Allowlist topics: `chat.bud.app`, `chat.bud.app.staging`.
- For each registered endpoint, send `apns-topic: <app_id>`.
- For `provider_environment = "sandbox"`, send through `api.sandbox.push.apple.com`.
- For `provider_environment = "production"`, send through `api.push.apple.com`.
- Store APNs tokens with their `app_id` and `provider_environment`; do not reuse a token across topic or APNs environment boundaries.

## OAuth And Claim Callback Allowlist

Backend OAuth clients and hosted callback allowlists should include the current app-specific URI schemes.

OAuth redirect URIs:

- Local/debug and staging: `chat.bud.app.staging://oauth/callback`
- Production: `chat.bud.app://oauth/callback`

Hosted claim callback URIs, if claim flow allowlisting is enforced:

- Local/debug and staging success: `chat.bud.app.staging://claim/success`
- Local/debug and staging error: `chat.bud.app.staging://claim/error`
- Production success: `chat.bud.app://claim/success`
- Production error: `chat.bud.app://claim/error`

## Mobile Push Registration Contract

Mobile registers the current authenticated install with:

`PUT /api/me/push/endpoints/:installation_id`

Current iOS request shape:

```json
{
  "platform": "ios",
  "provider": "apns",
  "provider_environment": "sandbox",
  "app_id": "chat.bud.app.staging",
  "token": "<apns-device-token-hex>",
  "enabled": true,
  "alerts_agent_completed": true,
  "alerts_human_input_requested": false,
  "include_message_preview": true
}
```

Expected response:

```json
{
  "installation_id": "<installation-id>",
  "status": "registered"
}
```

Mobile unregisters with:

`DELETE /api/me/push/endpoints/:installation_id`

Expected response:

```json
{
  "installation_id": "<installation-id>",
  "status": "deleted"
}
```

Registration behavior expected from backend:

- Treat registration as an idempotent upsert for the authenticated user and `installation_id`.
- The same `installation_id` can re-register after APNs token refresh, app launch, or login/account change.
- If the same `installation_id` registers under a different authenticated user, backend must prevent the previous user from continuing to receive notifications on that endpoint. Reassigning the endpoint or disabling the prior owner association are both acceptable as long as ownership is safe.
- `include_message_preview` is sent explicitly as `true` until iOS adds a privacy toggle.
- `alerts_human_input_requested` is currently sent as `false` because that durable backend artifact is not implemented end-to-end yet.

## Installation ID Lifecycle

iOS now uses an app-container-backed install identity for push registration. This matches the backend team's requested semantics:

- stable for one app install
- replaced on reinstall
- not derived from the APNs token
- not tied to one authenticated account

This is intentionally not stored in Keychain, because Keychain data can survive uninstall/reinstall and would violate the "new on reinstall" expectation.

## Notification Send Contract

Current supported notification kind:

- `assistant_completed`

Current APNs payload fields expected by iOS:

```json
{
  "aps": {
    "alert": {
      "title": "Thread title or Bud label",
      "body": "Preview text or generic fallback"
    },
    "sound": "default",
    "badge": 1
  },
  "kind": "assistant_completed",
  "thread_id": "thread-uuid",
  "message_id": "message-uuid",
  "client_id": "message-client-id",
  "bud_id": "bud-id-or-null",
  "sent_at": "2026-04-21T20:15:04.000Z"
}
```

Current APNs headers:

- `apns-push-type: alert`
- `apns-topic: <app_id>`
- `apns-collapse-id: thread:<thread_id>`

Backend currently does not send `aps.thread-id`. That is fine for V1. If we want Notification Center grouping later, backend can add `aps.thread-id = <thread_id>` without changing the tap-routing contract.

`message_id` semantics:

- For `assistant_completed`, `message_id` is the persisted assistant message row that triggered the notification.
- Mobile treats the payload message as a durable trigger row, but it does not blindly mark that exact message as read.
- When the thread opens, mobile advances the read watermark with the newest persisted message actually visible in the transcript, which may be newer than the pushed `message_id`.

Tap routing behavior:

- Archived threads can open normally.
- Deleted or inaccessible threads should return ordinary ownership-aware missing-resource behavior, usually `404`.
- On missing/inaccessible thread, iOS falls back to the thread list and refreshes notification summary plus thread list state.
- There is no requirement for a dedicated notifications view in V1; thread list attention state is the inbox.

## Badge, Thread List, And Read State

Mobile treats backend state as authoritative.

Badge summary:

`GET /api/me/notifications/summary`

Expected response:

```json
{
  "unseen_thread_count": 3,
  "updated_at": "2026-04-21T20:15:04.000Z"
}
```

Thread list additive fields:

```json
{
  "has_unseen_attention": true,
  "last_attention_kind": "assistant_completed"
}
```

Read watermark:

`POST /api/threads/:thread_id/read`

Request:

```json
{
  "last_seen_message_id": "message-uuid"
}
```

Expected response:

```json
{
  "ok": true,
  "updated": true,
  "last_seen_message_id": "message-uuid"
}
```

Backend read behavior expected by iOS:

- Move the per-thread watermark forward only.
- Keep the route authenticated and ownership-aware.
- Derive badge/unseen state from durable read state, not from push delivery success.

## Future `human_input_requested` Gate

iOS has kept `alerts_human_input_requested` disabled for now. Backend should not emit `human_input_requested` notifications until there is a durable, canonical, transcript-visible artifact.

Recommended future shape:

- one canonical persisted message row in the thread history
- stable `message_id`
- metadata such as `attention_kind = "human_input_requested"`
- a stable `question_id`
- `prompt_text` or equivalent display copy
- resolution state such as `pending`, `answered`, or `dismissed`

Once that exists, backend can reuse the same endpoint registration, outbox, badge summary, thread attention fields, notification tap routing, and read-watermark flow.

## Backend Validation Checklist

APNs setup:

- Confirm token-based APNs credentials are installed in staging and production backend environments.
- Confirm backend allowlists both APNs topics: `chat.bud.app` and `chat.bud.app.staging`.
- Confirm staging sends `chat.bud.app.staging` endpoints with `provider_environment = "production"` to `api.push.apple.com`.
- Confirm debug/local sends `chat.bud.app.staging` endpoints with `provider_environment = "sandbox"` to `api.sandbox.push.apple.com`.
- Confirm production sends `chat.bud.app` endpoints with `provider_environment = "production"` to `api.push.apple.com`.

Registration and ownership:

- Confirm registration is idempotent on repeated app launches.
- Confirm APNs token refresh updates the existing install endpoint.
- Confirm account switch does not leave the previous user attached to the same install endpoint.
- Confirm delete/unregister is idempotent and ownership-aware.

Notification correctness:

- Confirm `assistant_completed` enqueue happens only after the triggering assistant message is persisted.
- Confirm `message_id` in the payload matches that persisted assistant row.
- Confirm `apns-collapse-id` remains `thread:<thread_id>`.
- Confirm backend suppresses stale sends when the thread is already seen before delivery.

Error handling:

- Treat APNs `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`, `BadTopic`, and environment/topic mismatch errors as endpoint/configuration problems, not transient retry-only failures.
- Log app ID, provider environment, APNs topic, and APNs error reason together for failed deliveries.
- Do not blindly retry tokens that APNs has declared invalid or mismatched.

End-to-end device checks:

- Debug/local direct device build can register a sandbox endpoint for `chat.bud.app.staging`.
- Staging distributed build can register a production endpoint for `chat.bud.app.staging`.
- Production build can register a production endpoint for `chat.bud.app`.
- A final assistant message sends a push, tapping the push opens the target thread, and opening the thread advances the read watermark.
- After read advancement, `GET /api/me/notifications/summary` returns the updated `unseen_thread_count`, and the app badge/thread list match it.

