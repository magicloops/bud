# Design: Assistant Activity Indicator Visibility

Status: Draft

Created: 2026-05-28

Audience: Web, backend

Related:
- [../web/src/routes/$budId/$threadId.tsx](../web/src/routes/$budId/$threadId.tsx)
- [../web/src/features/threads/use-agent-stream.ts](../web/src/features/threads/use-agent-stream.ts)
- [../web/src/features/threads/use-thread-messages.ts](../web/src/features/threads/use-thread-messages.ts)
- [../web/src/features/threads/thread-message-state.ts](../web/src/features/threads/thread-message-state.ts)
- [../web/src/components/workbench/chat-timeline.tsx](../web/src/components/workbench/chat-timeline.tsx)
- [../web/src/components/workbench/thinking-indicator.tsx](../web/src/components/workbench/thinking-indicator.tsx)
- [../service/src/runtime/agent-runtime-state.ts](../service/src/runtime/agent-runtime-state.ts)
- [../service/src/agent/model-runner.ts](../service/src/agent/model-runner.ts)
- [../service/src/agent/transcript-writer.ts](../service/src/agent/transcript-writer.ts)
- [./streaming-tool-call-assembly.md](./streaming-tool-call-assembly.md)
- [./thinking-indicator.md](./thinking-indicator.md)
- [./thinking-indicator-v2.md](./thinking-indicator-v2.md)

---

## 1. Summary

The chat timeline now renders the thinking indicator below the newest transcript item, which fixes the previous overlap problem. The remaining UX issue is visibility: the indicator is tied to the coarse workbench `streaming` status, so it appears even while assistant text is visibly streaming.

The smallest client-side-first direction is to keep using the current workbench/SSE flow, but add one local suppression rule:

> Show the indicator while the workbench is streaming, except while assistant text is actively streaming into a draft message.

That avoids new backend contracts and avoids coupling backend phase names to frontend presentation. It should be implemented as a local timeline indicator gate driven by existing events:

- `agent.message_start` / `agent.message_delta` hide the indicator
- `agent.message_done` schedules the indicator to return after a short grace window, if the turn is still active
- `agent.message` / `final` cancel the return when the completed message is final
- `agent.compaction_start` still overrides with `Compacting context...`

The fuller runtime-phase-derived model remains a possible future cleanup, but it is not needed for the first patch.

---

## 2. Current Implementation

### Web state

`web/src/routes/$budId/$threadId.tsx` owns a single `status: WorkbenchStatus` state:

```ts
type WorkbenchStatus = 'idle' | 'dispatching' | 'streaming' | 'waiting_for_user'
```

The route currently renders the timeline indicator with:

```tsx
activityIndicatorVisible={status === 'streaming' || activeCompaction !== null}
activityIndicatorLabel={activeCompaction ? 'Compacting context...' : undefined}
```

This is the core mismatch. `status === 'streaming'` means "an agent turn is active and not waiting for user input", not "the UI needs a loading indicator".

`getStatusFromAgentState(...)` collapses all active non-waiting runtime phases into `streaming`:

```ts
if (!agentState.active) return 'idle'
if (agentState.phase === 'waiting_for_user' || agentState.pending_tool?.name === 'ask_user_questions') {
  return 'waiting_for_user'
}
return 'streaming'
```

As a result, these very different backend phases all look identical to the timeline:

- `starting`
- `thinking`
- `tool_running`
- `streaming_message`

### SSE handling

`useAgentStream(...)` also updates the same coarse status for multiple event types:

| Event | Current status behavior | Visible timeline behavior |
|-------|--------------------------|----------------------------|
| `agent.tool_call` | `streaming`, or `waiting_for_user` for `ask_user_questions` | pending tool row is inserted |
| `agent.tool_result` | no direct status update | persisted tool row is inserted |
| `agent.message_start` | `streaming` | draft assistant row starts |
| `agent.message_delta` | `streaming` | draft assistant row appends text |
| `agent.message_done` | no direct status update | draft assistant row finalizes locally |
| `agent.message` | no direct status update | persisted assistant row replaces draft |
| `agent.compaction_start` | `streaming` | compaction label shown via `activeCompaction` |
| `final` | `idle` | synthetic rows are cleared |

The message state layer already knows about visible synthetic rows:

- `draft_assistant` from `agent.message_*` and `/agent/state.draft_assistant`
- pending tool rows from `agent.tool_call` and `/agent/state.pending_tool`
- persisted rows from `agent.message` and `agent.tool_result.message`

The indicator currently does not use that distinction.

### Backend runtime state

The backend already exposes a more precise runtime phase in `/agent/state`:

```ts
type AgentRuntimePhase =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'tool_running'
  | 'waiting_for_user'
  | 'streaming_message'
```

Important transitions:

- `startTurn(...)` sets `starting`.
- `runAgentFlow(...)` calls `markThinking(...)` before provider calls.
- `setDraftAssistant(...)` sets `streaming_message` when assistant text is being drafted.
- `emitToolCall(...)` sets `tool_running`, or `waiting_for_user` for `ask_user_questions`.
- `recordToolResult(...)` emits `agent.tool_result` and then `markThinking(...)`.
- `recordAssistantTextSegment(...)` and `recordFinalAssistant(...)` emit `agent.message` and clear the draft back to `thinking`.
- `final` followed by `finishTurn(...)` returns the runtime to `idle`.
- compaction events are emitted as agent events and mark the runtime as `thinking`.

That phase model is a good source for bootstrap and reconnect behavior. The frontend mostly loses the distinction when it maps everything into `WorkbenchStatus`.

---

## 3. Desired UX

The timeline indicator should show when the agent is active and the chat area would otherwise appear still.

Show the indicator:

- after a user message starts an assistant turn, before assistant text begins streaming
- while `/agent/state.phase` is `starting` or `thinking`
- after a tool result lands while the agent is preparing the next provider call
- after an intermediate assistant message finishes, if the turn continues and no next visible item has appeared yet
- during context compaction, with the explicit `Compacting context...` label
- after resync/bootstrap if the active snapshot has no visible streaming assistant row and no user-question wait

Hide the indicator:

- while assistant text is visibly streaming into a draft assistant row
- while a pending `ask_user_questions` form is waiting for the user
- after `final`
- when the thread is idle
- during normal pending tool execution if the pending tool row itself is the visible activity

The tool-running case can stay aligned with today's coarse `streaming` behavior in the first pass. If the workbench still says `streaming` and assistant text is not actively streaming, the generic indicator may show below the tool row. That is acceptable for a small client-only change and can be refined later with tool-row-specific progress.

---

## 4. Client-Side-Only V1

Do not change backend SSE events, `/agent/state`, or runtime phases.

Keep a small local state in the thread route or a tiny hook:

```ts
type AssistantTextStreamGate = {
  suppressIndicator: boolean
  activeTurnId: string | null
}
```

Then derive the timeline prop from current UI state:

```ts
const activityIndicatorVisible =
  activeCompaction !== null ||
  (status === 'streaming' && !assistantTextStreamGate.suppressIndicator)
```

Optionally include `status === 'dispatching'` if we want the footer indicator during the POST/send gap. The smallest behavioral change can leave dispatching alone and only fix the visible-streaming problem.

The route can continue passing `status` unchanged to:

- `WorkspaceShell`
- `CommandComposer`
- `ThreadTerminalPane`
- cancel handling

The route would pass the new derived state to `ChatTimeline`:

```tsx
<ChatTimeline
  activityIndicatorVisible={timelineActivity.visible}
  activityIndicatorLabel={timelineActivity.visible ? timelineActivity.label : undefined}
  ...
/>
```

This keeps the existing placement fix intact: the indicator remains a timeline footer, below the newest transcript item, but visible assistant text streaming temporarily suppresses it.

---

## 5. Event Rules

### Initial load, bootstrap, and resync

Seed the suppression gate conservatively from data the frontend already receives:

| Bootstrap condition | Gate |
|---------------------|------|
| `agentState.draft_assistant` exists | suppress indicator |
| no draft assistant | do not suppress indicator |
| active compaction in route state | force visible with compaction label |

This avoids depending on exact backend phase names. It uses `draft_assistant` only because the frontend already projects it into a visible draft row.

### Live SSE events

Recommended event transitions:

| Event | Timeline activity |
|-------|-------------------|
| successful message send / active bootstrap | no suppression unless a draft assistant already exists |
| `agent.message_start` | suppress indicator immediately for that `turn_id` |
| `agent.message_delta` | keep suppressing and refresh active streaming turn |
| `agent.message_done` | schedule suppression clear after about 250 ms |
| `agent.message` | if final, cancel scheduled clear and keep suppressed until `final`; if intermediate, allow scheduled clear |
| `agent.tool_call` | no special handling in v1 |
| `agent.tool_result` | no special handling in v1 |
| `agent.compaction_start` | visible with `Compacting context...` |
| `agent.compaction_done` / `agent.compaction_failed` | clear compaction override and return to normal gate |
| `final` | cancel scheduled clear, reset suppression for the next turn |
| `agent.resync_required` recovery | reseed from fetched bootstrap state |

The grace window should be around 250 ms. It prevents a distracting flash when the backend emits `agent.message_done`, `agent.message`, `agent.tool_call`, and `final` close together.

### Why a grace window is useful

Backend event ordering can create very short silent gaps:

```text
agent.message_done
agent.message
agent.tool_call
```

or:

```text
agent.message_done
agent.message
final
```

Showing the indicator immediately after `message_done` would flicker in those cases. Delaying the re-show lets the next visible transcript item or the final event win.

### Final detection

`agent.message_done` does not say whether the draft text will become an intermediate or final assistant row. The client can infer that from the later `agent.message` payload when the persisted row is included.

Current assistant rows include metadata such as:

- `segment_kind: "intermediate" | "final"`
- `assistant_phase: "commentary" | "final_answer"`
- `followed_by_tool_call: true` for intermediate text before a tool

V1 should treat a persisted assistant message as final when either of these is true:

```ts
message.metadata?.segment_kind === 'final' ||
message.metadata?.assistant_phase === 'final_answer'
```

If a final `agent.message` arrives before the 250 ms timer fires, cancel the timer and keep the indicator hidden until the `final` event sets `status` to `idle`.

If no canonical `agent.message` has arrived by the time the timer fires and `status` is still `streaming`, it is reasonable for v1 to show the indicator again. The residual risk is a brief flicker if final persistence takes longer than the grace window; that can be tuned without changing backend contracts.

---

## 6. Known Limitation: Silent Tool-Argument Assembly

There is one gap the web client cannot perfectly model today.

`AgentModelRunner.invokeModel(...)` emits assistant text deltas as they arrive, but it does not emit provider tool-call assembly progress. It emits the final `agent.message_done` only after the provider response completes. If a provider streams visible assistant text first and then spends time assembling tool-call arguments, the frontend may still see an active `draft_assistant` but no new text deltas.

There are three options:

1. Treat the open draft assistant as "still streaming" and keep the indicator hidden until `agent.message_done`.
2. Add a quiet-time heuristic: if no `agent.message_delta` arrives for a threshold such as 750-1000 ms while the turn remains active, show a subtle between-output indicator even though the draft assistant row still exists.
3. Add explicit backend progress for tool-call assembly, as explored in [streaming-tool-call-assembly.md](./streaming-tool-call-assembly.md).

Recommendation for the first implementation: use option 1. It is conservative, simple, and avoids showing two competing activity signals beside an unfinished draft assistant message.

If users still perceive a stall after the last assistant token and before a tool card appears, revisit option 3. That would give clients an explicit `draft_tool_call` or `agent.tool_call_preview` state instead of guessing from token silence.

---

## 7. Implementation Sketch

No product code is changed by this document. A future patch can be scoped to web first.

Suggested web changes:

1. Add route-local refs/state for `suppressActivityIndicator`, `activeAssistantTurnId`, and a `messageDoneTimerRef`.
2. Initialize `suppressActivityIndicator` from `Boolean(initialAgentState.draft_assistant)`.
3. Reset the gate when `threadId` or bootstrap state changes.
4. Wrap the existing `onAssistantMessageStart`, `onAssistantMessageDelta`, `onAssistantMessageDone`, `onAssistantMessageEvent`, and `onFinalizeTurn` handlers to update the gate alongside message state.
5. On `message_start` / `message_delta`, cancel any pending timer and suppress the indicator.
6. On `message_done`, start a 250 ms timer that clears suppression only if the same turn is still current and `status` is still `streaming`.
7. On `agent.message`, cancel the timer if the persisted assistant message is final.
8. On `final`, cancel the timer and clear the gate for the next turn.
9. Keep `ThinkingIndicator` inside `ChatTimeline` as the footer so it remains below the latest timeline item.
10. Let `activeCompaction` override the label and visibility while compaction is active.

---

## 8. Test Plan

Unit tests:

- no draft assistant at bootstrap leaves the indicator unsuppressed
- draft assistant at bootstrap suppresses the indicator
- `agent.message_start` and `agent.message_delta` suppress it
- `agent.message_done` clears suppression after 250 ms when status is still `streaming`
- `agent.message_done` does not clear suppression if status has become `idle`
- final `agent.message` metadata cancels the scheduled clear
- intermediate `agent.message` metadata allows the scheduled clear
- `final` cancels any pending timer and resets the gate
- compaction start overrides the label
- compaction completion returns to the normal gate

Manual scenarios:

- normal text-only answer streams without showing the generic indicator during token output
- tool loop: user message, initial thinking indicator, assistant text hides it, indicator returns after text is done while the turn continues
- `ask_user_questions`: indicator hides once the question card is visible
- context compaction: `Compacting context...` appears and clears after completion/failure
- reconnect during active assistant draft: indicator stays hidden because `draft_assistant` exists

---

## 9. Recommendation

Use the client-side event gate as v1.

For v1:

- keep deriving base visibility from the existing `status === 'streaming' || activeCompaction !== null`
- suppress the indicator during `agent.message_start` / `agent.message_delta`
- clear suppression about 250 ms after `agent.message_done` only if the workbench is still streaming
- cancel that clear if the subsequent persisted assistant message is final
- keep `WorkbenchStatus` unchanged
- avoid backend changes unless the silent tool-argument assembly gap becomes visible enough to justify `agent.tool_call_preview` or a dedicated activity event later

This keeps the fix narrow and frontend-owned: the chat area stops saying "thinking" while text is actively appearing, without requiring the service to expose a frontend-specific activity model.
