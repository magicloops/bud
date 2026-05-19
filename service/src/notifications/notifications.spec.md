# notifications

Push notification support for Bud-owned thread attention events.

## Purpose

This folder owns:

- durable unread/attention helper logic
- APNs delivery
- asynchronous outbox processing
- shared push payload helpers

The current implementation focuses on:

- APNs for the iOS app
- server-owned unread-thread semantics
- outbox-driven asynchronous delivery

Android/FCM support is intentionally deferred, but the provider seam is already structured to allow it.

## Files

### `index.ts`

Barrel exports for notification helpers and the worker.

### `attention.ts`

Pure helpers for:

- comparing message watermarks
- determining whether a thread has unseen attention-worthy output
- counting unread threads for badge purposes

### `attention.test.ts`

Pure tests for unread-thread math and message watermark ordering.

### `payload.ts`

Small helpers for notification title/body generation.

### `apns.ts`

Native Node APNs provider implementation using:

- JWT generation from configured APNs credentials
- HTTP/2 request dispatch
- provider-environment routing where `sandbox` / `development` use `api.sandbox.push.apple.com` and `production` / unset use `api.push.apple.com`
- APNs error classification into sent, retryable, invalid-endpoint, and failed buckets
- non-retryable handling for topic/environment mismatch responses such as `BadTopic`, `MissingTopic`, `TopicDisallowed`, and `BadCertificateEnvironment`

### `apns.test.ts`

Focused tests for APNs failure classification, provider-environment authority routing, and APNs private-key config source resolution.

### `worker.ts`

Asynchronous push outbox worker.

Responsibilities:

- claim pending outbox rows
- suppress rows that are already seen or superseded
- fan out to enabled endpoints
- retry transient failures
- invalidate dead tokens
- log delivery outcomes with endpoint id, registered app id, provider environment, APNs topic, resolved APNs authority, and provider error reason

## Dependencies

- `../db/schema.js` - push endpoint, read state, outbox, and thread attention summary tables
- `../config.js` - APNs and worker polling configuration
- `../db/client.js` - DB access

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- FCM provider support is not implemented yet even though the route and schema shapes are designed to support it later.

<!-- SPEC:TODO -->
- `human_input_requested` is supported by the schema, unread math, and delivery preferences, but the service does not enqueue that kind yet. The `ask_user_questions` tool flow now exists; attention stamping and push enqueue are deferred until the prompt visibility/read-watermark boundary is finalized.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
