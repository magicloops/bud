# Plan: repair dangling tool calls on service restart

## Context
- Follow-up #2 from [plan/terminal-wait-async-wakeup.md](./terminal-wait-async-wakeup.md)
  (rollout note: "Restart during a wait — follow-up").
- Related specs: `service/src/agent/agent.spec.md`, `service/src/src.spec.md`.
- Today: a service restart mid-tool (most visibly mid-`terminal.wait`, which
  parks for up to 30 minutes) loses the in-memory turn. The provider ledger
  keeps the assistant `tool_use` item with no `tool_result`;
  `repairOrphanedToolCalls` in `conversation-loader.ts` already injects an
  interrupted result at **replay time**, so the model context survives — but
  the durable transcript still dangles: no tool row is persisted, the web/
  mobile timeline shows the agent silently stopping, and every future load
  re-runs the replay-time repair for the same hole.

## Objective
On boot, before accepting traffic, find dangling tool calls and repair them
durably:
1. record the missing provider-ledger `tool_result` input item (same shape a
   real result would have), so replay repair no longer triggers;
2. persist a product tool row (`role: "tool"`) whose payload reports
   `error: "server_restarted"` (canonical code `SERVER_RESTARTED`) with
   guidance — for `terminal.*` calls it notes the terminal kept running and
   the program may have finished meanwhile;
3. leave `ask_user_questions` calls alone: they have their own durable
   lifecycle (`agent_question_request` rows; post-restart answers become
   fallback user messages).

Acceptance: after a kill mid-`terminal.wait` and a service restart, the
thread timeline shows the wait ending with a restart notice, a follow-up
message works immediately, and the provider replay contains a real
`tool_result` (no `repairOrphanedToolCalls` injection for that call).

## Design
- New module `service/src/agent/restart-repair.ts`:
  - `findDanglingToolCalls()` — SQL: outbound `llm_call_item` rows with
    `kind = 'tool_use'` lacking an input `tool_result` item with the same
    `tool_call_id` in the same thread (uses `llm_call_item_tool_call_idx`),
    joined to `llm_call` for `turn_id`; `ask_user_questions` excluded.
  - `repairDanglingToolCalls({ logger })` — per dangling call, in
    transcript order: insert the ledger `tool_result` item (via
    `recordLlmToolResultItem`) and the tool message row (payload
    `{tool, call_id, error: "server_restarted", code, ok: false, summary,
    note}`), stamped with the thread owner; update thread preview metadata.
    Idempotent by construction (the inserted item makes the call
    non-dangling).
- Boot hook in `server.ts` after `AgentService` construction, awaited before
  `server.listen` so repairs precede new traffic. Failures log and do not
  block boot (the replay-time repair remains the safety net).
- No SSE emission (no listeners at boot); clients see the row on next load.

## Spec Files to Update
- [x] `service/src/agent/agent.spec.md` (module section + restart behavior)
- [x] `service/src/src.spec.md` (server.ts boot note)

## Impacted Contracts
- None on the wire; the tool-row payload is a normal tool message with a new
  `error` value (`server_restarted`), consistent with canonical codes.

## Test Plan
- Unit (db mocked, as in `agent-service.test.ts`): detection query shaping,
  exclusion of `ask_user_questions`, repaired-call payload shape, idempotence
  (already-repaired call yields no work), boot hook error tolerance.
- Manual drill: dev stack, start a `terminal.wait`, kill the service,
  restart, verify the transcript row + a working follow-up turn.

## Rollout
- Service-only change; safe with old daemons (no daemon interaction).
