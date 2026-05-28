# iOS Send Message Client ID Idempotency Handoff

**Status:** Backend validation request  
**Audience:** Backend, iOS  
**Last Updated:** 2026-05-27

## Summary

iOS now restores failed chat sends back into the composer instead of leaving failed optimistic rows in transcript history. When the user retries the exact restored draft, iOS intentionally reuses the original `client_id`.

We need backend to validate that `POST /api/threads/:thread_id/messages` treats `client_id` as an idempotency key for user message creation and agent-run kickoff.

## Why This Matters

There are failure windows where iOS cannot know whether the backend accepted a send:

1. iOS sends `POST /api/threads/:thread_id/messages` with `client_id = C`.
2. Backend receives the request, persists the user message, and may start agent work.
3. The network drops, the server restarts, a proxy closes, or the client times out before iOS receives the HTTP response.
4. iOS treats the send as failed and restores the draft into the composer.
5. The user taps send again.
6. iOS retries the same logical send with the same `client_id = C`.

This is only safe if the backend recognizes the duplicate and does not create a second user message or start a second agent response.

## Current iOS Behavior

For every new send, iOS creates a `client_id` before calling the backend:

```json
{
  "client_id": "client-generated-id",
  "text": "Message text",
  "model": "optional-model",
  "reasoning_effort": "optional-effort",
  "cwd": "optional-working-directory"
}
```

Current endpoint:

```http
POST /api/threads/:thread_id/messages
```

If the POST succeeds, iOS marks the optimistic user row completed with the returned `message_id`.

If the POST throws before a receipt, iOS:

- removes the optimistic user row from local transcript state;
- clears the pending assistant spinner;
- restores the original text into the composer;
- retains `{thread_id, text, client_id}` in memory;
- reuses the retained `client_id` only if the next send text trims to the same value in the same thread.

If the user edits the restored text before retrying, iOS clears the retained `client_id` and generates a new one.

## Requested Backend Contract

Please confirm or implement this contract:

### 1. Duplicate Same Thread, Same `client_id`, Same Logical Message

If the backend already accepted:

```text
thread_id = T
client_id = C
text = X
```

and receives the same logical send again, the backend should:

- not create another user message row;
- not start a second agent turn/run for that user message;
- return a successful response with the already-created `message_id`;
- keep transcript history and stream/runtime state consistent with exactly one accepted user send.

Recommended response shape is the normal send receipt:

```json
{
  "message_id": "existing-message-id"
}
```

If the backend already includes `client_id` in this response, that is fine; current iOS only requires `message_id` for the receipt path.

### 2. Duplicate Same Thread, Same `client_id`, Different Message Body

If the same `thread_id` and `client_id` are reused with materially different send parameters, backend should reject the request without side effects.

Recommended behavior:

- return `409 Conflict` or `422 Unprocessable Entity`;
- do not create a new user message;
- do not start another agent turn/run;
- include enough error detail for backend logs/debugging.

Fields to compare should include at least `text`. Backend can decide whether model, reasoning effort, and `cwd` are also part of the idempotency fingerprint.

### 3. Scope

Please confirm the intended uniqueness scope:

- preferred: unique per authenticated user + thread + `client_id`;
- acceptable: globally unique `client_id`, if that is already enforced.

The key requirement is that another thread or another user cannot accidentally collide with this user's send.

## Validation Questions

1. Is `message.client_id` currently constrained unique for user messages?
2. If yes, what is the uniqueness scope: global, per user, per thread, or another composite key?
3. On duplicate `POST /messages` with the same `client_id`, does backend currently return the existing message receipt or error?
4. Can a duplicate `client_id` currently trigger a second agent run even if database message insertion is deduped?
5. If the original request accepted the message but the agent run is still active, should duplicate POST return immediately with the existing `message_id`?
6. If the original request accepted the message and the agent run already completed, should duplicate POST still return the existing `message_id` without changing thread state?
7. Should backend compare only `text`, or also `model`, `reasoning_effort`, and `cwd`, when detecting conflicting duplicate requests?
8. Are there logs or metrics we should add on backend to identify duplicate send retries by `client_id`?

## Suggested Backend Test Cases

### Accepted Request Retried After Lost Response

1. Send `POST /messages` with `client_id = C`.
2. Simulate client losing the HTTP response after backend accepts it.
3. Send the exact same POST again with `client_id = C`.
4. Assert:
   - response is success;
   - returned `message_id` is the first message's ID;
   - there is one user message in `/messages`;
   - there is one agent run/turn triggered by that user message.

### Duplicate While Agent Is Still Running

1. Send `POST /messages` with `client_id = C`.
2. Before agent work completes, send the same POST again.
3. Assert:
   - duplicate returns existing receipt;
   - no second agent run starts;
   - stream/runtime state remains tied to the first accepted send.

### Conflicting Reuse

1. Send `POST /messages` with `client_id = C`, `text = X`.
2. Send `POST /messages` with `client_id = C`, `text = Y`.
3. Assert:
   - backend rejects the second request;
   - no second user message is inserted;
   - no second agent run starts.

## iOS Acceptance Criteria

iOS can safely keep the current restored-draft retry behavior if backend confirms:

- duplicate sends with the same `client_id` are idempotent;
- duplicate sends do not create duplicate transcript rows;
- duplicate sends do not trigger duplicate assistant responses;
- conflicting reuse is rejected without side effects.

If backend cannot guarantee this today, iOS should either stop reusing `client_id` on restored retries or gate reuse behind a backend contract rollout.
