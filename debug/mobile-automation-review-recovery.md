# Debug: Mobile automation review recovery

## Environment and reproduction
- Mobile ChatStore with durable agent-state polling; web can resolve a review while mobile misses SSE.
- Keep invocation fields unchanged while a pending automation request appears or disappears, then poll the visible conversation.

## Observed
- The poll compares only invocations and user questions, so automation-only changes do not refresh the transcript.
- Pending-tool upserts can overwrite canonical completed results from a newer transcript page.
- State-only refreshes do not remove obsolete synthetic automation rows, and store work grouping still treats reviews as running tools.

## Proposed fix
- Track the applied pending automation tool for polling, reconcile synthetic review rows on authoritative state, and preserve canonical results.
- Exclude review rows from running work, and refresh durable state after live review events.
- Test cold recovery, opposite-client removal without SSE, failed-read retry, and canonical precedence with a controlled backend.
- Update the mobile automation proposal plan; no API/schema changes.
