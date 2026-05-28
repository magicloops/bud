# Design: Terminal Freshness Hints

Status: Implemented initial service pass

Audience: Backend, agent runtime, web, iOS

Last updated: 2026-05-28

Related docs:

- [design/terminal-context-sync.md](./terminal-context-sync.md)
- [design/offline-bud-agent-turns.md](./offline-bud-agent-turns.md)
- [review/bud-offline-roundtrip-review.md](../review/bud-offline-roundtrip-review.md)

## 1. Goal

Make normal user-to-assistant message sends faster by removing the default request-time `terminal_observe` roundtrip from the message-send path.

Instead of preemptively inspecting the Bud terminal before the first agent LLM call, the service should cheaply detect that terminal state may have changed and tell the model to call `terminal.observe` only if the current terminal state matters.

The desired product behavior is:

- conversational turns stay snappy
- terminal-heavy agent turns can still take longer when they need tools
- the model is warned when previous terminal context may be stale
- the service does not claim concrete terminal facts it has not observed

## 2. Background

The older terminal context-sync design added a preflight check before processing a user message:

1. capture current terminal state through the Bud
2. compare it with the last known snapshot
3. optionally call a small LLM to summarize the change
4. insert a context message before the user's message

That solves one real problem: terminal state can change out-of-band between agent turns. A command may finish, the user may type in the browser terminal, a TUI may exit, or a reconnect may change session state.

The cost is that every eligible user message can pay for a Bud roundtrip before the primary agent model call, and sometimes also an extra summary LLM call. In practice, many user messages are conversational and do not need current terminal state. Existing terminal-heavy conversations also often have a recent `terminal.send` or `terminal.observe` result already in model history.

Offline Bud mode already points at the better product shape: the agent should be able to start without terminal availability, and Bud-specific tools should be used only when the turn actually needs device state.

## 3. Decision

Default behavior should change from:

```text
Before every eligible user message, observe the terminal if the Bud is online.
```

to:

```text
Before every user message, do not observe the terminal by default.
If cheap service-side state says terminal state may have changed since the last model-visible terminal result, add an advisory freshness hint to the model context.
Let the model call terminal.observe when terminal freshness matters.
```

The hint is advisory but should be phrased as an observe-first rule for terminal-dependent claims/actions.

Example model instruction:

```text
Terminal freshness notice: terminal activity may have changed since the last model-visible terminal result. The service did not inspect the current terminal state before this response. If your answer or next action depends on the current terminal, call terminal.observe before making device-specific claims or acting on terminal state.
```

If the Bud is offline, the existing offline environment instruction remains the stronger constraint: terminal tools are unavailable and the assistant must not claim current device state.

## 4. Goals

- Remove request-time Bud `terminal_observe` from the common `POST /messages` path.
- Avoid request-time context-summary LLM calls in the common path.
- Preserve a clear signal to the model when terminal history may be stale.
- Keep concrete terminal content in the transcript only when the system actually observed it through a terminal tool or send result.
- Use service-owned state that is already updated by terminal output, status, input, and tool-result flows.
- Keep the browser and mobile API contract stable unless a later UI chooses to expose freshness state.
- Keep ownership checks unchanged: terminal freshness is scoped through the authorized thread/session, never through raw client-provided IDs.

## 5. Non-Goals

- Perfect stale-terminal detection.
- Persisting every out-of-band terminal change as a transcript message.
- Removing `terminal.observe`.
- Preventing the model from ever needing an extra tool/model loop.
- Changing the Bud daemon wire protocol in the first phase.
- Introducing a classifier LLM to decide whether a user message is terminal-relevant.

## 6. Current Behavior To Replace

Before the freshness implementation, online message-send behavior could do this before the user message was inserted:

1. resolve the Bud environment
2. find the thread's open terminal session
3. if the Bud is online and no agent is active, call context sync
4. context sync calls `capturePane(...)`
5. `capturePane(...)` sends `terminal_observe` to the Bud
6. context sync may call a summary LLM and insert a system/context message
7. only then does the route persist the user message and start the agent turn

Offline mode skips the observe path, which means online mode is currently slower than offline mode for existing-session threads even when the terminal is irrelevant to the user message.

## 7. Proposed Contract

### 7.1 Terminal Freshness State

The service should track whether model-visible terminal evidence is older than known terminal activity.

Useful service-side signals:

- latest persisted terminal output byte offset for the session
- `terminal_session.last_activity_at`
- `terminal_session.output_log_bytes`
- latest daemon terminal status/readiness timestamp
- latest cached `cwd` update
- latest human-origin terminal input log
- latest model-visible terminal tool result for the thread/session
- latest injected terminal context snapshot, while the old context-sync path exists

The first durable implementation should prefer one unified watermark over multiple independent freshness pathways:

```typescript
type TerminalFreshnessState = {
  session_id: string;
  current_output_log_bytes: number | null;
  current_cwd: string | null;
  current_readiness_version: string | null;
  last_model_visible_output_log_bytes: number | null;
  last_model_visible_cwd: string | null;
  last_model_visible_readiness_version: string | null;
  last_model_visible_at: string | null;
  last_terminal_activity_at: string | null;
  last_human_input_at: string | null;
  last_status_at: string | null;
  dirty: boolean;
  reasons: Array<
    | "new_output"
    | "human_input"
    | "status_changed"
    | "cwd_changed"
    | "unknown_watermark"
  >;
};
```

This state is internal. It should not be sent to the model as offsets or implementation detail.

`cwd` and readiness/context changes should participate in the same freshness decision as output bytes. They should not become separate prompt-injection pathways. The service should compare the current session watermark with the last model-visible terminal watermark, then produce one freshness hint if any relevant field is newer or different.

### 7.2 Model-Visible Watermark

When the agent persists a terminal tool result, the transcript metadata should record enough information to know what terminal state became model-visible.

Suggested metadata shape on tool result messages:

```json
{
  "tool": "terminal_observe",
  "terminal_visibility": {
    "session_id": "bud-...-thread-...",
    "observed_output_log_bytes": 123456,
    "observed_at": "2026-05-28T18:44:21.000Z",
    "source": "terminal_observe"
  }
}
```

`terminal.send` should also record this metadata when its result includes model-visible terminal output or readiness/context evidence. The source can be `"terminal_send"`.

Even when `terminal.send` produces no visible output, it should still advance the model-visible watermark if the tool result showed readiness, context, cwd, dispatch state, or another terminal fact to the model. The model has just learned something about the terminal. If output bytes change after that point, the unified freshness comparison will mark the terminal dirty again.

If the current terminal tool result does not have an authoritative output offset yet, the first phase may use the session's current `output_log_bytes` at result-persist time. That is less exact than a result-specific end offset but still better than observing the Bud preemptively.

### 7.3 Freshness Hint

If `dirty === true`, add a transient instruction to the model before the provider call.

The hint should:

- say terminal activity may have changed
- say the service did not inspect current terminal state
- tell the model to call `terminal.observe` before terminal-dependent claims/actions
- avoid including output offsets, internal timestamps, or guessed terminal content
- avoid being persisted as a normal transcript message by default

Recommended text:

```text
Terminal freshness notice: terminal activity may have changed since the last model-visible terminal result. The service did not inspect the current terminal state before this response. If your answer or next action depends on the current terminal, call terminal.observe before making device-specific claims or acting on terminal state.
```

If the dirty reason is specifically human input, the service may use a slightly stronger variant:

```text
Terminal freshness notice: human terminal input was recorded after the last model-visible terminal result. The service did not inspect the current terminal state before this response. If your answer or next action depends on the current terminal, call terminal.observe first.
```

### 7.4 Clean State

If `dirty === false`, do not add a freshness hint and do not observe the terminal.

Clean means the latest known service-side terminal activity is not newer than the latest model-visible terminal evidence. It does not mean the terminal is guaranteed unchanged; it means the service has no cheap evidence that the model's terminal context is stale.

### 7.5 Offline Bud State

If the environment is `bud_offline`:

- do not calculate freshness by contacting the Bud
- do not add a hint that tells the model to call `terminal.observe`, because the tool is unavailable
- keep the existing offline instruction and Bud-specific tool filtering

The model can be told that current terminal state is unavailable through the offline environment instruction.

## 8. Agent Flow

Implemented send flow:

```text
POST /api/threads/:thread_id/messages
  authorize thread
  resolve model selection
  handle client_id idempotency
  resolve Bud environment
  persist user message
  start agent turn with environment

runAgentFlow
  load conversation
  maybe compact context
  refresh environment before provider step
  compute terminal freshness from DB/runtime state only
  apply offline instruction if needed
  apply terminal freshness hint if needed
  invoke primary model
```

Important: freshness computation must not send `terminal_observe`, `terminal_ensure`, or any other daemon request.

After the model calls `terminal.observe` or `terminal.send`, the persisted tool result becomes the new model-visible terminal evidence. The next provider step in the same turn should not keep repeating the stale hint unless additional terminal activity happened after that tool result.

## 9. Persistence Strategy

Prefer no new table for the first implementation.

Use existing rows:

- `terminal_session.output_log_bytes` and activity fields for current session state
- `terminal_session_input_log` for human-origin input timing
- `message.metadata.terminal_visibility` on terminal tool results for last model-visible evidence
- existing terminal/session status handling for cached cwd/status changes

If this becomes expensive to derive from message history, add a small service-owned cache table later:

```typescript
type TerminalContextWatermark = {
  thread_id: string;
  session_id: string;
  last_model_visible_output_log_bytes: number | null;
  last_model_visible_at: Date | null;
  last_notice_at: Date | null;
  updated_at: Date;
};
```

That table would be an optimization, not a product contract.

## 10. Prompt Placement

The freshness hint should be injected as transient provider context, similar in spirit to the offline environment instruction.

Preferred placement:

- near the system/developer instructions for the current provider request
- after the base Bud tool contract
- before the latest user message is interpreted

Avoid storing the hint as a `system` message unless the service has concrete observed terminal content to preserve. A dirty flag is not transcript evidence; it is a warning about uncertainty.

## 11. API And UI Impact

No browser or mobile API change is required for the first phase.

The `POST /messages` response, `/agent/state`, and agent SSE stream can stay unchanged. The behavior change is internal to the service and model prompt context.

Optional future UI/debug fields:

- `agent.state.environment.terminal_freshness = "clean" | "may_have_changed" | "unknown"`
- debug-only stream event when a freshness hint is applied
- internal metrics exposed through logs rather than user UI

Do not block this design on UI adoption.

Mobile and web should not expose freshness state in the first implementation. Keep it internal until there is a concrete debugging or product need.

## 12. Metrics

Add logs or counters for:

- message-send latency before/after removing preflight observe
- count of skipped preflight context syncs
- count of freshness hints added
- freshness dirty reasons
- rate of `terminal.observe` calls on the first provider step after a freshness hint
- rate of terminal-dependent failures or stale-state corrections after removing preflight observe
- context compaction frequency before/after, because fewer persisted context-sync messages should reduce transcript pressure

These metrics should make the tradeoff visible: lower fixed latency vs occasional extra tool/model loop.

## 13. Rollout

Phase 1: disable preflight observe by default

- Implemented: `POST /messages` no longer calls context sync or `terminal_observe` for normal user sends.
- Implemented: `runAgentFlow` computes a transient freshness hint from service-side terminal/session/message state before provider calls.

Phase 2: add terminal visibility metadata

- Implemented: `message.metadata.terminal_visibility` is persisted for `terminal.observe` and `terminal.send` results.
- Implemented: dirty state compares output bytes, cwd, readiness version, and human input timing against the latest model-visible terminal watermark.
- Implemented: focused helper tests cover clean vs dirty hint behavior.

Phase 3: retire preflight summary injection

- Implemented: the context-sync summary LLM is no longer reachable from the normal message-send route.
- Remaining: `ContextSyncService.refreshSnapshot(...)` is still used after state-changing terminal tools to keep legacy snapshots and pending-command cleanup aligned.
- Implemented: old design docs/specs mark the preflight approach superseded for normal sends.

## 14. Validation

Backend tests:

- online thread with no terminal session: no observe, no freshness hint
- online thread with clean terminal session: no observe, no freshness hint
- online thread with output after last terminal tool result: no observe, freshness hint added
- online thread with human terminal input after last terminal tool result: no observe, stronger freshness hint added
- offline Bud: no observe, no terminal freshness hint, offline instruction/tool filtering still apply
- first terminal tool result after hint clears the hint for the next provider step unless new output arrives
- duplicate `client_id` retry does not compute or persist extra freshness state
- authorization prevents freshness lookup for another user's thread/session

Manual validation:

- rapid chat back-and-forth with an idle terminal feels faster
- user asks a general question after terminal output changes; agent can answer without observing if terminal state is irrelevant
- user says "what happened?" after terminal output changes; agent observes before answering
- user manually exits a TUI; next terminal-dependent request observes before sending shell/TUI input
- Bud offline send still produces an offline-aware assistant response

## 15. Risks

Model ignores the hint.

Mitigation: phrase the hint as an observe-first instruction for terminal-dependent claims/actions. Track whether stale-state failures increase. Consider a narrow forced-observe policy later for specific validated failure classes.

False positives add prompt noise.

Mitigation: keep the hint short and transient. Prefer precise watermark reasons over broad timestamps as metadata improves.

False negatives allow stale reasoning.

Mitigation: record terminal visibility metadata consistently and treat unknown watermarks conservatively until enough evidence exists.

Transcript continuity changes.

Mitigation: this is intentional. Do not persist unobserved terminal guesses. Persist concrete terminal content only when observed through tool results.

Cross-process freshness can be incomplete.

Mitigation: derive from DB-backed terminal output/session/input rows rather than only in-memory runtime state.

## 16. Resolved Design Questions

- A `terminal.send` result with no visible output should still advance the model-visible terminal watermark when readiness/context/cwd/dispatch facts are shown to the model.
- Cached cwd changes should be part of the unified watermark and can make the terminal dirty, but should not create a separate freshness-trigger pathway.
- No separate user-message classifier is needed for phrases like "continue" or "what happened." The model hint and existing tool-call context should be enough.
- Freshness state stays internal for web and mobile in the first implementation.
- No rollback flag is needed while the product is still in active development.
