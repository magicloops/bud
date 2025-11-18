# Debug: terminal-history-duplication

## Environment
- macOS dev host (pnpm, Node 22) running `pnpm dev` for `service/` + `web/`.
- Bud agent connected locally via WSS (cwd `~/code/bud`), executing commands per agent instructions.
- DB: local Postgres (`DATABASE_URL` from `.env`).
- LLM: OpenAI Responses (GPT‑5) with tool outputs returning multi-step runs.

## Repro steps
1. Start backend + web UI, enroll Bud, create a thread.
2. Submit a user request that triggers multiple tool calls (e.g., list files + inspect contents). Observe terminal pane while agent runs.
3. Note that each live stdout chunk shows twice (“duplicate”), but refreshing the page removes the duplicates (historical entries render only once).

## Observed
- Terminal displays the live SSE-driven `ShellEntry` plus the newly fetched DB history entry once `loadRunHistory` runs after the `final` SSE event.
- During streaming the “live” entry and the DB-backed entry can both be present when the refresh merges data without deduping, causing transient duplicates until refresh or until the next run.
- After page refresh, only DB history remains so duplicates disappear.

## Expected
- While a run is active, only the SSE/live representation should show.
- Once the run completes and history is refreshed, the live entry should be removed or merged (same id) so only a single entry remains.

## Hypotheses
- `loadRunHistory` uses `mapHistoryRunToEntry` with `id: history_<run_id>` while live entries use `ulid()` or SSE call ids; when merging (mode `refresh`) we treat any unseen id as new, so the history-run (history_runXYZ) and live run (txt_callXYZ) both appear.
- Clearing `terminalEntries` upon `final` helps, but if `loadRunHistory` resolves before `setTerminalEntries([])` flushes, duplicates momentarily appear. Also when SSE is still streaming while history fetch pulls the same run (e.g., agent runs for first tool call), we may show both simultaneously because we don’t detect “currently streaming run id”.

## Proposed fix
- Track `run_id` on every `ShellEntry` (both SSE/live and history) and treat it as the canonical identifier.
- Keep entries in a map keyed by `run_id`; when history returns that run, overwrite the map entry instead of appending a new row.
- Render using `run_id` keys so the live entry automatically gets replaced when the DB-backed entry arrives, eliminating duplicates without O(n²) comparisons.

## Next actions
- [x] Document issue and hypotheses.
- [ ] Update client state to key entries by `run_id` (live + history) to avoid duplicates.
- [ ] Optionally show “in-progress” badge on history entry instead of separate live entry.
