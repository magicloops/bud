# Phase 5: Docs, Validation, And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Finalize Bud offline mode by aligning docs, specs, tests, and local restart validation.

## Documentation Updates

Update:

- `docs/proto.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- relevant web specs touched by the client work
- `bud.spec.md`
- mobile handoff/reference docs if the iOS team consumes the contract directly

Docs should state:

- Bud offline is not a message-send failure when an offline-aware turn starts
- `/agent/state.environment` is authoritative for current Bud availability
- idle state includes environment
- offline mode removes Bud-specific tools but keeps non-Bud tools such as `ask_user_questions`
- context-budget UI may use conservative normal-tool estimates in the first pass
- transport failures during tools become structured tool results
- Bud reconnection can restore Bud tools before later provider steps in the same turn

## Automated Validation

Backend tests should cover:

- route environment serialization
- offline send startup
- offline tool catalog filtering
- ask-user tool availability while offline
- context sync skip while offline
- terminal ensure skip while offline
- offline final assistant persistence
- transport errors as tool results
- recovery after Bud reconnect before later provider step
- ownership enforcement

Web tests should cover:

- composer-level offline status
- send reconciliation for offline mode
- normal request failure behavior remains intact
- optional environment stream event handling if implemented

## Manual Validation Matrix

### Scenario 1: Bud offline before send

1. Open a thread for a Bud.
2. Stop or disconnect the Bud daemon.
3. Confirm `/agent/state.environment.mode` is `bud_offline`.
4. Send a general chat question.
5. Confirm `POST /messages` returns `201`.
6. Confirm the assistant responds normally without terminal/web-view tool calls.
7. Confirm composer shows Bud offline status.

### Scenario 2: Bud offline before device-work request

1. Keep the Bud offline.
2. Ask the assistant to run a command.
3. Confirm the assistant explains that Bud tools are unavailable and gives recovery guidance.
4. Confirm the transcript has a normal assistant message, not a system failure row.

### Scenario 3: `ask_user_questions` while offline

1. Keep the Bud offline.
2. Ask for a task where the assistant needs a structured decision.
3. Confirm `ask_user_questions` remains available.
4. Submit a response.
5. Confirm the turn continues without terminal/web-view tools unless the Bud reconnects before a later provider step.

### Scenario 4: Bud disconnects during terminal tool

1. Start with Bud online.
2. Ask the assistant to run a long command.
3. Disconnect the Bud while the tool is pending.
4. Confirm the tool result is structured with a transport error.
5. Confirm the agent turn continues and produces a coherent response.

### Scenario 5: Bud reconnects mid-turn

1. Start with Bud online.
2. Trigger a transport failure during a tool.
3. Reconnect the Bud before the next provider step.
4. Confirm `/agent/state.environment` returns to normal.
5. Confirm the next provider call can receive Bud-specific tools again.

### Scenario 6: Provider failure while Bud offline

1. Keep Bud offline.
2. Force or simulate an LLM provider error.
3. Confirm the failure is handled as an agent/provider failure, not as Bud offline.
4. Confirm clients stop loading through the normal failure boundary.

## Rollout Notes

- Ship backend environment state first.
- Ship offline startup after backend tests prove Bud-specific tools are removed.
- Ship transport-error tool results after offline startup is stable.
- Ship reference web composer status once `/agent/state.environment` is available.
- Coordinate mobile adoption around `/agent/state.environment` and create-message `agent` metadata.
- Avoid changing DB schema in this pass.

## Exit Criteria

Phase 5 is complete when automated tests, manual restart scenarios, specs, protocol docs, and client handoff notes all agree on the same offline-mode contract.
