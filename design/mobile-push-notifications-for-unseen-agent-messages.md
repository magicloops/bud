# Design: Push Notifications For Unseen Agent Messages

Status: Draft

Audience: Backend, mobile, web platform, product

Last updated: 2026-04-21

## 1. Goal

Add push notifications for thread activity that requires the user's attention, without tying correctness to transient SSE behavior or to iOS-specific transport choices.

The first product target is the current iOS app, but the backend design should also fit future Android clients.

The design must support these product moments:

- the agent finishes a turn and persists an output message
- the agent later gains an explicit "request human input" capability
- notifications only fire for output the user has not already seen

This design is intentionally about the service/mobile/web contracts and backend architecture. It does not specify the exact iOS UI treatment, lock-screen copy, or app-side local notification styling.

## 2. Current Architecture Review

### 2.1 What already exists

The current service architecture gives us several good foundations:

- all browser-facing thread/message routes are already user-owned and ownership-checked
- mobile already uses the same authenticated route family through bearer auth
- the durable transcript source of truth is `message`
- the in-flight source of truth is `/api/threads/:thread_id/agent/state`
- live transport is `/api/threads/:thread_id/agent/stream`
- stable `client_id` values already tie draft assistant state, live events, and later persisted rows together

The current agent flow is:

1. `POST /api/threads/:thread_id/messages` inserts the user row.
2. `AgentService.startUserMessage(...)` starts the turn and seeds runtime state.
3. Draft assistant text streams over `agent.message_start` / `agent.message_delta` / `agent.message_done`.
4. Tool results persist through `AgentTranscriptWriter.recordToolResult(...)`.
5. Final assistant output persists through `AgentTranscriptWriter.recordFinalAssistant(...)`.
6. `/agent/state` returns to idle only after the final durable boundary is observable.

That means the architecture already distinguishes:

- durable transcript state
- in-flight runtime state
- live stream transport

That distinction is exactly what push notifications need.

### 2.2 What does not exist yet

The current backend does not yet have:

- mobile push endpoint registration
- a per-user thread read or seen model
- an outbox or worker for asynchronous notification delivery
- a generic push-provider abstraction
- a future-proof durable representation for "human input requested"

The current system also has no server-owned way to answer:

- "Has this user already seen the newest agent output on this thread?"
- "Which devices should receive this alert?"
- "How do we retry or suppress push delivery without coupling it to the chat request path?"

### 2.3 Important constraint from current stream semantics

Push must not trigger from draft assistant SSE events.

Reasons:

- draft events are ephemeral and process-local
- no-cursor agent stream attach is live-only by design
- reconnect correctness already comes from `/messages` plus `/agent/state`
- mobile backgrounding or reconnect can reorder when the client sees live transport

So the notification trigger must sit on a durable attention boundary, not on draft deltas.

## 3. Requirements

### 3.1 Functional requirements

- notify when a thread receives new attention-worthy agent output
- suppress notifications for output already seen by the owning user
- support multiple devices per user
- support iOS now and Android later
- support retries, invalid-token cleanup, and future provider changes
- keep the canonical transcript and the notification pipeline reconcilable by stable ids

### 3.2 Non-goals

- redesigning the thread SSE contract
- replacing SSE with push for normal in-app updates
- implementing the human-input-request tool itself
- designing collaborative multi-user fan-out beyond the current single-owner thread model
- solving exact foreground-presence suppression across every client surface in V1

## 4. Design Principles

- durable state is the source of notification truth
- notifications are derived from user-visible thread artifacts, not from transient runtime effects
- unseen must be server-owned, not inferred from "probably open" client state
- provider transport must be abstracted from product platform
- enqueue and delivery must be decoupled
- thread ownership rules must continue to gate every push-targeted resource

Short version:

- transcript is truth
- read state defines unseen
- push is derived delivery
- SSE remains the primary live in-app transport

## 5. Recommendation

### 5.1 Notify from durable attention boundaries

A push notification candidate should be created only when the service commits a durable, user-visible thread artifact that requires attention.

Recommended V1 trigger:

- final persisted assistant message from `AgentTranscriptWriter.recordFinalAssistant(...)`

Recommended future trigger:

- a future durable "human input requested" artifact, preferably a canonical transcript row with metadata that clearly marks it as an attention request

Explicitly out of scope as triggers:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.tool_call`
- `agent.tool_result`
- raw terminal output

Rationale:

- those are transport or internal-progress signals, not stable user-attention boundaries
- the final assistant message already corresponds to "agent finished and sent output"
- a future human-input request should also become a durable, user-visible thread artifact if we want stable notification and recovery semantics

### 5.2 Define unseen with per-user thread read state

Introduce a per-user, per-thread durable read-state record.

Recommended table:

- `thread_read_state`

Recommended shape:

```text
thread_read_state
- thread_id uuid not null
- user_id text not null
- last_seen_message_id uuid null
- last_seen_message_created_at timestamptz null
- last_seen_at timestamptz not null
- created_at timestamptz not null
- updated_at timestamptz not null
PK (thread_id, user_id)
```

Recommended semantics:

- the client advances read state only after it has actually shown the relevant transcript state to the user
- the server stores both `last_seen_message_id` and `last_seen_message_created_at` so tuple ordering matches transcript pagination rules
- notification suppression compares the candidate message against this durable watermark

This keeps "unseen" tied to transcript history instead of to stream timing.

### 5.3 Register push endpoints as user-owned resources

Introduce a generic push-endpoint table rather than an iOS-specific device-token table.

Recommended table:

- `push_endpoint`

Recommended shape:

```text
push_endpoint
- endpoint_id uuid primary key
- user_id text not null
- installation_id text not null
- platform text not null          // ios | android
- provider text not null          // apns | fcm
- provider_environment text null  // sandbox | production | development
- app_id text not null            // bundle id or package name
- token text not null
- enabled boolean not null
- alerts_agent_completed boolean not null
- alerts_human_input_requested boolean not null
- include_message_preview boolean not null
- invalidated_at timestamptz null
- last_registered_at timestamptz not null
- last_seen_at timestamptz not null
- last_error_at timestamptz null
- last_error_code text null
- last_error_message text null
- created_at timestamptz not null
- updated_at timestamptz not null
unique (user_id, installation_id)
```

Notes:

- `user_id` is the ownership anchor for this table
- `platform` is the product platform
- `provider` is the transport implementation
- that split lets us start with APNs for iOS and later add FCM for Android without changing the ownership model
- if we later decide to use FCM for both iOS and Android, the provider layer can change without redesigning client ownership or read state

### 5.4 Add a DB-backed notification outbox

Notification enqueue should not happen as an inline provider call during chat persistence.

Recommended table:

- `push_notification_outbox`

Recommended shape:

```text
push_notification_outbox
- notification_id text primary key      // ULID preferred
- user_id text not null
- thread_id uuid not null
- message_id uuid null
- kind text not null                    // assistant_completed | human_input_requested
- status text not null                  // pending | sending | sent | suppressed | failed | dead
- dedupe_key text not null
- collapse_key text not null
- title text not null
- body text not null
- payload jsonb not null
- attempt_count integer not null
- next_attempt_at timestamptz not null
- claimed_at timestamptz null
- sent_at timestamptz null
- suppressed_reason text null
- last_error_code text null
- last_error_message text null
- created_at timestamptz not null
- updated_at timestamptz not null
unique (dedupe_key)
```

Recommended enqueue point:

- the same durable write path that commits the assistant message or future human-input request

Recommended rule:

- message persistence and outbox insert should happen in one transaction once implementation begins

Why:

- if we persist the assistant row but fail to enqueue, we silently lose alerts
- if we enqueue before durability, we can notify about state the transcript never committed

### 5.5 Deliver outbox rows asynchronously

Introduce a small delivery worker in the service layer.

Recommended V1 shape:

- in-process polling loop that claims pending outbox rows
- claim rows with a concurrency-safe pattern such as `FOR UPDATE SKIP LOCKED` or an equivalent claim update
- resolve eligible endpoints for the row's `user_id`
- suppress, send, retry, or invalidate endpoints based on provider response

Recommended future shape:

- keep the outbox schema and move the worker into a dedicated process when needed

This lets V1 ship without new infrastructure while preserving a clear migration path for multi-instance or higher-volume delivery later.

### 5.6 Keep provider transport behind an abstraction

Recommended internal seam:

```text
PushProvider
- send(notification, endpoint) -> PushSendResult
```

Recommended V1 providers:

- `ApnsPushProvider`

Recommended future providers:

- `FcmPushProvider`

The worker should route per endpoint:

- `provider = apns` -> APNs provider
- `provider = fcm` -> FCM provider

This keeps product state independent from transport credentials.

### 5.7 Treat read state as correctness, presence as optimization

The core unseen decision should come from `thread_read_state`, not from ephemeral foreground presence.

Recommended V1 rule:

- if the notification candidate message is newer than `thread_read_state`, it is unseen

Optional V2 optimization:

- add ephemeral viewer presence to suppress sends when the same user is actively viewing the thread in foreground

Why presence is not the recommended V1 correctness layer:

- current service runtime state is already intentionally process-local
- web and mobile presence are harder to normalize than transcript state
- read state already gives a portable cross-device answer for unseen

Important tradeoff:

- V1 may still produce occasional false-positive push attempts if a client has rendered new output but has not yet advanced read state
- that is acceptable as an initial tradeoff if the client updates read state promptly

## 6. Proposed API Surface

### 6.1 Push endpoint registration

Recommended routes:

- `PUT /api/me/push/endpoints/:installation_id`
- `DELETE /api/me/push/endpoints/:installation_id`

Example registration request:

```json
{
  "platform": "ios",
  "provider": "apns",
  "provider_environment": "production",
  "app_id": "app.bud.ios",
  "token": "<provider token>",
  "enabled": true,
  "alerts_agent_completed": true,
  "alerts_human_input_requested": true,
  "include_message_preview": true
}
```

Notes:

- route lives under `/api/me/*` because the token belongs to the authenticated user
- cookie and bearer auth should both work through the existing viewer model
- `PUT` should be idempotent by `(user_id, installation_id)`

### 6.2 Thread read-state acknowledgment

Recommended route:

- `POST /api/threads/:thread_id/read`

Example request:

```json
{
  "last_seen_message_id": "uuid"
}
```

Recommended semantics:

- validate the message belongs to the owned thread and is visible to the viewer
- look up its `created_at`
- advance the stored watermark only if the submitted message is newer than the current stored watermark
- never allow the client to move the watermark backward

Recommended client behavior:

- mark read when the thread is foreground and the newest visible message is actually on screen
- mark read again as new assistant output arrives while the user is bottom-following
- do not auto-mark read while the user is browsing older history above the latest window

### 6.3 Optional later read-state surfaces

Likely follow-up routes or fields:

- unread summary fields on `GET /api/threads`
- total unread count for badge calculations

These are not required for V1 delivery, but the schema above leaves room for them.

## 7. Notification Payload Design

Recommended canonical push kinds:

- `assistant_completed`
- `human_input_requested`

Recommended push data payload:

```json
{
  "kind": "assistant_completed",
  "thread_id": "uuid",
  "message_id": "uuid",
  "client_id": "uuidv7",
  "bud_id": "bud_123",
  "sent_at": "2026-04-21T20:15:04.000Z"
}
```

Recommended alert content:

- title: thread title when present, otherwise Bud display name or a generic Bud label
- body for assistant completion:
  - preview of the persisted assistant message, truncated server-side
- body for human-input request:
  - generic explicit copy such as "Bud needs your input"

Recommended collapse behavior:

- use a per-thread collapse key such as `thread:<thread_id>`

That keeps rapid consecutive unseen updates from producing a long OS-level stack while still allowing the newest state to win.

## 8. End-To-End Flow

### 8.1 Assistant completion

1. User sends a message.
2. Agent runs normally over SSE.
3. `recordFinalAssistant(...)` persists the canonical assistant message.
4. In the same transaction, the service inserts an outbox row of kind `assistant_completed`.
5. The delivery worker claims the row.
6. The worker loads:
   - owned push endpoints for the user
   - current `thread_read_state` for `(thread_id, user_id)`
7. If the message is already seen, mark the outbox row `suppressed`.
8. Otherwise send to all enabled endpoints for that user.
9. On invalid-token provider errors, mark the endpoint invalid.
10. Mark the outbox row `sent` or schedule retry.

### 8.2 Future human-input request

Recommended future rule:

- the human-input feature should commit a durable, user-visible thread artifact before enqueueing a push

That artifact can be:

- a canonical `message` row with metadata such as `notification_kind = "human_input_requested"`

Once that exists, the same outbox and read-state rules apply.

## 9. Ownership And Authorization

The existing ownership model maps cleanly to this feature.

Rules:

- push endpoints belong to the authenticated user
- read state belongs to `(thread_id, user_id)`
- notification delivery fans out only to endpoints owned by the thread owner in the current single-user-per-thread model
- cross-user access still returns `404`

Implementation guardrails:

- never accept a raw `user_id` from the client for push endpoint registration
- never trust `thread_id` without resolving owned thread access first
- if web later adopts read-state updates, it must use the same owned thread route family

Future collaboration note:

- if Bud later supports shared threads, the delivery fan-out should be based on thread membership rather than `thread.created_by_user_id`
- the `thread_read_state` pivot model already fits that future better than a single read watermark stored directly on `thread`

## 10. iOS Now, Android Later

This design intentionally separates:

- product platform: `ios`, `android`
- transport provider: `apns`, `fcm`

That gives a clean progression:

### V1

- iOS app registers APNs tokens
- backend delivers through APNs

### V2

- Android app registers FCM tokens
- backend delivers through FCM using the same outbox and read-state rules

### Optional later change

- if the product later standardizes on one provider across platforms, only the provider adapter and endpoint registration rules change

The unread model, route family, and outbox model do not need to change.

## 11. Rollout Plan

### Phase 1: Data model and routes

- add `push_endpoint`
- add `thread_read_state`
- add `push_notification_outbox`
- add push-endpoint registration routes
- add thread read-state route

### Phase 2: Enqueue on assistant completion

- wire outbox insert into the durable assistant persistence path
- keep the initial trigger strictly to final assistant messages

### Phase 3: APNs delivery

- add APNs provider adapter
- add worker loop
- add invalid-token cleanup and retry rules

### Phase 4: Client adoption

- mobile app registers endpoints after login
- mobile app unregisters or disables on logout
- mobile app advances read state when a thread is actually seen
- web may optionally adopt the same read route to reduce cross-device false positives

### Phase 5: Future human-input request

- make human-input requests durable and transcript-visible
- enqueue `human_input_requested` notifications from that boundary

## 12. Open Questions

### 12.1 Should failed turns notify?

Current architecture emits `final { status: "failed" }`, but failed turns do not necessarily persist a canonical assistant or system message.

Recommendation:

- do not notify on failure in V1 unless we also create a durable, user-visible thread artifact for that failure

### 12.2 What exactly counts as "seen"?

There are two plausible client rules:

- thread is foreground and at latest message
- thread is foreground even if the user is scrolled up

Recommendation:

- treat "seen" as the newest message actually rendered in the visible latest-reading state, not merely "thread screen exists"

### 12.3 Should previews be shown on the lock screen?

Open product question:

- include assistant text preview in the push body
- or use privacy-preserving generic copy and let the app fetch details on open

The endpoint schema above supports a per-installation `include_message_preview` preference either way.

### 12.4 Should web participation suppress mobile push?

If the user is actively reading the same thread on web, a mobile push may feel redundant.

Recommendation:

- V1 relies on shared read-state adoption when web is ready
- if this becomes noisy before web adopts read acknowledgments, add foreground presence as a later optimization

### 12.5 Badge Semantics

Resolved:

- badge count should equal `unseen threads with attention-worthy output`

Implications:

- multiple unseen assistant messages on one thread still count as one badge unit
- a future `human_input_requested` prompt on an unseen thread also counts as one badge unit for that thread
- the backend should expose server-owned thread unread state and an aggregate unseen-thread summary rather than leaving badge math to clients

## 13. Decision Summary

Push notifications should be derived from durable thread attention boundaries, not from draft SSE.

The recommended architecture is:

- per-user push endpoint registration
- per-user per-thread read state for unseen suppression
- a DB-backed notification outbox
- asynchronous provider delivery through a generic push abstraction
- V1 trigger on final persisted assistant messages
- future trigger on durable human-input requests

That design matches the current Bud separation of transcript truth, runtime state, and stream transport, and it gives us a clean path from iOS/APNs now to Android/FCM later without redesigning the unread or ownership model.
