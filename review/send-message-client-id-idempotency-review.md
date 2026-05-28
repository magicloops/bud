# Review: Send Message Client ID Idempotency

Date: 2026-05-27

## Context

The iOS team asked whether `POST /api/threads/:thread_id/messages` can safely treat `client_id` as an idempotency key when a request may have been accepted by the backend but the client never receives the response.

The reviewed handoff is `reference/IOS_SEND_MESSAGE_CLIENT_ID_IDEMPOTENCY_HANDOFF.md`.

## Current Backend Behavior

The backend has partial idempotency support today:

- `message.client_id` is globally unique through `message_client_id_idx`.
- The create-message route resolves the authenticated thread/user first.
- Before creating a new user message, the route looks for an existing owned user message by `(thread_id, created_by_user_id, role = "user", client_id)`.
- If it finds one, it returns `200` with the existing serialized message and does not start a second agent turn.
- If a concurrent insert hits the global `client_id` unique index, the route repeats the owned duplicate lookup and returns the existing message when it belongs to the same viewer/thread.

That means the normal "client lost the response after the backend accepted and started the turn" retry path does not create a second user row or a second assistant response.

## Assumptions That Are Valid

- Reusing the same `client_id` for the same thread and same authenticated user can recover the existing message receipt.
- Duplicate retries return successfully instead of surfacing the database unique violation when the duplicate belongs to the same owner/thread.
- Duplicate retries return before follow-up supersession, context sync, thread model updates, message insert, and agent startup side effects.
- The uniqueness scope is stricter than the iOS-preferred `(user, thread, client_id)` scope because `client_id` is globally unique.

## Assumptions That Are Not Fully Valid

### Conflicting Reuse Is Not Rejected

If the same authenticated user and thread reuse `client_id` with different `text`, the route currently returns the existing message as a successful duplicate. It does not compare the incoming body against the persisted message.

This violates the requested contract that conflicting reuse should return `409` or `422` without side effects.

### Inserted-But-Not-Started Messages Can Be Stranded

The route inserts the user message before calling `AgentService.startUserMessage(...)`.

If the process crashes, restarts, or returns an error after the insert but before the agent turn is successfully started, a later retry with the same `client_id` will take the duplicate branch and return the existing message without starting or recovering the missing agent turn.

This is the main gap for the "no backend response, but backend processed the request" scenario. The backend may have processed the message insert, but not the agent start.

### Duplicate Responses Do Not Include Agent Metadata

New successful writes return an `agent` object with startup metadata. Duplicate responses currently return only the existing message receipt.

This is probably acceptable if clients refresh `/agent/state`, but it is not identical to the new-send response shape and should be documented or fixed with the rest of the contract.

## Recommended Fix Direction

### Phase 1: Strict Duplicate Validation

Add a duplicate-request validator before returning the existing message.

Compare at least:

- `text` against `message.content`
- `cwd` against `message.metadata.preferred_cwd`, treating missing and absent consistently

Consider comparing these too:

- effective model
- effective reasoning effort
- model selection source

If any fingerprint field conflicts, return `409 client_id_conflict` without side effects.

Add route tests for:

- exact duplicate returns existing message
- conflicting duplicate text returns `409`
- conflicting duplicate cwd returns `409`
- cross-thread/global unique conflict returns `409` instead of leaking another user's message

### Phase 2: Recover Inserted-But-Not-Started Sends

Introduce a durable send/turn startup marker, or another agent-start ledger, so the backend can distinguish:

- user message exists and agent turn was started
- user message exists but agent turn never started
- user message exists and agent turn already completed

On duplicate retry:

- if the original turn is active or completed, return the existing receipt and current agent/runtime metadata
- if the message exists but no turn-start marker exists, start or recover the agent turn exactly once
- if the original turn failed before visible assistant output, return a stable failure/retry contract rather than silently treating the send as complete

This closes the gap where the backend accepted the durable user message but failed before enqueuing the assistant response.

### Phase 3: Response Shape Cleanup

Decide whether duplicate send responses should include the same `agent` metadata shape as new sends.

Options:

- keep duplicate responses as message-only receipts and require clients to call `/agent/state`
- include `agent` metadata when a turn is active or recoverable
- include an explicit `duplicate: true` / `agent.started: false` marker

The cleanest client contract is likely: duplicate retry returns the existing message and enough agent state for the client to resume without guessing.

## Mobile Guidance Until Fixed

iOS can continue reusing the same `client_id` only for the exact restored draft in the same thread, but this should be treated as relying on a partial backend contract.

If iOS wants to avoid the conflicting-reuse gap before the backend fix lands:

- keep the current "reuse only when trimmed text is unchanged" guard
- clear the retained `client_id` on any edit
- refresh `/messages` and `/agent/state` after a duplicate receipt
- do not assume a duplicate receipt proves the assistant turn started

## Conclusion

The mobile handoff is directionally correct, and the common retry path is mostly safe today. The backend should still plan a follow-up fix because the current implementation does not reject conflicting duplicate bodies and does not recover the inserted-but-not-started window.
