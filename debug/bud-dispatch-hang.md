# Debug: Bud dispatch hang after tool_call

## Environment
- Backend: Fastify dev server (`pnpm dev`), `AGENT_DEBUG=true`.
- Bud: `cargo run -- --server ws://localhost:3000/ws --token <dev bypass>`.
- OpenAI Responses API with real key.
- Web helper triggers `POST /api/threads/:id/messages`.

## Observed Logs (service)
```
agent Starting agent run ... entries=15
agent Calling OpenAI Responses ...
agent OpenAI response received outputTypes=["reasoning","function_call"]
agent Dispatching tool call command="ls -la" cwd="~" callId="call_..."
```
- After `dispatchShellCommand`, no further logs appear (no “Bud execution completed” nor any SSE `exec.*` events). Request stays in “Dispatching…” on the UI, implying the run never transitions.

## Hypotheses (top 4)
1. **WS frame never reaches Bud** – `sendFrameToBud` returns `true`, but perhaps Bud dropped the connection or isn’t handling `run` frames (e.g., identity mismatch, queue full) so the command isn’t spawned.
2. **Bud executor stuck** – command launched but Bud never emits `stdout/stderr/run_finished`, possibly because the spawn failed silently or event handlers crashed.
3. **Backend didn’t resolve the promise** – `activeRuns` entry exists but `handleRunFinished` never called (e.g., Bud’s response lost, or `run_finished` schema mismatch), so the `dispatch.promise` hangs awaiting `resolve`.
4. **Misparsed tool output** – conversation state includes invalid `function_call` payload (e.g., `cwd` required but we pass `undefined`), causing Bud to reject the run or the backend to drop the frame before it reaches Bud.

## Next steps
- **WS instrumentation (backend)**: temporarily log in `sendFrameToBud` (bud id, payload summary, socket.readyState) and when the dispatcher enqueues `activeRuns`. Add logging around `handleStreamChunk`/`handleRunFinished` to confirm whether we ever receive frames.
- **Bud logging**: enable TRACE-level logging or add explicit `info!` when Bud receives `run`, `stdout`/`stderr` chunks, and when it emits `run_finished`. That will confirm if the agent actually receives commands.
- **DB inspection**: check `run`, `run_step`, and `run_log` rows for the stuck `run_id` to see if any progress markers were stored.
- **Schema validation**: log when `handleStreamFrame` or `handleRunFinished` rejects frames due to schema parse failures.

Once we know whether Bud ever ran the command or the backend never received the completion, we can narrow down to WS dispatch vs. Bud executor vs. schema mismatch.
