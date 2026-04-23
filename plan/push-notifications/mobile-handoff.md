# Mobile Handoff: Push Notifications

## Status

Backend support for V1 push notifications is now in place in the Bud service repo.

Implemented server behavior:

- owned push endpoint registration under `/api/me/*`
- server-owned unread/badge semantics based on per-thread read state
- thread list unread indicators
- durable outbox enqueue on final assistant completion
- APNs delivery worker for iOS
- staging/production APNs topic allowlisting for `chat.bud.app.staging` and `chat.bud.app`
- account-switch hardening for reused push provider tokens or install IDs

Not yet implemented:

- `human_input_requested` enqueueing for `askUserQuestion`-style prompts
- FCM delivery for Android

## Badge Semantics

The badge count is:

- `unseen threads with attention-worthy output`

In V1, attention-worthy output means:

- the final persisted assistant message for a thread

The count is derived on the server from:

- `thread.last_attention_*`
- `thread_read_state`

This means:

- badge correctness does not depend on SSE timing
- push delivery success/failure does not change badge truth
- mobile should treat the server summary as authoritative

## Endpoints

### Register push endpoint

`PUT /api/me/push/endpoints/:installation_id`

Request body:

```json
{
  "platform": "ios",
  "provider": "apns",
  "provider_environment": "sandbox",
  "app_id": "chat.bud.app.staging",
  "token": "<apns-device-token>",
  "enabled": true,
  "alerts_agent_completed": true,
  "alerts_human_input_requested": true,
  "include_message_preview": true
}
```

Response:

```json
{
  "installation_id": "ios-installation-id",
  "status": "registered"
}
```

Notes:

- `installation_id` should be stable for one app install
- re-register on token refresh, app reinstall, or login change
- accepted APNs `app_id` values are `chat.bud.app.staging` and `chat.bud.app`
- unknown APNs app IDs return `400 invalid_app_id` with `allowed_app_ids`
- use `provider_environment: "sandbox"` for local/dev APNs sandbox builds and `production` for App Store/TestFlight-style production APNs
- staging distributed builds should register `app_id: "chat.bud.app.staging"` with `provider_environment: "production"`
- if the same APNs token or reused install ID is registered by another authenticated account, backend registration removes stale prior endpoint ownership before storing the new endpoint

### Delete push endpoint

`DELETE /api/me/push/endpoints/:installation_id`

Response:

```json
{
  "installation_id": "ios-installation-id",
  "status": "deleted"
}
```

### Fetch badge summary

`GET /api/me/notifications/summary`

Response:

```json
{
  "unseen_thread_count": 3,
  "updated_at": "2026-04-21T20:15:04.000Z"
}
```

Use this endpoint as the authoritative app-icon badge source.

### Mark a thread seen

`POST /api/threads/:threadId/read`

Request body:

```json
{
  "last_seen_message_id": "22222222-2222-4222-8222-222222222222"
}
```

Response when advanced:

```json
{
  "ok": true,
  "updated": true,
  "last_seen_message_id": "22222222-2222-4222-8222-222222222222"
}
```

Response when the watermark was already newer:

```json
{
  "ok": true,
  "updated": false,
  "last_seen_message_id": "44444444-4444-4444-8444-444444444444"
}
```

Rules:

- mobile should send the latest owned persisted message the user has actually seen
- the server only moves the watermark forward
- this route is per-thread, not global

### Thread list unread fields

`GET /api/threads`

Relevant additive fields on each thread:

```json
{
  "has_unseen_attention": true,
  "last_attention_kind": "assistant_completed"
}
```

Use these for:

- thread-row badges/dots
- filtering/sorting in the mobile UI

## Suggested Mobile Flow

### App launch / foreground

1. Authenticate as usual.
2. Register or refresh the APNs endpoint if needed.
3. Fetch `GET /api/me/notifications/summary`.
4. Set the application badge number from `unseen_thread_count`.
5. Fetch `GET /api/threads` and render `has_unseen_attention`.

### Entering a thread

1. Fetch thread messages and agent state as usual.
2. Identify the newest persisted message the user has actually seen.
3. Call `POST /api/threads/:threadId/read` with that `last_seen_message_id`.
4. Refresh or locally decrement badge state using the next `GET /api/me/notifications/summary`.

### Push received while app is backgrounded

1. Route the user into the target thread if they tap the notification.
2. Once the thread transcript is visible, call the read route with the newest seen persisted message.
3. Refresh the badge summary.

## Notification Payload Expectations

Current durable payload fields in the outbox/APNs path include:

- `kind`
- `thread_id`
- `message_id`
- `client_id`
- `bud_id`
- `sent_at`

Current V1 kind:

- `assistant_completed`

Mobile should treat unknown future `kind` values as forward-compatible.

Current APNs request body shape is:

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

Current APNs headers include:

- `apns-push-type: alert`
- `apns-topic: <registered app_id>`
- `apns-collapse-id: thread:<thread_id>`

Current backend behavior does **not** set `aps.thread-id`.

## Backend Clarifications

### `message_id` semantics

For the current shipped `assistant_completed` notification kind:

- `message_id` always points at the persisted assistant `message` row that triggered the notification
- that is also the same durable row used for `thread.last_attention_*`

This means:

- the payload `message_id` is safe to treat as the persisted triggering message
- if the user opens the thread later and newer persisted messages are already visible, mobile should still advance `POST /api/threads/:threadId/read` using the newest actually seen persisted message, not blindly the original push payload `message_id`

### Collapse and iOS grouping

Current backend behavior:

- yes, notifications already use an APNs collapse identifier keyed by Bud thread via `apns-collapse-id: thread:<thread_id>`
- no, the backend does not currently send `aps.thread-id`

If the iOS team wants OS-level grouping in Notification Center, adding `aps.thread-id = <thread_id>` is a reasonable backend follow-up. Mobile should not assume it exists today.

### Future `human_input_requested` durable shape

This is not implemented yet.

What is fixed by the current backend plan:

- `human_input_requested` must not notify from an ephemeral tool call alone
- it must exist as a durable transcript-visible artifact with a stable identity
- it should reuse the same unread, attention-summary, and outbox pipeline

Current recommended backend shape once implemented:

- one canonical persisted `message` row in the thread history
- a stable `message_id`
- metadata such as:
  - `attention_kind = "human_input_requested"`
  - `question_id`
  - `prompt_text`
  - a resolution field such as `pending`, `answered`, or `dismissed`

The exact canonical row shape is still a backend follow-up, but `human_input_requested` should only be emitted once that durable canonical shape exists.

### Installation ID expectations

Backend expectation:

- one stable `installation_id` per app install
- re-register on token refresh, login change, or app launch as needed
- a reinstall should produce a new installation ID

The backend is comfortable with mobile reusing the existing TimelineCore app installation ID as the push `installation_id` **if** it has these properties:

- stable for the lifetime of one install
- replaced on reinstall
- not derived from the APNs token
- not tied to a specific signed-in account

That shape is a good fit for the current `(user_id, installation_id)` ownership model.

Backend account-switch behavior:

- registration treats the APNs provider token as globally unique
- when a token or reused installation ID appears under a different authenticated user, stale prior endpoint rows are removed before the new registration is stored
- after a login change, mobile should re-register the endpoint so future notifications target the current account only

### Tap behavior for deleted, archived, or inaccessible threads

Current backend expectation:

- archived threads are still normal owned threads unless the client intentionally hides them, so a tap can open them normally
- deleted or inaccessible threads will resolve as missing owned resources, typically `404`

Recommended mobile behavior:

1. attempt to open the target thread
2. if the thread is missing or inaccessible, fall back to the thread list/inbox
3. refresh `GET /api/me/notifications/summary`
4. refresh `GET /api/threads`
5. show a lightweight “thread unavailable” message if needed

There is no special backend redirect behavior today beyond normal ownership-aware `404` responses.

### `include_message_preview` default

Current backend default is:

- `include_message_preview = true` when omitted during registration

Until mobile adds a privacy toggle, the intended default is therefore preview-on. Mobile can send `true` explicitly for now to make that choice unambiguous.

## Product Notes

- `include_message_preview` is server-stored per endpoint, so the mobile app can expose a notification-preview privacy preference later without another schema change.
- Delivery is provider-specific, but product semantics are not. The mobile app should think in terms of `kind`, thread targeting, and unread state, not APNs-only concepts.
- The server suppresses stale notifications if the thread is already seen before delivery.

## Known Gaps

- `askUserQuestion` / `human_input_requested` does not exist end-to-end yet.
- Android/FCM is not implemented yet.
- There is no special foreground-presence suppression in V1 beyond the existing unread-state suppression rules.

## Recommended Mobile Follow-Up Work

1. Wire APNs token registration to login, app launch, and token-refresh events.
2. Adopt `GET /api/me/notifications/summary` as the badge source of truth.
3. Mark threads read after the latest persisted visible message becomes user-visible.
4. Render `has_unseen_attention` in the thread list.
5. Preserve unknown notification `kind` values for forward compatibility with `human_input_requested`.
