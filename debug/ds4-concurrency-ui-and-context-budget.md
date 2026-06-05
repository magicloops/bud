# Debug: ds4 concurrent request UI and context budget warning

## Environment
- Local service + web development environment on macOS.
- Bud daemon connected to the local service over WebSocket.
- Bud-local ds4 exposed through the `local_llm_http` data plane.
- ds4 server already running on the Bud machine.

## Repro Steps
1. Configure a Bud daemon with healthy Bud-local ds4 capability.
2. Select `ds4-deepseek-v4-flash` in the web UI.
3. Start one long-running ds4-backed agent turn.
4. Start a second agent turn while the first Bud-local LLM stream is active.

## Observed
- The backend protects the in-progress request and rejects the second local LLM open:
  - error type: `BudLocalLlmUnavailableError`
  - code: `DATA_PLANE_STREAM_LIMIT_EXCEEDED`
  - message: `Bud already has 1 active local_llm_http stream(s)`
  - retryable: `true`
- The web UI did not show that backend failure clearly to the user.
- The same turn logs a context-budget warning:
  - `Context compaction budget policy is invalid`
  - `contextWindowTokens: 100000`
  - `reservedOutputTokens: 128000`
  - `usableInputWindowTokens: null`

## Expected
- A rejected second request should be visible in the thread UI without interrupting the first request.
- The user should have enough information to retry after the active local model request finishes.
- ds4 model metadata should resolve to a valid context policy.

## Findings
- The concurrency guard itself is behaving correctly. The service enforces one active `local_llm_http` stream per Bud and rejects the second request before opening another daemon stream.
- The agent failure path emits a `final` SSE event with `status: "failed"` and the raw error message, then finishes the runtime turn. It does not currently write a durable transcript row for async provider-start failures.
- The web stream hook does handle failed `final` events by setting route error state. That error state is transient UI state, not transcript state.
- There is a likely race after message send: the route refreshes `/agent/state`, updates the stream cursor, and reconnects the stream. If the failure completed very quickly, the failed `final` event can already be behind the refreshed idle cursor. Without a durable message or sticky runtime error, there may be nothing visible left to render.
- The context warning is independent of concurrency. The ds4 catalog entry currently has a 100k context window and a 128k max output token value. The context policy defaults `reservedOutputTokens` to `maxOutputTokens`, so the computed input budget is invalid.
- The agent also uses the global `AGENT_MAX_OUTPUT_TOKENS` value for provider requests. That global default is 128k, which is appropriate for cloud frontier models but not necessarily for ds4.

## Fix Options

### Option A: Durable Generic Failure Transcript Row
Record a generic failed assistant transcript row for non-cancel agent failures, then emit the normal `agent.message` and failed `final` event through the existing transcript/runtime path.

Pros:
- Robust across missed SSE events, refreshes, and service restarts.
- No ds4 or Bud-local special casing.
- Low browser code footprint because `agent.message` is already handled.
- Gives every async agent failure a visible thread artifact.

Cons:
- Needs careful user-facing error text sanitization so provider internals and credentials are never exposed.
- Existing `recordFinalAssistant(...)` also stamps assistant-completed attention and push metadata, which may be undesirable for failure rows unless adjusted generically.

### Option B: Sticky Generic Runtime Error Snapshot
Add a generic `last_error` or `last_turn_error` field to `/agent/state`, set it on failed turns, and clear it on the next turn or successful user send.

Pros:
- No transcript persistence changes.
- Fixes the post-send refresh race because the route already refetches `/agent/state`.
- Provider agnostic.

Cons:
- Error disappears across service restart.
- Adds a new browser API field and rendering path.
- Less useful historically because the transcript does not show what happened.

### Option C: Frontend Bootstrap Refetch on Fast Idle
After `POST /messages`, if the refreshed `/agent/state` is already idle for the returned `stream_cursor`, also refetch `/messages` immediately.

Pros:
- Small UI change.
- Helps with fast success/failure races where durable messages already exist.

Cons:
- Does not solve failures that have no durable transcript row.
- Still relies on transient failed `final` events for async failures.
- More of a race mitigation than a root-cause fix.

### Option D: Generic Model Output Cap Resolution
When building `ModelConfig`, derive request `maxOutputTokens` from the selected provider/model capabilities, e.g. `min(AGENT_MAX_OUTPUT_TOKENS, provider.getModelCapabilities(model).maxOutputTokens)`.

Pros:
- Provider agnostic.
- Prevents all providers from receiving request caps above their advertised capabilities.
- Reduces mismatch between catalog metadata, context budgeting, and actual requests.

Cons:
- Does not by itself fix the ds4 invalid context policy if the ds4 catalog remains `maxOutputTokens: 128000`.
- Needs tests across OpenAI, Anthropic, and ds4 request construction.

### Option E: Correct ds4 Catalog Context Policy
Set ds4 catalog metadata to a valid policy, either by lowering `maxOutputTokens` or by adding an explicit `reservedOutputTokens` that is below the 100k context window.

Pros:
- Directly fixes the invalid context-budget warning.
- Very small code change.
- Keeps policy explicit where model metadata already lives.

Cons:
- Catalog-only correction can diverge from actual provider requests unless paired with Option D or config changes.
- Picking the reserve value is a product/runtime decision.

### Option F: Clamp Invalid Context Policies
Teach the context-policy resolver to clamp `reservedOutputTokens` when it exceeds the usable context window.

Pros:
- Defensive against bad model metadata.
- Provider agnostic.

Cons:
- Hides invalid catalog/configuration data instead of correcting it.
- Makes budget behavior less transparent and can create surprise request sizes.
- Higher technical debt than fixing the source metadata.

## Recommended Path
1. Implement Option A with a generic failure-message helper and no provider-specific branches. If notification semantics are a concern, add a small transcript-writer path for failed assistant rows that emits `agent.message` and `final` but does not enqueue an assistant-completed push.
2. Optionally add Option C as a small race hardening step, because it is useful even for very fast successful turns.
3. Implement Option E for ds4 metadata, paired with Option D so actual provider requests respect selected-model capability limits.

This keeps the concurrency behavior provider-agnostic: local ds4 is just one provider that can fail before producing output, and the UI should make any non-cancel agent failure visible through the same durable path.
