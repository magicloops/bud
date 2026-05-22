# Design: Streaming Tool Call Assembly

Status: Draft

Created: 2026-05-21

Audience: Backend, web, iOS

Related:
- [../service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [../service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [../docs/proto.md](../docs/proto.md)
- [./ask-user-questions-tool-contract.md](./ask-user-questions-tool-contract.md)
- [./mobile-tool-call-timing-and-compaction.md](./mobile-tool-call-timing-and-compaction.md)
- [./message-client-id-and-stable-message-identity.md](./message-client-id-and-stable-message-identity.md)

---

## 1. Summary

Bud currently streams assistant text to clients while a provider response is in progress, but it only emits client-visible tool calls after the provider has completed the tool-call arguments and the service has normalized the call into Bud's intermediary tool representation.

That is correct for execution safety, but it leaves a UX gap for long tool-call arguments. A model can spend noticeable time constructing a large `ask_user_questions` request, a long web-view title/path payload, or a future file/edit tool payload. During that time, clients see the assistant as still thinking even though useful tool structure is already present in the provider stream.

This design investigates adding an additive, non-authoritative tool-call preview stream so first-party clients can optionally render parts of a tool call while `AgentModelRunner` is still assembling it. The existing final `agent.tool_call` event should remain the authoritative boundary that means "the service has a complete, normalized, executable tool call."

The recommended direction is:

- keep current `agent.tool_call` and `agent.tool_result` semantics unchanged
- add an optional `agent.tool_call_preview` event for partial tool-call assembly
- allocate the eventual tool row `client_id` before the first preview event
- expose preview state as best effort and non-interactive until the final `agent.tool_call`
- specialize server-side previews for high-value tools such as `ask_user_questions`

This is a service-to-client SSE contract. It does not require Bud daemon protocol changes.

---

## 2. Current State

The provider abstraction already has the internal streaming shape needed for this.

Canonical provider stream events include:

- `tool_use_start`
- `tool_use_delta`
- `tool_use_done`

OpenAI maps Responses API `function_call` events into those canonical events. Anthropic maps Messages API `tool_use` content blocks and `input_json_delta` into the same canonical shape.

`AgentModelRunner.invokeModel(...)` currently consumes those events like this:

- assistant text deltas are emitted immediately as `agent.message_start`, `agent.message_delta`, and `agent.message_done`
- tool argument deltas are accumulated internally
- only `tool_use_done` is converted into a `CanonicalToolCall`
- after the provider stream completes, `AgentService.runAgentFlow(...)` extracts Bud tool directives from the completed canonical response
- `AgentTranscriptWriter.emitToolCall(...)` emits the final client-visible `agent.tool_call` immediately before tool execution

That means clients see tool activity only after these things have already happened:

1. the provider finished the JSON argument stream for that tool call
2. `AgentModelRunner` parsed the completed argument JSON
3. the service mapped the provider tool name to a Bud tool name
4. tool-specific validation or normalization succeeded
5. `AgentService` reached that tool in provider output order

For `ask_user_questions`, the current contract is even stricter: the service persists a durable question request before exposing the final prompt to clients. That gives clients a safe `request_id` to answer, but it also means no part of the question form is visible until the whole request has completed and validated.

---

## 3. Goals

- Let clients show earlier, richer progress when a model is constructing a long tool call.
- Let `ask_user_questions` render completed questions as soon as they are available, even if later questions are still streaming.
- Preserve the existing final `agent.tool_call` contract as the executable, normalized, replay-safe tool boundary.
- Keep partial tool-call preview optional for clients. Existing clients that ignore unknown SSE events must keep working.
- Reuse `client_id` so a preview row, final tool row, `agent.tool_result`, and persisted tool message reconcile without local id invention.
- Avoid exposing provider-native details as the primary client contract.
- Keep execution behavior unchanged in the first pass: do not execute a tool before the model call has reached the current completed-tool boundary.

## 4. Non-Goals

- Do not execute tools from partial arguments.
- Do not persist partial tool calls in the canonical transcript.
- Do not make `ask_user_questions` answerable before the service has created a durable request row and emitted the final `agent.tool_call`.
- Do not expose OpenAI or Anthropic raw event names to web/mobile clients.
- Do not require every tool to support a rich structured preview.
- Do not make preview delivery as durable as `/messages`. Transcript correctness should still come from final persisted rows plus `/agent/state`.

---

## 5. Proposed Contract Shape

### 5.1 Keep `agent.tool_call` authoritative

The existing event should keep its current meaning:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "ask_user_questions",
  "args": {
    "schema": "ask_user_questions_request_v1",
    "request_id": "qr_01J...",
    "title": "Deployment details",
    "questions": []
  },
  "started_at": "2026-05-21T18:00:03.120Z"
}
```

Clients can continue treating this as:

- the tool is now running, or
- for `ask_user_questions`, the service is now waiting for user input

### 5.2 Add `agent.tool_call_preview`

Add one new SSE event name with a small phase field:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "ask_user_questions",
  "phase": "arguments_delta",
  "argument_delta": "{\"questions\":[",
  "arguments_text_length": 14,
  "started_at": "2026-05-21T18:00:01.800Z"
}
```

Recommended phases:

| Phase | Meaning |
|-------|---------|
| `started` | The provider started a known tool call and the service allocated a `client_id`. |
| `arguments_delta` | A raw provider-neutral JSON argument fragment arrived. |
| `arguments_snapshot` | The service has a best-effort parsed preview object for clients. |
| `discarded` | The preview should be removed because the final call will not become a client-visible tool call. |

`agent.tool_call_preview` is explicitly non-authoritative:

- `argument_delta` may be incomplete JSON
- `args` or `preview` snapshots may be partial
- a preview may be discarded or superseded
- clients must not submit answers or dispatch side effects from preview data
- final validation remains owned by the existing tool extraction path

### 5.3 Preview snapshot example for `ask_user_questions`

When the server can identify a complete first question, it can emit:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "ask_user_questions",
  "phase": "arguments_snapshot",
  "preview": {
    "schema": "ask_user_questions_request_preview_v1",
    "title": "Deployment details",
    "body": "I need a few details before I continue.",
    "questions": [
      {
        "question_id": "target_environment",
        "kind": "single_choice",
        "label": "Which environment should I target?",
        "skippable": true,
        "choices": [
          { "choice_id": "staging", "label": "Staging" },
          { "choice_id": "production", "label": "Production" }
        ],
        "complete": true
      }
    ],
    "complete_question_count": 1,
    "is_final": false
  },
  "arguments_text_length": 428,
  "updated_at": "2026-05-21T18:00:02.500Z"
}
```

The final `agent.tool_call` then replaces or upgrades this preview row:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "ask_user_questions",
  "args": {
    "schema": "ask_user_questions_request_v1",
    "request_id": "qr_01J...",
    "title": "Deployment details",
    "questions": [
      {
        "question_id": "target_environment",
        "kind": "single_choice",
        "label": "Which environment should I target?",
        "skippable": true,
        "choices": []
      }
    ]
  },
  "started_at": "2026-05-21T18:00:03.120Z"
}
```

The client should render preview questions as disabled or "still preparing". The form becomes answerable only after the final `agent.tool_call` includes the durable `request_id`.

---

## 6. Runtime State

There are two viable runtime-state approaches.

### Option A: Stream-only preview

Only emit `agent.tool_call_preview` on the SSE stream. The bounded event buffer can replay recent preview events when a client reconnects with a valid cursor.

Pros:

- minimal backend state change
- no `/agent/state` contract expansion
- enough for uninterrupted live views

Cons:

- a hard refresh during a long tool-call assembly may not reconstruct the current partial preview unless the cursor replay covers it
- mobile cold-open behavior remains coarser than the live stream
- clients need to tolerate the preview disappearing until final `agent.tool_call`

### Option B: Add `/agent/state.draft_tool_call`

Extend the runtime snapshot with a best-effort draft tool object:

```json
{
  "draft_tool_call": {
    "client_id": "019...",
    "call_id": "call_123",
    "name": "ask_user_questions",
    "phase": "arguments_snapshot",
    "preview": {},
    "arguments_text_length": 428,
    "started_at": "2026-05-21T18:00:01.800Z",
    "updated_at": "2026-05-21T18:00:02.500Z"
  }
}
```

Pros:

- aligns with existing `draft_assistant` and `pending_tool`
- refresh and mobile reconnect can show the current partial state without relying entirely on replay
- clients can project state from fields, not stream history

Cons:

- expands the `/agent/state` contract
- requires careful cleanup when final `agent.tool_call`, `agent.tool_result`, `final`, or cancellation arrives
- creates one more synthetic-row path in web/iOS reducers

Recommendation: use Option B if the product goal includes mobile refresh/cold-open polish during long tool-call assembly. Use Option A only for a quick live-only experiment.

---

## 7. Identity And Reconciliation

Current clients are `client_id` first. A streaming-preview design should keep that rule.

Recommended backend behavior:

1. When `AgentModelRunner` sees `tool_use_start` for a known provider tool name, allocate a `client_id`.
2. Emit the first `agent.tool_call_preview` with that `client_id`.
3. Store the `client_id` with the in-progress tool-call assembly state.
4. Return the same `client_id` with the completed tool call to `AgentService`.
5. Use that same `client_id` when `AgentTranscriptWriter.emitToolCall(...)` emits the final `agent.tool_call`.
6. Reuse that same `client_id` when persisting the final tool message and emitting `agent.tool_result`.

This probably means extending the service-owned model-runner result type, not the provider-neutral `CanonicalToolCall` type. The provider abstraction should stay focused on provider output. Product identities are an agent/runtime concern.

Fallback if implementation scope is tight:

- preview events can be keyed by `(turn_id, call_id)`
- final `agent.tool_call` introduces `client_id`
- clients reconcile preview to final by `(turn_id, call_id)`

That fallback works, but it weakens the client-id rollout and should be treated as a migration shortcut only.

---

## 8. Parsing Strategy

There are three practical ways to turn provider argument deltas into client previews.

### 8.1 Raw deltas only

Forward `argument_delta` and accumulated length. Clients may choose to show "Preparing ask_user_questions..." but do not parse the payload.

Pros:

- simplest backend
- almost no semantic risk
- useful for debugging and basic progress UI

Cons:

- does not satisfy the main product example of rendering the first question early
- pushes partial JSON parsing to clients if they want richer UI
- risks web and mobile implementing different parser behavior

### 8.2 Generic partial JSON snapshots

The service accumulates argument text and periodically emits a best-effort parsed object using a partial JSON parser.

Pros:

- clients get one provider-neutral preview object
- works for many tools without custom logic
- keeps parsing behavior centralized

Cons:

- partial JSON parsing is subtle, especially around strings, arrays, escaping, and incomplete objects
- generic snapshots may expose malformed semantic states
- new parser dependency or careful custom tokenizer likely needed

### 8.3 Tool-specific preview extractors

The service emits raw deltas for every known tool and adds structured `preview` only for tools with a deliberate extractor, starting with `ask_user_questions`.

Pros:

- best match for the product goal
- avoids pretending every partial JSON object is semantically safe
- lets `ask_user_questions` emit only complete, renderable question items
- easier to test with provider chunk fixtures

Cons:

- more tool-specific code
- new tools need explicit preview support
- the generic UI may still only show coarse progress for most tools

Recommendation: start with 8.3. Add `argument_delta` for every known tool, and add a dedicated `ask_user_questions` preview extractor that emits complete, non-interactive question snapshots.

---

## 9. Client Rendering Model

Clients that opt in can treat preview rows as a third synthetic message state:

| State | Source | Suggested UI |
|-------|--------|--------------|
| draft assistant | `agent.message_*` or `/agent/state.draft_assistant` | streaming assistant text |
| draft tool call | `agent.tool_call_preview` or `/agent/state.draft_tool_call` | assembling tool card |
| pending tool | `agent.tool_call` or `/agent/state.pending_tool` | running tool or waiting for user |
| persisted tool | `agent.tool_result.message` or `/messages` | canonical transcript row |

For `ask_user_questions`:

- preview card shows visible questions as disabled
- show a subtle "Preparing questions" state while more arguments stream
- do not show submit controls until final `agent.tool_call`
- when final `agent.tool_call` arrives with the same `client_id`, replace the preview card with the normal pending question form
- when `agent.tool_result` arrives, replace with the canonical completed tool row

For terminal tools:

- preview may be as simple as "Preparing terminal.send" with a command excerpt
- avoid showing raw long command arguments in a way that looks executed
- final `agent.tool_call` remains the first point where the client should say the command is running

For web-view tools:

- preview can show a pending URL or target port if parsed
- final `agent.tool_call` and `agent.tool_result` still drive actual pane switching and web-view refresh

---

## 10. Ordering And Replay

Preview events should use the same agent SSE cursor space as other agent events.

Recommended ordering for one tool:

```text
agent.tool_call_preview { phase: "started" }
agent.tool_call_preview { phase: "arguments_delta" }
agent.tool_call_preview { phase: "arguments_snapshot" }
agent.message_done?        # if text was also streamed before the tool
agent.message?             # if intermediate assistant text is persisted
agent.tool_call            # authoritative final call
agent.tool_result          # persisted tool row
```

For a response with multiple tool calls, previews should preserve provider output order by the same ordering index already used in `AgentModelRunner`. Execution can remain serial after the model call completes, matching current behavior.

Replay rules:

- preview events are replayable only within the existing bounded runtime buffer
- preview events are not durable transcript rows
- if a resume cursor is too old, clients should refetch `/messages` and `/agent/state`
- if `/agent/state.draft_tool_call` is adopted, it is the current best-effort partial state after resync
- final persisted transcript correctness does not depend on preview replay

---

## 11. Failure And Cleanup

Preview cleanup should be explicit enough that clients do not leave stale assembling rows.

Expected cases:

- Final normalized tool call succeeds: final `agent.tool_call` with the same `client_id` upgrades the preview.
- Tool call is unknown or unsupported: emit `agent.tool_call_preview` with `phase: "discarded"` if a preview was previously emitted.
- Tool arguments fail validation: final turn failure should remove draft rows for that turn; a `discarded` preview is cleaner if the failure is localized.
- Agent cancel: `final { status: "canceled" }` clears draft tool previews for that turn.
- Provider stream error: `final { status: "failed" }` clears draft tool previews for that turn.

For `ask_user_questions`, do not enter `waiting_for_user` until the durable question request row exists. Preview state should use a separate phase such as `streaming_tool_call` or a `draft_tool_call` field; it should not reuse `pending_tool`.

---

## 12. Pros

- Better perceived latency for long tool calls.
- Makes `ask_user_questions` feel like it is being composed live instead of appearing all at once.
- Uses provider stream capabilities Bud already normalizes internally.
- Keeps final tool execution and transcript semantics stable.
- Gives mobile and web a richer optional UI without forcing a backend grouped-row contract.
- Can improve diagnostics for provider output stalls because the service can log/emit bounded assembly progress.

## 13. Cons

- Adds another live stream state clients must reconcile.
- Partial JSON is hard to parse and easy to overpromise.
- Preview rows may be wrong, incomplete, or later discarded.
- `/agent/state` may need another field for robust refresh behavior.
- The service must allocate tool `client_id` earlier than it does today.
- Tests need to cover provider chunk boundaries, malformed partial payloads, reconnect replay, and final replacement.
- There is some bandwidth cost if deltas or snapshots are emitted too frequently.

---

## 14. Implementation Sketch

Backend changes:

1. Add service-owned in-progress tool assembly state inside `AgentModelRunner.invokeModel(...)`.
2. On `tool_use_start`, map known provider tool names to client tool names and allocate a `client_id`.
3. Emit `agent.tool_call_preview` through `AgentRuntimeStateManager` from the model-runner loop.
4. Accumulate argument text per tool index.
5. Run optional tool-specific preview extraction, initially for `ask_user_questions`.
6. Include the allocated `client_id` on completed agent tool directives returned to `AgentService`.
7. Update `AgentService` to reuse a model-runner-provided tool `client_id` instead of always generating one immediately before final `agent.tool_call`.
8. Optionally add `draft_tool_call` to `AgentRuntimeStateManager` snapshots.
9. Keep `AgentTranscriptWriter.emitToolCall(...)` as the final authoritative event boundary.

Web changes:

1. Parse `agent.tool_call_preview` in `useAgentStream`.
2. Add a draft-tool synthetic row builder keyed by `client_id`.
3. For `ask_user_questions`, render preview snapshots as disabled forms.
4. Replace the draft row on final `agent.tool_call`.
5. Clear draft rows on final, cancel, failure, or discard.

iOS changes:

1. Treat preview as optional.
2. Key draft preview rows by `client_id` when present.
3. Render `ask_user_questions` preview as read-only until final `agent.tool_call`.
4. Fall back cleanly when preview events are absent.

Docs and specs:

- `docs/proto.md` for `agent.tool_call_preview` and optional `/agent/state.draft_tool_call`
- `service/src/agent/agent.spec.md` for model-runner preview emission and earlier tool `client_id` allocation
- `service/src/runtime/runtime.spec.md` if runtime snapshot shape changes
- `web/src/features/threads/threads.spec.md` for preview parsing and reconciliation
- mobile handoff docs for optional client adoption

---

## 15. Open Questions

1. Should v1 include `/agent/state.draft_tool_call`, or is live SSE plus bounded replay enough?
2. Should the preview event carry raw `argument_delta`, parsed `preview`, or both?
3. What event name best communicates non-authoritative partial state: `agent.tool_call_preview`, `agent.tool_call_delta`, or `agent.tool_call_part`?
4. Should `ask_user_questions` preview ever show submit controls before durable persistence? The recommendation is no.
5. Which parser should the service use for partial JSON: a small streaming tokenizer, a dependency, or a tool-specific parser?
6. How aggressively should preview snapshots be throttled to avoid sending a full growing object on every token?
7. Do we need an explicit `streaming_tool_call` runtime phase, or is `draft_tool_call` presence enough?
8. How should clients visually distinguish "the model is drafting a command/question" from "the tool is running"?
9. Should unknown provider tool names be ignored silently until final validation, or should the service emit a discarded preview for diagnostics?
10. How do we want this to interact with future tools that may contain large code edits, file patches, or generated documents?

---

## 16. Recommendation

Do not change the existing `agent.tool_call` meaning. Add a preview layer in front of it.

The first implementation should be narrow:

- one additive `agent.tool_call_preview` SSE event
- final `agent.tool_call` unchanged and authoritative
- earlier `client_id` allocation in `AgentModelRunner`
- raw argument deltas for all known tools
- structured preview snapshots only for `ask_user_questions`
- no tool execution before the current completed-response boundary
- no canonical transcript persistence for previews

If live-only behavior is not enough after web/iOS experiments, add `/agent/state.draft_tool_call` as the second tranche so refresh and mobile reconnect can reconstruct the current assembling tool call without relying solely on buffered replay.
