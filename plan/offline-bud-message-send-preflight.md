# Plan: offline-bud-message-send-preflight

## Context
- Date: 2026-05-26
- Related debug note: [debug/offline-bud-message-persisted-without-agent-turn.md](../debug/offline-bud-message-persisted-without-agent-turn.md)
- Primary route: `POST /api/threads/:thread_id/messages`
- Primary service files expected to change later:
  - `service/src/routes/threads/messages.ts`
  - `service/src/agent/agent-service.ts` only if startup-failure response helpers or runtime failure emission move there
  - first-party web message-send client code if the response contract changes

The selected top hypothesis is that `POST /messages` commits user intent before checking terminal availability. When the Bud is disconnected, the route can persist a canonical user message, fail to start the agent with `bud_offline`, and return an HTTP failure without an agent `final` stream event. Mobile can then wait for a response that cannot arrive, while web can later see a canonical user row for what looked like a failed send.

## Objective
Make message-send semantics coherent when the Bud is offline:

- A fresh send should not create a durable user message when the service already knows the Bud cannot accept terminal work.
- The HTTP response should be typed and actionable, not a generic `500`.
- First-party clients should know when not to wait for an assistant response.
- Races after preflight should still reconcile cleanly.

Acceptance criteria:

- Known-offline fresh sends return a typed failure before user-message insert.
- Known-offline fresh sends do not update thread model preferences, supersede pending question prompts, run context sync, write thread message metadata, or create title-generation side effects.
- Normal online sends keep the existing durable transcript and agent-start behavior.
- If the Bud disconnects after preflight but before `startUserMessage(...)` finishes, the response explicitly reports that the canonical message was saved but no agent turn started.
- Web and mobile can both stop loading from the HTTP response alone.

## Proposed Contract

### Fresh send while Bud is already known offline

Recommended response:

```json
{
  "error": "bud_offline",
  "code": "BUD_DISCONNECTED",
  "retryable": true
}
```

Recommended status: `424 Failed Dependency`.

Reasoning:

- The request body and authorization are valid.
- The thread depends on a Bud terminal transport that is unavailable.
- A non-2xx response is honest because no user message was committed.

Open status question: use `409 Conflict` instead if we want to avoid less common `424` handling in mobile or proxy layers. Either way, the stable part should be the body code, not status text.

### Bud disconnects after preflight

Preflight cannot eliminate the race. If the route inserts the user row and then `AgentService.startUserMessage(...)` fails with `bud_offline`, the response should include the canonical message plus an explicit agent-start result:

```json
{
  "message_id": "msg_...",
  "client_id": "client_...",
  "message": {
    "...": "canonical message payload"
  },
  "agent": {
    "started": false,
    "error": "bud_offline",
    "code": "BUD_DISCONNECTED",
    "retryable": true
  }
}
```

Recommended status: `201 Created`.

Reasoning:

- At that point, the message really was committed.
- Returning a non-2xx would recreate the original ambiguity.
- `agent.started: false` tells clients not to wait on `/agent/stream`.

This is a race fallback, not the common path. The common known-offline path should reject before persistence.

## Design / Approach

1. Keep authorization first.
   - Continue resolving the thread through the existing owner-aware route helpers before any Bud/session checks.
   - Do not trust a raw `thread_id` or `bud_id` from the client.

2. Preserve duplicate `client_id` behavior before offline preflight.
   - If the same owned `client_id` already maps to a message, return the existing canonical row exactly as today.
   - Do not try to start a new agent turn for a duplicate.
   - If an earlier offline preflight rejected the send before insert, there is no duplicate row, so retrying the same `client_id` after reconnect is a fresh send.

3. Add a read-only terminal availability preflight before durable send side effects.
   - Check whether the owning Bud is online through the service's authoritative daemon-transport state.
   - Avoid creating a terminal session row just to discover that the Bud is offline.
   - If there is an active thread terminal session but the Bud is offline, reject before context sync and message insert.
   - If there is no active session and the Bud is offline, reject before session creation and message insert.

4. Move side effects behind the preflight for fresh sends.
   - Pending `ask_user_questions` supersession should only happen after the send can proceed.
   - Thread model preference updates should only happen after the send can proceed.
   - Best-effort context sync should not run in the known-offline branch.
   - User message insert, message metadata, title generation, and agent startup remain after the preflight.

5. Keep `startUserMessage(...)` as the authoritative startup path.
   - The route preflight is an optimization and contract guard, not a replacement for terminal ensure.
   - `startUserMessage(...)` should still ensure the session after insert because the agent needs the durable user message in transcript history.

6. Add explicit post-insert startup-failure handling.
   - Map `bud_offline` / `BUD_DISCONNECTED` to the partial-success response above.
   - Confirm runtime cleanup leaves `/agent/state` inactive.
   - Do not emit a misleading assistant message.
   - Decide separately whether to emit a stream `final` failure for already-attached clients. The HTTP response must be sufficient either way.

## Edge Cases

- Bud disconnects between preflight and terminal ensure.
  - Handled by the post-insert `agent.started: false` response.

- Bud reconnects immediately after an offline preflight rejection.
  - The rejected send has no durable row. The client can retry with the same `client_id` and create the intended message once transport is back.

- Existing duplicate `client_id` is retried while Bud is offline.
  - Return the existing message and do not start a new agent turn. This preserves idempotency.

- A pending `ask_user_questions` prompt exists and the user sends while Bud is offline.
  - Known-offline preflight should not supersede the prompt because no durable follow-up message exists.

- User changes model/reasoning in the send request while Bud is offline.
  - Recommended behavior: do not persist the selection if the send is rejected before persistence. The model selection is part of the send, not an independent settings write.

- Context sync would have failed with `bud_offline`.
  - Known-offline preflight should skip context sync entirely, reducing noisy expected-development logs.

- No terminal session exists yet.
  - Offline preflight should reject before creating `pending` / `creating` session rows.
  - Online path can continue to rely on existing session ensure during agent startup.

- Terminal session exists in `ready`, `active`, or `idle`, but transport state is stale.
  - Preflight uses the same online signal that terminal ensure will use. The post-insert fallback remains necessary for stale-positive cases.

- Non-offline startup errors.
  - Do not collapse all startup errors into `bud_offline`.
  - Preserve current failure handling until each error gets a deliberate contract.

## Known Side Effects

- A rejected known-offline send will no longer appear in canonical chat history.
- Clients that currently expect a failed request to later reappear from `/messages` should stop relying on that accidental behavior.
- Thread model preference changes bundled with a rejected send will no longer persist.
- Existing pending human-input prompts will survive rejected offline sends.
- Logs should shift from route-level `ERROR Agent failed to queue message` for expected offline sends toward a lower-severity typed rejection in the preflight branch.
- The race fallback introduces a new successful HTTP response shape with `agent.started === false`; first-party clients must handle it before this is broadly relied on.

## Open Questions

- Should the known-offline status be `424` or `409`?
- Should the route emit a stream-level failed `final` in the post-insert race fallback for clients that already attached before the HTTP response resolves?
- Should a saved-but-not-started user message have a visible transcript marker, or is the HTTP response enough for now?
- Should non-offline startup errors after insert also become partial-success responses, or remain `500` until they are categorized?
- Do we want a future durable `agent_turn` / message status model for saved-but-not-started, queued, retryable, canceled, and failed states?

## Spec Files To Update During Implementation

- [ ] `service/src/routes/threads/threads.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/agent/agent.spec.md` if startup-failure semantics move into agent service helpers
- [ ] `docs/proto.md` if the HTTP message-send response contract is documented there
- [ ] relevant `web/src/**/*.spec.md` files if the reference web client adopts `agent.started === false`

## Impacted Contracts

- [ ] REST `POST /api/threads/:thread_id/messages`
- [ ] First-party web optimistic-message reconciliation
- [ ] Mobile message-send reconciliation and spinner termination
- [ ] Agent runtime startup cleanup
- [ ] Context sync invocation order
- [ ] Pending question supersession order
- [ ] Thread model preference persistence order

Not expected in this phase:

- Database schema changes
- Bud daemon protocol changes
- Terminal SSE event shape changes, unless the stream-level failed-final open question is accepted

## Test Plan

- Unit or route test: known-offline fresh send returns typed failure and inserts no user message.
- Unit or route test: known-offline fresh send does not update thread model preferences.
- Unit or route test: known-offline fresh send does not supersede pending `ask_user_questions` prompts.
- Unit or route test: known-offline fresh send does not invoke context sync.
- Unit or route test: duplicate `client_id` retry while offline still returns the existing message without starting an agent turn.
- Unit or route test: online fresh send still inserts the user message and calls `startUserMessage(...)`.
- Race test: preflight passes, `startUserMessage(...)` throws `bud_offline`, and the response includes the canonical message plus `agent.started === false`.
- Runtime state test: the race fallback leaves `/agent/state` inactive and does not strand a loading turn.
- Web regression test: known-offline non-2xx removes or marks the optimistic row without waiting for stream final.
- Web regression test: `201` with `agent.started === false` reconciles the canonical row and stops loading.
- Mobile validation handoff: offline send stops spinner from HTTP response in both the preflight rejection and post-insert race fallback.

## Rollout

1. Implement backend preflight and typed response mapping behind the existing route contract.
2. Add route tests for known-offline rejection and post-insert race fallback.
3. Update the reference web client to handle `agent.started === false`.
4. Hand the response shapes to mobile and validate local restart scenarios:
   - Bud disconnected before send
   - Bud disconnects during send
   - Bud reconnects and same `client_id` retry succeeds after a preflight rejection
5. Update specs and protocol docs for the final accepted status/body choices.
