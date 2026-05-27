# Implementation Spec: Bud Offline Mode

**Status**: Draft
**Created**: 2026-05-26
**Design**: [../../design/offline-bud-agent-turns.md](../../design/offline-bud-agent-turns.md)
**Debug Note**: [../../debug/offline-bud-message-persisted-without-agent-turn.md](../../debug/offline-bud-message-persisted-without-agent-turn.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-environment-state-contract.md](./phase-1-environment-state-contract.md)
**Phase 2**: [phase-2-offline-startup-and-tool-catalog.md](./phase-2-offline-startup-and-tool-catalog.md)
**Phase 3**: [phase-3-transport-tool-results-and-recovery.md](./phase-3-transport-tool-results-and-recovery.md)
**Phase 4**: [phase-4-reference-client-composer-status.md](./phase-4-reference-client-composer-status.md)
**Phase 5**: [phase-5-docs-validation-and-rollout.md](./phase-5-docs-validation-and-rollout.md)

---

## Context

Local mobile development exposed an inconsistent failure mode:

- `POST /api/threads/:thread_id/messages` persisted the user message
- `AgentService.startUserMessage(...)` then failed because terminal ensure threw `bud_offline`
- the route returned `500`
- no assistant response or stream `final` was produced
- clients could show an indefinite spinner even though the canonical transcript had changed

The first fix idea was to reject known-offline sends before persistence. Product review changed the direction: a disconnected Bud should not prevent the assistant from responding. The assistant can still answer general questions, ask the user for structured clarification, and help recover the Bud.

## Objective

Make Bud availability an explicit agent environment instead of a universal startup precondition.

The end state:

- sending a message while the Bud is offline returns success when the LLM turn starts
- the user message remains durable
- the assistant runs with Bud-specific tools removed
- non-Bud tools such as `ask_user_questions` remain available
- `/agent/state.environment` always reports current Bud availability for idle and active threads
- terminal and web-view transport failures become structured tool results
- the agent can recover within the same turn when the Bud reconnects before a later provider step
- web and mobile show offline status in the composer instead of treating the send as failed

## Architecture Phrase

Messages are durable intent. State is runtime truth. Tools are environment-scoped. Transport loss is a tool result, not automatically a failed turn.

## Target Contract

### `POST /api/threads/:thread_id/messages`

Successful offline-start response:

```json
{
  "message_id": "msg_...",
  "client_id": "client_...",
  "message": {
    "...": "canonical user message"
  },
  "agent": {
    "started": true,
    "mode": "bud_offline",
    "bud_status": "offline",
    "stream_cursor": "01..."
  }
}
```

Normal online sends should return the same shape with `mode: "normal"` once the response object is introduced.

Validation, auth, missing thread, malformed request, invalid model selection, and provider-start failures are still real request failures. Bud offline is not a request failure if the offline-aware agent turn starts.

### `GET /api/threads/:thread_id/agent/state`

Every authorized state response should include environment:

```json
{
  "active": false,
  "turn_id": null,
  "phase": "idle",
  "can_cancel": false,
  "stream_cursor": "01...",
  "pending_tool": null,
  "draft_assistant": null,
  "environment": {
    "mode": "bud_offline",
    "bud_id": "b_...",
    "bud_status": "offline",
    "reason": "bud_disconnected",
    "last_seen_at": "2026-05-26T22:48:20.000Z",
    "tools": {
      "terminal": "unavailable",
      "web_view": "unavailable",
      "ask_user_questions": "available"
    }
  },
  "updated_at": "2026-05-26T22:48:24.000Z"
}
```

`environment` is client-safe runtime state. It is not a transcript row.

### Agent tool catalog

When `environment.mode === "bud_offline"`:

- remove `terminal_send`
- remove `terminal_observe`
- remove `web_view_open`
- remove `web_view_close`
- remove `web_view_list`
- keep `ask_user_questions`
- keep future non-Bud first-class tools by default unless they are added to the Bud-specific denylist

Catalog decision: use a Bud-specific tool denylist, not a non-Bud allowlist. Offline mode removes access to the selected Bud's terminal and local web proxy surfaces; it should not require every future service-level tool to explicitly opt into offline operation.

The first pass may keep context-budget estimates conservative by using the normal tool-schema estimate.

### Transport failures during tools

When a Bud-specific tool sees a transport failure:

- persist a tool result instead of throwing out of the agent loop
- use `BUD_DISCONNECTED` for known offline cases
- use existing canonical codes where possible for other transport failures, such as `TIMEOUT` for timed-out request/response waits and `EXEC_FAILED` for dispatch failures
- include a compact summary that the model can reason over
- refresh environment before the next provider call

## Design Anchors

- Do not reject offline Bud sends just because terminal transport is unavailable.
- Do not create a system transcript row solely for Bud offline status.
- Do not let the model call Bud-specific tools when the service already knows the Bud is offline.
- Do not permanently mark a whole turn offline after one transport failure.
- Re-resolve Bud availability before provider steps and before Bud-specific tool dispatch.
- Keep `/messages` as durable transcript truth.
- Keep `/agent/state` as the authoritative runtime and availability surface.
- Keep `/agent/stream` additive; `agent.environment` is optional and not required for correctness.
- Keep browser-facing authorization before reading messages, state, streams, or terminal history.
- Use owner-derived Bud ids; never trust client-supplied Bud ids for this flow.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-environment-state-contract.md](./phase-1-environment-state-contract.md) | `/agent/state` and message-send responses expose Bud environment without changing agent behavior yet |
| 2 | [phase-2-offline-startup-and-tool-catalog.md](./phase-2-offline-startup-and-tool-catalog.md) | Offline sends start an LLM turn with Bud-specific tools removed and non-Bud tools preserved |
| 3 | [phase-3-transport-tool-results-and-recovery.md](./phase-3-transport-tool-results-and-recovery.md) | Mid-turn transport failures become tool results and Bud reconnection can restore tools later in the same turn |
| 4 | [phase-4-reference-client-composer-status.md](./phase-4-reference-client-composer-status.md) | Reference web and mobile handoff use composer-level offline status and stop treating offline sends as failures |
| 5 | [phase-5-docs-validation-and-rollout.md](./phase-5-docs-validation-and-rollout.md) | Protocol docs, specs, validation, and rollout notes align with the shipped contract |

## Sequencing Notes

- Ship the environment state contract before changing startup behavior so clients and tests have an observable target.
- Do not remove terminal ensure from normal online startup.
- Do not add a durable DB schema for agent turns in this pass.
- Do not block phase 2 on reduced context-budget accounting.
- Implement transport-error tool results after offline startup so normal-path behavior remains easy to compare.
- Treat `agent.environment` SSE as optional. If it is added, clients must still converge from `/agent/state`.

## Expected Files And Areas

### Service

- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent-service.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/tool-definitions.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/agent/web-view-tool-executor.ts`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/runtime.spec.md`
- `service/src/transport/*`

### Web

- thread message send hook / route code that consumes `POST /messages`
- thread `/agent/state` types and reducer code
- composer component
- relevant `web/src/**/*.spec.md` files touched by the implementation

### Docs

- `docs/proto.md`
- `design/offline-bud-agent-turns.md` if decisions change
- mobile handoff/reference docs if created or updated
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The route still returns `500 bud_offline` before offline mode starts | Medium | High | Add route and agent tests for start-offline sends |
| The model sees terminal tools while the Bud is known offline | Medium | High | Centralize tool-catalog filtering and test provider invocation inputs |
| Offline environment remains stale after reconnect | Medium | High | Re-resolve environment before each provider step and Bud-specific tool dispatch |
| Transport errors are over-broadly swallowed | Medium | High | Only convert known transport-layer failures; let provider, DB, validation, and contract errors fail normally |
| Clients treat `agent.started: true, mode: bud_offline` as failed | Medium | Medium | Update reference web and mobile handoff with explicit reconciliation rules |
| Context-budget numbers look larger than the actual offline provider request | High | Low | Document conservative first-pass estimate and defer precise reduced-tool accounting |
| Composer offline indicator conflicts with existing thread-title status | Medium | Low | Treat composer as authoritative for the active thread; leave list/title status as secondary |

## Definition Of Done

- [ ] `/agent/state.environment` is present for idle and active threads.
- [ ] `POST /messages` returns `201` for a Bud-offline send when the offline-aware LLM turn starts.
- [ ] offline start skips terminal ensure and context sync.
- [ ] offline provider calls exclude Bud-specific tools and keep `ask_user_questions`.
- [ ] final assistant responses from offline turns persist and stream normally.
- [ ] terminal and web-view transport failures produce structured tool results.
- [ ] environment is refreshed before provider/tool steps so reconnection can restore Bud tools within a turn.
- [ ] web shows Bud offline state in the composer and does not show a failed-send spinner for successful offline turns.
- [ ] docs, specs, and validation checklists describe the same contract.
