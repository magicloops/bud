# Phase 3: Agent Runtime And Stream Identity

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Ensure assistant and tool messages have stable `client_id` values before persistence and expose them consistently across `/agent/state`, agent SSE, and the eventual persisted transcript rows.

## Scope

In scope:

- `AgentRuntimeStateManager` type changes
- assistant/tool `client_id` allocation timing
- `/agent/state` payload changes
- agent SSE payload changes
- persisted assistant/tool insert alignment

Out of scope:

- reference web adoption details
- transcript cursor changes
- new transport channels

## Decisions For This Phase

- assistant `client_id` is allocated before the first assistant draft event that refers to that message
- tool `client_id` is allocated before `agent.tool_call`
- the same `client_id` must flow through runtime state, live SSE, and final DB insert
- `turn_id` and `call_id` remain in place; `client_id` is additive

## Implementation Steps

### 1. Runtime state types

Extend runtime state payloads:

- `pending_tool.client_id`
- `draft_assistant.client_id`

This lets mid-turn bootstrap render the same message identity that later appears in `/messages`.

### 2. Tool path

Before emitting `agent.tool_call`:

- allocate tool `client_id`
- store it in runtime pending-tool state
- emit it on `agent.tool_call`

When persisting the tool row:

- write the same `client_id`
- include it in the serialized canonical message
- emit it again on `agent.tool_result`

### 3. Assistant path

Before emitting `agent.message_start`:

- allocate assistant `client_id`

Use that same value for:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `/agent/state.draft_assistant`
- final assistant row persistence
- `agent.message`

### 4. Zero-draft assistant edge case

If the model produces a final assistant message without earlier draft text events:

- allocate assistant `client_id` before persisting the assistant row
- include it on `agent.message`

That keeps the persisted transcript contract consistent even when no earlier draft existed.

## Event Shape Changes

At minimum, extend these payloads:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`

with top-level `client_id`.

## Acceptance Criteria

- [ ] `/agent/state.pending_tool` includes `client_id`.
- [ ] `/agent/state.draft_assistant` includes `client_id`.
- [ ] assistant draft SSE events include `client_id`.
- [ ] tool SSE events include `client_id`.
- [ ] `agent.message` includes both `message_id` and `client_id`.
- [ ] `agent.tool_result` includes both `message_id` and `client_id`.
- [ ] persisted assistant/tool rows store the same `client_id` already seen in runtime/stream state.
- [ ] agent/runtime specs and protocol docs are updated.

## Risks / Notes

- Allocate once, then thread the value through. Do not regenerate at insert time.
- This phase is where runtime/bootstrap identity and transcript identity converge; inconsistencies here will produce the hardest-to-debug client issues.
