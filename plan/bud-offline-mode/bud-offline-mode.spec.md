# bud-offline-mode

Implementation planning documents for treating Bud availability as an agent-turn environment instead of a hard message-send failure.

## Purpose

This folder turns [../../design/offline-bud-agent-turns.md](../../design/offline-bud-agent-turns.md) into an actionable implementation and validation plan.

The current plan assumes:

- offline Bud sends should still persist the user message and start an assistant turn when the LLM provider is available
- Bud-specific tools should be removed when the selected Bud is offline
- non-Bud tools such as `ask_user_questions` should remain available in offline mode
- `/agent/state.environment` is the authoritative client-facing Bud availability surface
- idle and active `/agent/state` responses should include Bud environment
- terminal and web-view transport failures should become structured tool results instead of hard agent failures
- Bud availability is recoverable within one turn; a failed tool call while disconnected should not permanently freeze the turn as offline

## Files

### `implementation-spec.md`

Parent implementation spec for Bud offline mode.

Documents:

- product semantics
- target HTTP/runtime contracts
- phase sequencing
- risks
- definition of done

### `phase-1-environment-state-contract.md`

Backend contract phase covering:

- environment snapshot shape
- current Bud availability resolution
- idle and active `/agent/state.environment`
- create-message startup metadata
- backend tests and specs

### `phase-2-offline-startup-and-tool-catalog.md`

Agent startup phase covering:

- offline-aware `startUserMessage(...)`
- Bud-specific tool denylist
- context sync skip while offline
- provider-call prompt context for offline mode
- first-pass conservative context budget handling

### `phase-3-transport-tool-results-and-recovery.md`

Recovery phase covering:

- terminal and web-view transport errors as structured tool results
- environment refresh before provider/tool steps
- restoring Bud-specific tools when the Bud reconnects mid-turn
- avoiding permanent offline turn state after a single failed tool call

### `phase-4-reference-client-composer-status.md`

Reference client phase covering:

- web composer-level offline status
- send-response reconciliation
- `/agent/state.environment` consumption
- mobile handoff notes for equivalent behavior

### `phase-5-docs-validation-and-rollout.md`

Finalization phase covering:

- protocol/spec updates
- route, agent, runtime, and client validation
- local restart scenarios
- rollout notes

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated validation checklist for Bud offline mode.

## Dependencies

- [../../design/offline-bud-agent-turns.md](../../design/offline-bud-agent-turns.md) - source design and product decisions
- [../../debug/offline-bud-message-persisted-without-agent-turn.md](../../debug/offline-bud-message-persisted-without-agent-turn.md) - original failure investigation
- [../offline-bud-message-send-preflight.md](../offline-bud-message-send-preflight.md) - superseded fail-fast phase plan retained for contrast
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan keeps context-budget UI on the conservative normal-tool estimate for the first pass. Reduced tool-schema accounting for offline mode should be revisited after the runtime contract ships.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
