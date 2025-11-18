# Plan: Reasoning Effort Selector

## Context
- Link to issue(s): UI polish + agent ergonomics (Phase 4 stretch goal).
- Related docs/sections: `/plan/proof-of-concept.md` Phase 4 (Agent loop), `plan/ui-schema-alignment.md`.

## Objective
- Expose OpenAI Responses “reasoning effort” on both backend and UI so operators can pick between faster/shallower runs and deeper reasoning.
- Default to “fast” (no reasoning) but let users opt into “thinking”, “deep”, or “max”.
- Ensure the selection flows from web → service → OpenAI request while keeping compatibility with GPT‑5 defaults.

## Design / Approach
- **Backend config**
  - Extend `config.ts` with `agentReasoningEffortDefault` sourced from `AGENT_REASONING_EFFORT` env (fallback `none`).
  - Map UI-friendly tokens (`fast`, `thinking`, `deep`, `max`) to OpenAI values (`none`, `low`, `medium`, `high`).
  - Guard older models: if the configured OpenAI model does not support `none`, coerce to `low`/`medium`.
- **API surface**
  - Update `CreateMessageSchema` (POST `/api/threads/:id/messages`) to accept optional `reasoning_effort`.
  - Pass the parsed effort to `agentService.startUserMessage(threadId, effort)`; store in run metadata if helpful (future UX).
  - Thread metadata may record the latest choice to seed UI defaults later (out of scope for now).
- **Agent service**
  - Thread `reasoningEffort` through `startUserMessage` → `runAgentFlow` → `invokeModel`.
  - When building the OpenAI request, include `reasoning: { effort }`.
  - Log selected effort when `AGENT_DEBUG` is enabled for easier tracing.
- **Web UI**
  - Add a selector (likely in the `WorkspaceTopBar` next to the view toggle or above the composer) with options:
    - Fast (none), Thinking (low), Deep (medium), Max (high).
  - Store the selection in `App.tsx` state, persist across runs in the session.
  - Send `reasoning_effort` with the POST body when dispatching a new message.
  - Surface current selection via tooltip or label so it’s obvious to the operator.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration)
- [ ] Agent adapter/tool registry
- [x] Web UI surfaces
- [x] REST API payload (thread message creation)

## Test plan
- Manual:
  1. Switch between effort levels in the UI; trigger runs and confirm request payload includes the mapped value (browser devtools).
  2. Inspect backend logs (with `AGENT_DEBUG=true`) to verify the chosen effort reaches OpenAI.
  3. Attempt with unsupported models (temporarily set `OPENAI_MODEL=gpt-4.1-mini`) to confirm we gracefully coerce and warn.
- Automated: rely on existing lint/type checks; consider adding a small unit around the mapping helper.

## Rollout
- Update `.env.example` and `PROGRESS.md`.
- Mention selector behavior in `web/README.md` (or forthcoming UI doc).
- No migrations required.

## Out of scope
- Persisting per-thread reasoning preferences.
- Surfacing effort per run in SSE/terminal history (can add later with run metadata).

## Status
- **2025-11-17**: Completed backend plumbing (`config.ts`, `agent-service.ts`, `/api/threads/:id/messages`) and UI selector (now lives in the command composer beside the send button). Selector values map to OpenAI’s `reasoning.effort`, defaulting to `none` but auto-coercing to `low` for models that don’t support it. `.env.example` + `PROGRESS.md` updated; remaining follow-up is to document the behavior in `web/README.md` and consider persisting per-thread preferences later.
