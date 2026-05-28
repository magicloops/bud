# Phase 1: Disable Preflight Observe And Add Freshness Hint Plumbing

## Objective

Remove the fixed request-time Bud roundtrip from normal message sends and establish the internal plumbing needed to pass terminal freshness into the agent provider request.

This phase is allowed to use a coarse freshness signal. The hard requirement is that normal sends stop calling `terminal_observe` before the primary agent LLM call.

## Scope

- Bypass or remove the `contextSyncService.checkAndSync(...)` call from `POST /api/threads/:thread_id/messages` for normal user sends.
- Keep offline Bud behavior unchanged.
- Add an internal `TerminalFreshnessSnapshot` type.
- Resolve a first-pass freshness snapshot from DB/runtime state only.
- Resolve the freshness snapshot inside `AgentService.runAgentFlow(...)` before provider calls.
- Apply a transient model hint when the snapshot says terminal state may have changed.
- Ensure the hint is not persisted as a `system` message.

## Current Path To Change

The message route currently:

1. resolves the Bud environment
2. finds an open terminal session
3. if online, calls context sync
4. context sync calls `terminal_observe`
5. context sync may insert a summary message
6. then the route inserts the user message and starts the agent

This phase changes that to:

1. resolve the Bud environment
2. insert the user message
3. start the agent with the resolved environment
4. before each provider call, refresh the environment and compute freshness without contacting the daemon
5. inject a transient freshness hint only when online terminal state may be stale

## Proposed First-Pass Freshness Rules

Use a conservative internal snapshot:

```typescript
type TerminalFreshnessSnapshot = {
  sessionId: string | null;
  state: "clean" | "may_have_changed" | "unknown";
  reasons: Array<"new_output" | "human_input" | "status_changed" | "cwd_changed" | "unknown_watermark">;
};
```

Phase 1 may use simplified logic:

- no open session: `clean`
- Bud offline: `clean` for terminal-freshness purposes, because offline environment handles the user-visible constraint
- open online session with no known model-visible watermark: `unknown`
- open online session with obvious activity after latest terminal tool result: `may_have_changed`
- otherwise: `clean`

Do not call the daemon to improve certainty.

## Provider Context

When the snapshot is `may_have_changed` or `unknown` for an online environment, add this transient instruction:

```text
Terminal freshness notice: terminal activity may have changed since the last model-visible terminal result. The service did not inspect the current terminal state before this response. If your answer or next action depends on the current terminal, call terminal.observe before making device-specific claims or acting on terminal state.
```

Do not add this hint when:

- Bud is offline
- no terminal session exists
- the snapshot is clean

## Expected Code Changes

- `service/src/routes/threads/messages.ts`
  - remove/bypass context sync in normal sends
  - leave freshness resolution to the agent loop

- `service/src/agent/agent-service.ts`
  - resolve freshness in `runAgentFlow(...)` before provider calls
  - apply freshness hint before provider call
  - avoid repeating the same hint after a terminal tool result in the same turn when no new activity occurred

- `service/src/agent/environment.ts` or new helper
  - add freshness hint builder or keep it near environment-instruction helpers

- new helper under `service/src/terminal/` or `service/src/agent/`
  - define freshness snapshot type
  - expose first-pass resolver

## Tests

- Sending a message with an online existing terminal session does not call `contextSyncService.checkAndSync(...)`.
- Sending a message with an offline Bud does not add a terminal freshness hint.
- Sending a message with no terminal session does not add a terminal freshness hint.
- Dirty/unknown online freshness adds the transient hint to provider context.
- The transient hint is not persisted as a transcript `system` row.
- Duplicate `client_id` retries still return the existing message and do not start another agent turn.

## Specs To Update

- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/terminal/terminal.spec.md`
- `plan/terminal-freshness/terminal-freshness.spec.md` if file ownership changes

## Acceptance Criteria

- [x] No normal user send performs request-time `terminal_observe` before the primary agent LLM call.
- [x] Provider context can include a transient freshness hint when the terminal may be stale.
- [x] Offline Bud turns still use offline environment guidance and filtered tools.
- [x] No client API changes are required.
