# Phase 1: Environment State Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Expose current Bud availability as runtime state before changing agent startup behavior.

By the end of this phase:

- `/agent/state` includes `environment` for idle and active snapshots
- `POST /messages` can include agent startup metadata in successful responses
- the backend has one owner-scoped way to resolve Bud environment for a thread
- clients can render composer availability without reading terminal internals

## Scope

### In Scope

- environment snapshot type and serializer
- owner-aware environment resolution from an authorized thread
- idle `/agent/state.environment`
- active `/agent/state.environment`
- create-message response metadata shape
- route/runtime tests for environment serialization
- protocol/spec updates for the new fields

### Out Of Scope

- starting offline LLM turns
- tool-catalog filtering
- transport failures as tool results
- web UI adoption beyond type-safe readiness for later phases

## Contract

Environment shape:

```json
{
  "mode": "normal",
  "bud_id": "b_...",
  "bud_status": "online",
  "reason": null,
  "last_seen_at": "2026-05-26T22:48:20.000Z",
  "tools": {
    "terminal": "available",
    "web_view": "available",
    "ask_user_questions": "available"
  }
}
```

Offline shape:

```json
{
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
}
```

Notes:

- `mode` is the agent environment mode, not just raw Bud status.
- `bud_status` should match the current service view of the Bud transport/db status.
- `reason` is nullable in normal mode.
- `tools` is client-facing capability state, not the model-facing schema itself.
- The first pass can omit future tools until they exist.

## Implementation Tasks

### Task 1: Add environment contracts

Define shared TypeScript types for:

- `AgentEnvironmentMode = "normal" | "bud_offline"`
- `AgentToolAvailability = "available" | "unavailable"`
- `AgentEnvironmentSnapshot`

Preferred location:

- near `service/src/runtime/agent-runtime-state.ts` if the snapshot is runtime-owned
- or a new small service helper if both routes and agent startup need it

### Task 2: Resolve environment from authorized thread

Add a helper that takes an owned thread record or derived `(threadId, budId)` and returns:

- current Bud online/offline state from the daemon transport tracker
- last seen timestamp from persisted Bud data when available
- tool availability map

Rules:

- resolve thread ownership before calling the helper from browser routes
- derive `bud_id` from the authorized thread
- do not trust client-provided Bud ids
- keep the helper read-only

### Task 3: Extend `/agent/state`

Update the thread agent-state route to include `environment`.

Idle behavior:

- compute current environment on read
- return it even when no active agent runtime exists

Active behavior:

- prefer the active runtime environment if present
- refresh or augment from current transport state if the active runtime has no environment yet
- preserve existing fields such as `active`, `phase`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `context_budget`

### Task 4: Extend create-message success metadata

Add an optional `agent` object to successful create-message responses:

```json
{
  "agent": {
    "started": true,
    "mode": "normal",
    "bud_status": "online",
    "stream_cursor": "01..."
  }
}
```

This phase can return `mode: "normal"` only if offline startup is not implemented yet. Phase 2 will populate `bud_offline`.

### Task 5: Tests

Add or update tests for:

- `/agent/state` returns `environment` when idle and Bud online
- `/agent/state` returns `environment` when idle and Bud offline
- `/agent/state` returns `environment` during active turns
- signed-in non-owner still receives `404`
- create-message success shape accepts optional `agent`
- environment resolver uses owner-derived Bud id

### Task 6: Specs and docs

Update:

- `docs/proto.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md` if runtime snapshot ownership changes

## Exit Criteria

Phase 1 is complete when clients can ask `/agent/state` for any owned thread and reliably learn whether the selected Bud is currently online or offline without inspecting terminal session internals.
