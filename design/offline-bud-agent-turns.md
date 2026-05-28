# Design: Offline Bud Agent Turns

Status: Draft

Audience: Backend, web platform, iOS, product

Last updated: 2026-05-26

## 1. Goal

Define the product and backend contract for sending a message when the thread's Bud is offline.

The key product correction is that "Bud is offline" should not automatically mean "the agent cannot respond." The agent can still use the LLM provider to answer general questions, explain that device access is unavailable, and help the user get the Bud back online. The broken behavior to fix is not the persisted user message. The broken behavior is that agent startup treats terminal availability as mandatory, then fails without a coherent response, state transition, or client signal.

## 2. Current Behavior

Observed local-dev failure:

1. `POST /api/threads/:thread_id/messages` receives a user message.
2. Context sync attempts to observe the terminal and logs `bud_offline`.
3. Context sync is best-effort, so the route continues.
4. The user message is persisted.
5. `AgentService.startUserMessage(...)` tries to ensure the terminal session.
6. Terminal ensure throws `bud_offline`.
7. The route returns `500 { "error": "bud_offline" }`.
8. No assistant response or `final` stream boundary is produced.

This leaves clients with mixed semantics:

- durable transcript changed
- HTTP request failed
- `/agent/state` returns idle after cleanup
- `/agent/stream` has no final boundary
- mobile can keep waiting for a response that cannot arrive

## 3. Product Semantics

Message send should mean: "the user has added a message to this thread and asked the assistant to respond."

It should not mean: "the Bud terminal is definitely reachable before the assistant can think."

When the Bud is offline at send time:

- the user message should be saved
- the request should succeed if the LLM turn can start
- the assistant should run in an offline-aware mode
- Bud-specific tools should be unavailable to the model for that turn
- clients should be told that the active turn is degraded because the Bud is offline
- the final assistant answer should be a normal assistant message, not a system failure row

If the user asks for work that requires the device, the assistant should be honest that it cannot inspect or change the Bud right now and can offer recovery steps. If the user asks a general question that does not require the Bud, the assistant can answer normally, with only a lightweight offline notice in UI state.

## 4. Recommended Direction

Adopt an **offline-aware agent turn**.

The service should classify the current turn environment before agent startup and refresh Bud transport availability before Bud-specific tool execution:

```text
normal        Bud transport is available; normal tool catalog can be offered.
bud_offline   Bud transport is unavailable; run the LLM without Bud-specific tools, but keep non-Bud tools available.
```

For `bud_offline` turns:

- skip terminal ensure as a startup precondition
- skip context sync that requires observing the Bud
- call the selected LLM provider with an offline environment notice
- omit Bud-specific terminal and web proxy tools from the model-facing tool catalog
- keep non-Bud tools such as `ask_user_questions`; future service-level tools remain available by default unless they are classified as Bud-specific
- persist the final assistant response like any other assistant message
- expose the degraded environment through `/agent/state`, the send response, and optionally an SSE activity event
- treat transport state as recoverable between tool calls rather than freezing the whole turn in one permanent availability state

This keeps the request successful while preventing the model from trying to use unavailable device tools.

## 5. Tool Catalog Choices

### Option A: Bud-specific tool denylist

When Bud is offline, omit Bud-specific tools but keep tools that do not require device transport, such as `ask_user_questions`.

Pros:

- lets the assistant pause for structured clarification
- useful for debugging why the Bud is offline
- aligns with a future broader tool taxonomy where first-class tools such as web search are not tied to Bud transport and should not need per-tool offline opt-in
- impossible for the model to call terminal or proxy tools while they are known unavailable
- final response path already exists

Cons:

- requires reliably classifying tools that depend on Bud transport
- keeps more runtime states active while the Bud is unavailable
- context-budget estimates eventually should reflect the reduced but non-empty tool set

This is the recommended first phase.

### Option B: Tool-free offline turns

When Bud is offline, pass no model-facing tools.

Pros:

- lowest implementation risk
- simplest context-budget accounting

Cons:

- the model cannot use `ask_user_questions` for structured clarification
- less aligned with the expected future where non-Bud first-class tools remain useful even when the selected Bud is offline

This is a fallback if the Bud-specific denylist proves too risky for the first implementation, but it is not the preferred product direction.

### Option C: Keep all tools and return `BUD_DISCONNECTED` tool results

Leave the normal tool catalog unchanged, but make terminal and web-view tool executors return structured disconnected results instead of failing the turn.

Pros:

- minimal provider-call plumbing changes
- model sees concrete tool failure evidence
- also useful for mid-turn disconnects after a normal turn starts

Cons:

- wastes tool calls on a known-unavailable transport
- clients may briefly show terminal/proxy tool activity that was never actionable
- the model may repeatedly attempt unavailable tools unless prompt guidance is strong

This should be used as the mid-turn disconnect fallback, not as the preferred start-offline behavior.

### Option D: Fail the send before persistence

Reject the request when the Bud is offline.

Pros:

- simple transaction semantics
- no offline-agent behavior to design

Cons:

- blocks useful assistant responses
- treats device reachability as mandatory for all user messages
- forces clients to invent retry/draft behavior

This is no longer the preferred product direction, though fail-fast still applies to true request validation failures such as auth, missing thread, malformed body, or invalid model selection.

### Option E: Queue the turn until Bud reconnects

Persist the user message and delay the agent response until the Bud reconnects.

Pros:

- preserves the possibility of doing the requested device work later

Cons:

- requires durable turn status, retries, cancellation, and notification semantics
- unclear user expectation in active chat
- can leave the user waiting when a helpful offline response would be better

This is out of scope for the immediate fix.

## 6. Proposed API And Runtime Shape

### `POST /messages` response

Current create-message responses already include the serialized user message. Keep that success path and add an optional `agent` object:

```json
{
  "message_id": "msg_...",
  "client_id": "client_...",
  "message": {
    "...": "canonical user message"
  },
  "agent": {
    "started": true,
    "mode": "bud_offline",
    "bud_status": "offline",
    "stream_cursor": "01..."
  }
}
```

For normal turns, `mode` is `"normal"`.

Clients should use `agent.started === true` to know that a stream/state-backed assistant turn exists. Bud offline is not an HTTP error if the offline-aware LLM turn started.

### `/agent/state`

Extend the existing snapshot with a client-safe environment section. This section should be present on both active and idle snapshots so clients always know the selected Bud's current availability.

```json
{
  "active": true,
  "turn_id": "01...",
  "phase": "thinking",
  "can_cancel": true,
  "stream_cursor": "01...",
  "pending_tool": null,
  "draft_assistant": null,
  "environment": {
    "mode": "bud_offline",
    "bud_id": "b_...",
    "bud_status": "offline",
    "reason": "bud_disconnected",
    "last_seen_at": "2026-05-26T22:48:20.000Z",
    "tools": {
      "terminal": "unavailable",
      "web_view": "unavailable",
      "file": "unavailable",
      "ask_user_questions": "available"
    }
  },
  "updated_at": "2026-05-26T22:48:24.000Z"
}
```

The same environment section can be returned on idle snapshots so thread-open UI can show "Bud offline" before the user sends. The source of truth remains the authorized thread's owning Bud and the service's daemon transport state.

### SSE event

Optionally emit an activity-only event at turn start:

```text
event: agent.environment
data: {
  "turn_id": "01...",
  "mode": "bud_offline",
  "bud_status": "offline",
  "reason": "bud_disconnected",
  "tools": {
    "terminal": "unavailable",
    "web_view": "unavailable",
    "file": "unavailable"
  }
}
```

This is not a transcript row. It exists so already-attached clients can update status without waiting for a `/agent/state` refetch.

Decision: `/agent/state.environment` is the authoritative contract and is sufficient for correctness. The send response should also include startup environment metadata. `agent.environment` can be added as a nice-to-have additive event if it is cheap, but clients should not require it for convergence.

## 7. Prompt And Model Context

Offline turns need explicit model instruction outside the user message:

```text
The selected Bud is currently offline. You cannot inspect terminal state,
run commands, open local web views, read files from the Bud, or use proxy
features while it is offline. You may still use non-device tools that are
available, such as asking the user structured questions. Do not claim to have
used the Bud. If the user asks for device work, explain the limitation and help them reconnect or describe
what you would do once the Bud is online. If the user asks something that
does not require the Bud, answer normally.
```

This should be injected as request-time system/developer context, not as a persisted user-visible message.

The context loader can still use durable transcript history and provider ledger history. Context sync should be skipped because it requires live terminal observation. Cached terminal cwd/path context can remain available as stale metadata, but the prompt should not imply it is current.

## 8. Backend Flow

Recommended fresh-send flow:

1. Authorize the thread and derive the owning Bud.
2. Validate model and reasoning selection.
3. Check duplicate `client_id`; return the existing canonical message before side effects.
4. Resolve the current Bud transport snapshot.
5. Supersede pending `ask_user_questions` prompts if this is a fresh message.
6. Persist thread model preference updates if supplied.
7. If Bud is online, run best-effort context sync as today.
8. If Bud is offline, skip context sync.
9. Persist the user message and thread message metadata.
10. Start the agent with `environment.mode`.
11. Return `201` with the canonical message and `agent` startup metadata.

Agent startup behavior:

- `normal`: keep the existing terminal/session startup path.
- `bud_offline`: seed `/agent/state`, skip terminal ensure, and start `runAgentFlow(...)` with the Bud-specific denylist filtered catalog and offline prompt context.

The important inversion is that terminal availability is no longer a universal `startUserMessage(...)` precondition.

## 9. Mid-Turn Disconnects

Offline-at-start and disconnect-after-start should be handled differently, but both states should be recoverable.

When a turn starts in `bud_offline` mode:

- omit Bud-specific tools from that provider call
- if the Bud reconnects while the provider call is in flight, do not mutate that already-started request
- before a later provider step in the same turn, refresh the Bud environment and use the normal tool catalog again if the Bud is back online
- expose the updated environment through `/agent/state`

When a turn starts in `normal` mode but the Bud disconnects during a terminal or web-view tool:

- do not fail the whole agent turn solely because transport is gone
- return a structured tool result with `error` and `code` fields, using `BUD_DISCONNECTED` for known offline cases and a generic transport code for other transport failures
- update `/agent/state.environment.mode` or emit `agent.environment` to show degradation
- before the next provider call, refresh the environment. If the Bud is online again, restore Bud-specific tools so the model can continue rather than ending the turn as permanently offline.
- let the model decide whether to retry, ask the user a question, or explain the failed tool result

This is where Option C is useful. Tool executors should convert transport loss into model-visible tool results, not uncaught agent failures. The environment is a per-step capability snapshot, not a permanent turn label.

## 10. Client UX

Clients should distinguish three things:

- HTTP request success: user message was accepted
- agent turn state: assistant is responding
- Bud environment: device tools are available or unavailable

Recommended mobile/web behavior:

- On `201` with `agent.mode: "bud_offline"`, keep the canonical user message and show normal assistant loading.
- Show a small composer-level Bud offline indicator from `/agent/state.environment`.
- Existing thread-list or thread-title Bud status can remain, but it should not be the only offline signal because those surfaces are not currently reliable enough.
- Do not show a failed-send spinner.
- Do not create a special system transcript row just to say the Bud is offline.
- Render the assistant's final response normally.
- If the final assistant response says the Bud is offline, that text is model-authored and persisted as the answer.

This keeps offline status visible without turning transport state into chat history unless the assistant needs to mention it.

## 11. Edge Cases

- User asks a general question while Bud is offline.
  - The assistant should answer normally. UI can still show the offline badge.

- User asks the agent to run commands while Bud is offline.
  - The assistant should say it cannot access the Bud right now and offer reconnection or next-step guidance.

- Bud reconnects during an offline-mode turn.
  - Do not mutate an in-flight provider request, but refresh environment before the next provider step. If the Bud is online, restore Bud-specific tools for the next step in the same turn.

- Bud disconnects during a normal terminal tool call.
  - Return a transport-error tool result and continue the agent turn. If the Bud reconnects before the next provider step, the next step may use Bud tools again.

- Provider fails while Bud is offline.
  - This is a real agent failure, separate from Bud availability. Emit/persist the normal failed final boundary and return/stream enough state for clients to stop loading.

- Duplicate `client_id` retry after an offline-mode send.
  - Return the existing message as today. The client should use `/agent/state` and `/messages` to converge on whether the offline-mode turn is still active or already completed.

- Pending `ask_user_questions` prompt exists.
  - A normal follow-up message should still supersede it because the new user message is durable and a new agent turn is starting.

- First-message title generation.
  - Offline-mode turns should count as started. Title generation can proceed because it does not require Bud transport.

- Context budget.
  - First pass can tolerate conservative normal-tool estimates. Later, budget snapshots should either use the reduced offline tool-schema estimate or expose `tool_schema_mode` so diagnostics do not pretend the normal catalog was sent.

## 12. Decisions

- Phase 1 should remove only Bud-specific tools, starting with terminal and web proxy tools. Non-Bud tools such as `ask_user_questions` should remain available.
- `/agent/state.environment` is authoritative. The send response should include startup environment metadata. A streamed `agent.environment` event is optional and additive.
- Idle `/agent/state` should include Bud environment so clients always know whether the selected Bud is connected.
- Web and mobile should show the offline alert in the composer. Thread-title/list status may remain, but should not be the only signal.
- Terminal and web-view executors should convert transport errors into structured tool results, not only known `bud_offline` cases. Known offline cases should use `BUD_DISCONNECTED`; unknown transport failures should use a generic transport error code.
- First pass can tolerate conservative normal-tool context-budget estimates even when the offline catalog is smaller.
- Bud availability should be recoverable inside a turn. The agent should not permanently end or mark the turn offline just because one tool call failed while transport was down.

## 13. Remaining Open Questions

- What exact generic code should represent non-offline transport failures: `TRANSPORT_ERROR`, `BUD_TRANSPORT_ERROR`, or another existing canonical code?
- Which future tools should be classified as Bud-specific when they ship?
- Should an additive `agent.environment` event be included in phase 1 for smoother already-attached client updates, or deferred until clients prove they need it?
- How often should the agent refresh Bud environment between provider/tool steps to avoid noisy state churn while still recovering promptly?

## 14. Implementation Notes

Likely backend changes:

- Add an `AgentEnvironmentMode` such as `"normal" | "bud_offline"`.
- Add a tool-catalog resolver instead of passing `AGENT_CANONICAL_TOOLS` unconditionally. The resolver should exclude Bud-specific tools while preserving non-Bud tools.
- Add an offline tool-schema token estimate for context budget diagnostics later; first pass can use conservative normal-tool estimates.
- Teach `AgentService.startUserMessage(...)` to start `bud_offline` turns without terminal ensure.
- Add request-time offline environment instructions to conversation construction.
- Add `environment` to `AgentRuntimeStateManager` snapshots for active and idle states.
- Refresh environment before provider/tool steps so a Bud that reconnects mid-turn can be used again on later steps.
- Map terminal and web-view transport loss during normal turns into structured tool results.
- Extend `POST /messages` response with optional `agent` startup metadata.

Specs/docs to update when implemented:

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/threads/threads.spec.md`
- relevant web specs if the reference web client renders the offline status
- mobile handoff docs if iOS consumes the new response/state fields

## 15. Decision Summary

The preferred direction is not to reject offline Bud sends. It is to make Bud availability a turn environment.

Start-offline turns should succeed with only Bud-specific tools removed, while non-Bud tools such as `ask_user_questions` remain available. Mid-turn disconnects should become structured tool results so the model can recover, and Bud reconnection should restore Bud tools before later provider steps in the same turn. `/agent/state` should always expose the environment so clients can stop treating offline transport as a failed send or an endless spinner.
