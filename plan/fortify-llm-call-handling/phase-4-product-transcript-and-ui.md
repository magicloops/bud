# Phase 4: Product Transcript And UI

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make the browser transcript match what users see while streaming.

Visible assistant text from provider responses should become durable transcript content, including text before a tool call and text between tool calls. Reasoning remains hidden in this branch.

## Scope

### In Scope

- persist visible assistant text segments from mixed text/tool responses
- preserve draft assistant messages when tool calls arrive
- reconcile live streamed text with durable messages by `client_id`
- add metadata that distinguishes intermediate assistant text from final assistant answers
- update first-party web state to avoid removing visible text on tool events

### Out Of Scope

- reasoning display
- grouped turn UI redesign
- mobile-specific presentation work beyond API compatibility
- changing tool row product semantics unless required for ordering

## Service Tasks

1. Add transcript-writer support for assistant text segments that are followed by tool calls.
2. Persist each visible text segment with stable `client_id`.
3. Add metadata such as:
   - `turn_id`
   - `llm_call_id`
   - `provider_output_index`
   - `segment_kind`: `intermediate` or `final`
   - `followed_by_tool_call`
4. Ensure assistant segment rows are owner-stamped and thread metadata updates remain intentional.
5. Decide whether intermediate assistant text should update thread attention/unread metadata. Default should be conservative:
   - visible in transcript
   - not treated as final agent completion
   - not used as the only completion signal
6. Emit a durable message event or include enough data in `agent.message_done` for clients to reconcile draft to persisted row.
7. Ensure `/api/threads/:thread_id/messages` returns intermediate text rows in stable order.

## Web Tasks

1. Stop deleting draft assistant messages when `agent.tool_call` arrives.
2. Reconcile streamed assistant text with the persisted message row when the service confirms it.
3. Keep tool rows and assistant text rows in stream order.
4. Preserve existing rendering for final assistant messages.
5. Add UI state/type support for intermediate assistant text metadata without special visible treatment unless needed.
6. Keep reasoning provider items out of web message types and routes.

## Ordering Contract

For a single turn, product transcript order should match visible provider output order:

1. user message
2. assistant visible text segment if any
3. tool call/tool result rows
4. additional assistant visible text segments if any
5. final assistant visible text segment if any

Provider-only reasoning does not appear in this product sequence.

## Acceptance Criteria

- [ ] Text streamed before a tool call remains visible after refresh.
- [ ] Text streamed between tool calls remains visible after refresh.
- [ ] Tool events no longer remove visible assistant draft rows.
- [ ] Persisted text rows use stable `client_id` reconciliation.
- [ ] Reasoning remains hidden from browser transcript APIs.
- [ ] Thread attention/completion semantics do not regress.

## Risks

| Risk | Mitigation |
|------|------------|
| Intermediate text creates noisy notifications | Add metadata and keep attention updates tied to explicit completion policy |
| Live/durable reconciliation creates duplicate rows | Reuse generated `client_id` from stream start through persistence confirmation |
| Tool rows and text rows interleave incorrectly after refresh | Persist ordering metadata and add refresh/reload tests |
