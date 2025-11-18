# Debug: run-log-duplicate

## Environment
- OS: macOS (local dev)
- Service: `pnpm dev` (Node 22, pnpm)
- Bud: local Rust agent connected via WSS (cwd `~/code/bud`)
- DB: local Postgres via `DATABASE_URL`
- LLM: OpenAI Responses (GPT-5 model per `service/.env`)

## Repro steps
1. Start Bud, service (`pnpm dev`), and web UI (`pnpm dev`).
2. Create/select a thread, send a user message that triggers two consecutive assistant responses within one OpenAI turn (agent finalizes twice before next user input).
3. Observe service console when second assistant message arrives.

## Observed
- Service throws `DrizzleQueryError: duplicate key value violates unique constraint "run_log_pkey"` inserting into `run_log (run_id, seq=0, stream=stdout)` for the same `run_id`.
- Stack trace points to `RunManager.handleStreamChunk` → `BudConnection.handleStreamFrame`.
- Error aborts run; UI stops receiving SSE entries.

## Expected
- `run_log` rows should use monotonically increasing `seq`; agent should accept multiple tool calls per run without reusing seq=0.

## Hypotheses
- `RunContext.seq` resets when multiple tool calls happen within one run (activeRuns map overwritten).
- `run_step` insertion for second command doesn’t reset seq, but the logic retrieving/creating `RunContext` might reinitialize `seq`.
- Possible race when dispatching new shell command before previous `run_finished` increments `seq`.

## Proposed fix
- Ensure `RunContext.seq` persists per `run_id` regardless of number of tool calls; only reset when run is completely removed.
- Alternatively, scope `run_log.seq` by `(run_id, step_idx)` or include `step_id` context.

## Next actions
- [x] Confirm repro
- [x] Adjust RunManager to maintain per-run seq across steps (seed `RunContext.seq` from latest `run_log.seq`).
- [ ] Add regression coverage (unit or manual recipe)
