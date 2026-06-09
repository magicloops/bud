# Debug: ds4 WebSocket stream-limit saturation

## Environment
- Date reviewed: 2026-06-05.
- Service provider path: Bud-local ds4 through the `local_llm_http` data-plane stream.
- Daemon transport: authenticated Bud WebSocket using binary `BudEnvelope` frames as the control and data carrier.
- Reported user-visible error:

```text
The local model is already busy. Try again after the current run finishes.

Error: DATA_PLANE_STREAM_LIMIT_EXCEEDED
```

## Repro Steps
1. Connect a Bud daemon that advertises a healthy local ds4 server.
2. Select the Bud-local ds4 model in a browser thread.
3. Start a long-running ds4-backed agent turn.
4. Before that turn finishes or is canceled cleanly, start another ds4-backed turn for the same Bud, either from another thread or a rapid retry.

Single-turn variant to validate:

1. Use one browser/client and one active thread.
2. Trigger a ds4 agent turn that loops through multiple provider calls and tool executions.
3. Watch for a second Bud-local ds4 open during the same `turn_id`, especially around context compaction, context-window retry, or turn finalization.

## Observed
- The second turn can fail before the provider opens a new daemon stream.
- The service presents the failure as a retryable local-model busy error.
- The report mentions WebSocket saturation, which is plausible, but the code path first maps to an active-stream capacity check rather than a direct socket write failure.
- The reported production case happened inside one agent turn, not from an obvious second browser request. That points away from normal multi-chat contention and toward hidden same-turn model callers, stale stream accounting, or a cleanup race.

## Expected
- One ds4 inference at a time is acceptable if it is an explicit product constraint.
- The service should not leave a Bud-local ds4 stream counted as active after the producing run is canceled, reset, closed, or clearly stale.
- If the WebSocket carrier is backlogged enough to delay stream close/reset handling, the service should surface that carrier health separately from normal local-model concurrency.

## Implementation Review
- [`service/src/llm/local-llm-data-plane.ts`](../service/src/llm/local-llm-data-plane.ts) sets `LOCAL_LLM_MAX_CONCURRENT_STREAMS_PER_BUD = 1` and calls `checkDataPlaneRuntimeStreamCapacity(...)` before sending `local_llm_open`. When that check fails, it throws `BudLocalLlmUnavailableError` with code `DATA_PLANE_STREAM_LIMIT_EXCEEDED`.
- [`service/src/transport/data-plane-router.ts`](../service/src/transport/data-plane-router.ts) counts active runtime streams per Bud and stream family. A stream remains active unless it has a reset reason or both local and remote sides are closed.
- [`service/src/agent/failure-message.ts`](../service/src/agent/failure-message.ts) intentionally maps `DATA_PLANE_STREAM_LIMIT_EXCEEDED` and daemon-side `BUD_BUSY` into the displayed "local model is already busy" message.
- [`bud/src/local_llm.rs`](../bud/src/local_llm.rs) independently enforces one active ds4 stream. If the service-side check did not catch the conflict, the daemon would reject the second open with `BUD_BUSY`.
- [`service/src/ws/bud-connection.ts`](../service/src/ws/bud-connection.ts) registers the WebSocket as a `control_data` data-plane carrier when the hello capabilities advertise healthy ds4. The same WebSocket carries control frames, terminal traffic, and stream data.
- [`service/src/ws/bud-connection.ts`](../service/src/ws/bud-connection.ts) uses `socket.send(..., callback)` for data-plane frames but does not currently check `bufferedAmount` or demote the carrier when the WebSocket output queue grows.
- [`service/src/transport/websocket-daemon-router.ts`](../service/src/transport/websocket-daemon-router.ts) sends control frames onto the Bud WebSocket without visible socket backlog accounting.
- [`service/src/agent/thread-title-service.ts`](../service/src/agent/thread-title-service.ts) does not use ds4 for chat naming. It hardcodes `claude-haiku-4-5`, requests no tools/reasoning, and skips title generation if that Anthropic model is unavailable.
- [`service/src/agent/model-runner.ts`](../service/src/agent/model-runner.ts) awaits each provider stream with `for await (...)` before returning a response to the agent loop. The normal agent model loop is sequential at this layer.
- [`service/src/llm/providers/ds4.ts`](../service/src/llm/providers/ds4.ts) sends `parallel_tool_calls: false` in ds4 Responses requests, so ds4 should not intentionally emit parallel tool batches from that provider path.
- [`service/src/agent/context-compactor.ts`](../service/src/agent/context-compactor.ts) is a hidden same-turn model caller. It uses the selected provider/model for automatic context summaries before or during a turn. However, its current `provider.invoke(...)` call does not pass Bud invocation context, so Bud-local ds4 compaction would throw before opening `local_llm_http`; direct local-dev ds4 compaction could still run outside the Bud data plane.

## Findings
- The displayed error is not a generic WebSocket error. It is the expected service-side refusal once one active `local_llm_http` stream already exists for the Bud.
- The concurrency guard is per Bud, not per thread. Thread-scoped terminals can run in parallel, but Bud-local ds4 currently cannot.
- Chat title generation is probably not the culprit for this report. It is fire-and-forget and parallel with the agent turn, but it is Anthropic-Haiku-only rather than ds4.
- The regular agent LLM loop does not intentionally overlap ds4 provider calls. Each call is awaited before tool execution and before the next provider step.
- Same-turn sequential retries can still create a race if the prior Bud-local stream has logically ended but has not yet been removed from `runtimeStreams` when the next provider open starts.
- Automatic context compaction is the main same-turn hidden LLM path to keep in mind. Today it likely does not open Bud-local ds4 because Bud invocation context is missing, but if that is fixed or if direct ds4 is configured, compaction can become a sequential local-model call immediately before the main agent call.
- WebSocket saturation can still be a contributing cause. If ds4 response data, terminal traffic, or other stream frames build up on the shared WebSocket, the close/reset that frees the runtime stream may be delayed behind queued data.
- Normal cleanup paths look mostly covered. The service removes the runtime stream on local LLM close, reset, abort, and transport finalization. The daemon unregisters streams on completion, reset, total TTL, or transport disconnect.
- The weaker path is stale-stream expiry on the service side. File and proxy data-plane streams use service-owned idle/TTL enforcement, but Bud-local ds4 relies mostly on close/reset/abort and the daemon's longer safeguards. The daemon currently uses a 1 hour idle timeout and a 2 hour total TTL for local LLM streams, which is much longer than the service data-plane defaults.
- The browser message route checks ds4 availability before inserting the user message, but it does not appear to check active per-Bud ds4 stream capacity before creating the message and starting the agent turn. This makes fast retries and cross-thread sends reach the async provider failure path.
- Same-thread overlap is worth validating separately. `AgentService.startUserMessage(...)` replaces the per-thread cancellation controller as it starts a new turn, but the route-level message handler does not show an obvious `isThreadActive(threadId)` guard before inserting the next user message.

## Error-Code Semantics
- `DATA_PLANE_STREAM_LIMIT_EXCEEDED` currently means "the selected data-plane stream family already has its configured number of active streams." For `local_llm_http`, that configured number is `1`.
- That name is misleading for user-facing ds4 failures. It sounds like socket or carrier saturation, but the immediate condition is local-model concurrency.
- Actual WebSocket saturation should have a different code, such as `DATA_PLANE_CARRIER_BACKPRESSURE` or `DATA_PLANE_CARRIER_SATURATED`, backed by queue/backlog signals like `socket.bufferedAmount`.
- The local LLM busy condition should use a more specific stable code, such as `LOCAL_LLM_BUSY` or `LOCAL_LLM_STREAM_BUSY`, while preserving retryability.

## Hypotheses
- Most likely: a legitimate overlapping ds4 request hit the designed one-stream-per-Bud limit.
- Plausible: the first ds4 stream had logically finished or been canceled, but WebSocket backlog delayed the service from seeing `stream_close` or `stream_reset`, so the capacity counter still saw it as active.
- Plausible: a stuck local LLM stream remained active because the service has no local LLM idle/TTL timer comparable to file/proxy streams.
- Plausible for the single-turn report: a sequential provider retry or same-turn helper attempted to open ds4 immediately after a prior local LLM stream, and stream cleanup had not completed by the time the capacity check ran.
- Less likely for this report: chat title generation contended for ds4. The implementation uses Anthropic Haiku only.
- Plausible amplifier: the client or route allows rapid follow-up sends while a thread or Bud-local ds4 run is already active, turning a capacity constraint into a confusing runtime error.

## Evidence To Collect
- Service logs for `local_llm.stream_open`, `local_llm.open_result`, `local_llm.stream_reset`, `data_plane.stream_close`, and `data_plane.stream_reset` around the failure.
- Count `local_llm.stream_open` events per `turn_id` and `llm_call_id`. More than one open inside one turn narrows the cause to compaction, retry, or another same-turn model caller.
- Check for `agent.compaction_start`, `agent.compaction_done`, and `agent.compaction_failed` events immediately before the failed ds4 open.
- Check `llm_call` rows for the same `turn_id` and `stepIndex`; a failure before `recordLlmCall(...)` may require adding a pre-open log to see it.
- The `stream_id` from the failed turn and whether another `local_llm_http` runtime stream for the same Bud was still present when the failure occurred.
- `bud_operation` and `bud_stream` rows around the same timestamp to confirm whether the earlier stream closed, reset, or stayed active.
- WebSocket backlog telemetry, especially `socket.bufferedAmount`, when sending data-plane and control frames.
- Daemon logs for `local ds4 already has an active stream`, local LLM response idle timeout, stream TTL expiry, and transport disconnect resets.

## Fix Options

### Simple
1. Rename/remap the exposed local LLM concurrency code to `LOCAL_LLM_BUSY` while reserving data-plane saturation codes for actual carrier pressure.
2. Add a short cancellable exponential backoff around `LOCAL_LLM_BUSY` in the Bud-local ds4 provider path. Example shape: retry after roughly 100 ms, 250 ms, 500 ms, and 1 second with jitter, bounded to a small total window and always respecting the turn abort signal.
3. Add structured logs before local LLM capacity checks and after cleanup, including `turn_id`, `llm_call_id`, `stream_id`, `bud_id`, stream family, active count, and cleanup reason.
4. Add a route-level active-turn guard for same-thread sends if the intended contract is one active agent turn per thread.

### Medium
1. Add service-side idle and total TTL enforcement to Bud-local ds4 streams, mirroring the existing file/proxy data-plane timeout model but using ds4-appropriate durations.
2. Add a process-local per-Bud `local_llm_http` mutex around Bud-local ds4 provider invocation. This would serialize same-process callers and make immediate retry-after-cleanup races much less likely.
3. Add a Bud-local ds4 active-run preflight before durable message insertion, returning a clear busy response for multi-chat contention instead of letting the async provider fail after the user message is persisted.
4. Pass Bud invocation context into context compaction if Bud-local ds4 compaction is desired, or explicitly disable/route compaction to a non-Bud-local model while ds4 serialization is being hardened.

### Advanced
1. Build a bounded per-Bud local LLM queue. It should expose queued/running state to clients, support cancellation, avoid unbounded wait times, and fairly schedule across threads.
2. Add WebSocket carrier health and backpressure accounting. Use `bufferedAmount`, write latency, reset/close delays, and selected/skipped carrier events to distinguish real data-plane saturation from local-model busy.
3. Prefer a data-only carrier such as HTTP/2 or future QUIC for high-volume local LLM streams when available, keeping the baseline WebSocket for control and lower-volume traffic.
4. Make local LLM stream state durable or recoverable enough that service restarts, Bud reconnects, and multi-instance deployment do not leave user-visible busy state ambiguous.

## Recommended Next Step
Start with instrumentation plus the small backoff. If the same-turn issue is a cleanup race, this should reduce user-visible failures and produce the evidence needed to prove it. In parallel, split the error code so future reports can distinguish local model concurrency from real data-plane saturation.

## Immediate Workaround
- Avoid parallel Bud-local ds4 turns on the same Bud.
- If a run is stuck, cancel it and wait for the final event before retrying.
- If the busy state persists after cancellation, reconnect the Bud daemon or restart the service to force data-plane tracker finalization and clear in-memory runtime stream state.

## Spec Files Affected
- Root spec updated to reference this debug note.
