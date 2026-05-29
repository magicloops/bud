# Phase 3: Chat Timeline Streaming Cutover

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Stop rendering assistant drafts as plain text and route streaming assistant content through the same Streamdown-backed renderer used by final messages.

By the end of this phase:

- draft assistant rows pass `isStreaming` to the role renderer
- the plain `whitespace-pre-wrap` draft branch is removed
- draft-to-final transition no longer switches renderer families
- file-open source metadata does not pretend a draft row has a durable message id

## Scope

### In Scope

- `web/src/components/workbench/chat-timeline.tsx`
- role renderer prop passing
- draft assistant file-action source handling
- focused verification of `scrollSyncKey` behavior after the cutover

### Out Of Scope

- backend event changes
- replacing assistant activity indicator logic
- broad scroll anchoring changes unless validation proves they are still required
- changing message reconciliation in `useThreadMessages(...)`

## Implementation Tasks

### Task 1: Remove the draft plain-text renderer branch

Current draft behavior:

```tsx
isDraftAssistant ? (
  <div className="whitespace-pre-wrap">
    {message.content}
    <span className="..." />
  </div>
) : RoleContentRenderer ? (
  <RoleContentRenderer content={message.content} fileActions={fileActions} />
) : ...
```

Target behavior:

```tsx
RoleContentRenderer ? (
  <RoleContentRenderer
    content={message.content}
    fileActions={fileActions}
    isStreaming={isDraftAssistant}
  />
) : ...
```

The Streamdown renderer owns streaming mode and draft control state. Bud does not pass Streamdown `animated` or `caret` props in the current v1 so fast model deltas remain visually calm.

### Task 2: Keep draft metadata semantics

Keep `isDraftAssistant = message.role === 'assistant' && message.metadata?.draft === true`.

That metadata still drives:

- activity-indicator suppression
- synthetic-row cleanup
- visual streaming mode

Do not change `/agent/state` overlay behavior in this phase.

### Task 3: Protect draft file-open source metadata

Current `fileActions.source` includes both `message_id` and `client_id`. Draft assistant rows use `message_id = client_id`, which is not a durable DB message id.

For draft rows:

- include `source.kind = "assistant_message"`
- include `client_id`
- omit `message_id`

For persisted assistant rows:

- include both `message_id` and `client_id`

This lets users open files from drafts if the candidate is already visible, while avoiding false historic source-message context lookup on the backend.

### Task 4: Verify final replacement path remains stable

`useThreadMessages.applyAssistantMessageEvent(...)` removes draft rows for the turn and upserts the canonical assistant row. This phase should not need to change that reducer.

After cutover, the visual transition should be:

```text
Streamdown streaming mode -> Streamdown static mode
```

not:

```text
plain text -> markdown renderer
```

### Task 5: Watch scroll sync behavior

The existing `scrollSyncKey` still keys on message count, last `client_id`, last content length, and activity footer state.

Renderer unification should reduce the main height delta, but plugin block completion can still change height. Do not add resize-driven scroll anchoring in this phase unless the cutover still leaves a clear bounce during validation.

If bounce remains, capture a follow-up against `ChatTimeline` resize anchoring instead of mixing it into this renderer migration.

## Validation Checklist

- [ ] draft assistant rows render through `RoleContentRenderer`
- [ ] draft assistant rows pass `isStreaming={true}`
- [ ] persisted assistant rows pass `isStreaming={false}` or omit it
- [ ] draft rows no longer use `whitespace-pre-wrap`
- [ ] Streamdown streaming mode appears for draft assistant messages without text-reveal animation, caret chrome, or delayed word reveal
- [ ] final persisted row keeps the same visible markdown renderer family
- [ ] draft file opens omit synthetic `message_id`
- [ ] persisted file opens include durable `message_id`
- [ ] existing assistant activity indicator suppression still works
- [ ] message copy button still copies raw message content

## Exit Criteria

This phase is done when streaming assistant content and final assistant markdown share the Streamdown-backed render path in the chat timeline.
