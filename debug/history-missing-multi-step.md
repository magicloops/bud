# Debug: History Missing Multi-Step Entries

## Environment
- Observed on web UI with multi-tool agent runs.
- Backend `/api/threads/:id/runs` returns one summary per `run_id`, not per tool call.

## Findings
1. **Single entry per run**: The history endpoint joins `run_step` only to grab the first step (`idx=0`) to extract the initial command, then attaches stdout/stderr tail for the whole run. Additional tool calls in the same run are not represented separately.
2. **Terminal archive logic**: When SSE `final` event arrives we call `archiveRunEntries(runId)` which clones the SSE entries into history with ids `history_${entry.id}`. This preserves multiple tool calls as long as they existed in `terminalEntries`. However, when the page refreshes (or on initial load), we fetch history solely from the backend endpoint, so only the single per-run entry shows up.

## Conclusion
- The reason we only see the first command after refresh is that the backend doesn’t persist per-tool-call entries; the UI relies on SSE archive for multi-step runs. Future fix requires extending the history API to return run steps or storing per-step transcripts.
