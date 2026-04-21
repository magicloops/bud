# Debug: service-refactor-phase-2-runtime-and-transport-split

## Environment
- Repo: `/Users/adam/bud`
- Service package: `service/`
- Date: 2026-04-17
- DB workflow posture: `db:push` for local development, `db:migrate` for staging

## Repro Steps
1. Start an agent turn that is blocked waiting on `terminal.observe` or `terminal.send`.
2. Cancel the turn or drop the Bud connection mid-wait.
3. Create a thread terminal and race that with the first agent turn on the same thread.

## Observed
- pending observe/send promises could sit until timeout after cancel or Bud offline
- first-use terminal session creation was duplicated in both route and agent callers
- the duplicated read/insert/re-read flow left active-session uniqueness handling in callers instead of one owned boundary
- `routes/threads.ts` and `ws/gateway.ts` still bundled unrelated ownership concerns

## Expected
- a single runtime seam should own thread terminal session creation and uniqueness conflict retry
- cancel and Bud-offline transitions should reject pending terminal waits immediately
- thread routes and the websocket gateway should be decomposed into smaller ownership-focused units

## Hypotheses
- the session race belongs in the terminal lifecycle boundary, not in route/agent callers
- pending send/observe state should live in one dispatcher seam so cancel/offline/session-close can reject it consistently
- the large thread-route and gateway files were hiding ownership boundaries that the review already identified

## Proposed Fix
- extract `runtime/terminal/session-store.ts`, `request-dispatcher.ts`, `output-store.ts`, `runtime-state.ts`, and `idle-monitor.ts`
- route both thread-terminal creation and agent first-use session bootstrap through `ensureSessionRecordForThread(...)`
- reject pending terminal waits from both `AgentService.cancelThread(...)` and Bud offline transition
- split `routes/threads.ts` into smaller modules and move the Bud connection state machine out of `ws/gateway.ts`
