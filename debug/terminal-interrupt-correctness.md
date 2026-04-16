# Debug: terminal-interrupt-correctness

## Environment

- OS / arch / versions: macOS (developer workstation), repo state as of 2026-04-15
- DB connection style: local PostgreSQL via the service Drizzle client
- LLM mode (real/mocked): not required for the static review; planned code changes target the service agent/runtime path and Bud daemon transport

## Repro Steps

1. Start the service and Bud with terminal support enabled.
2. Open a thread-scoped terminal and enter a tracked REPL/TUI such as `python`, `node`, or Claude Code.
3. Trigger `terminal.interrupt` from the agent path while the interactive program is still foregrounded.
4. Observe the resulting tool payload and any follow-up agent behavior.
5. Separately, simulate an interrupt dispatch race where the Bud is offline or the session no longer exists.

## Observed

- `sendInterrupt()` cleared pending REPL context immediately after dispatch, before any observed shell return.
- `executeTerminalCall()` ignored the `{ ok, error }` result from `sendInterrupt()` and could still report `submitted: true`.
- the Bud daemon already had an interrupt-local output window via `terminal_ready`, but the service gateway discarded that data and kept only `assessment`.
- the agent then reconstructed output from a generic terminal DB tail, which could replay stale history.

## Expected

- interrupting an interactive program should not claim shell mode unless shell return was actually observed.
- failed interrupt dispatch should not be reported as a successful Ctrl+C submission.
- interrupt tool output should come from the interrupt-local output window rather than a generic terminal history tail.

## Hypotheses

- finding 1 is entirely service-side and can be fixed by deferring pending-command clearing until observed shell return.
- finding 2 is entirely service-side and can be fixed by branching on the `sendInterrupt()` result before waiting or tailing output.
- finding 3 needs a correlated interrupt result or, at minimum, preservation of the full legacy `terminal_ready` payload during rollout.

## Proposed Fix

- Phase 1:
  - remove eager pending-command clearing from `service/src/runtime/terminal-session-manager.ts`
  - make `service/src/agent/agent-service.ts` treat interrupt dispatch failure as a structured unsuccessful tool result
  - add unit tests for conservative interrupt context and failed-dispatch handling
- Phase 2:
  - add a correlated `terminal_interrupt_result` flow between Bud and service
  - preserve legacy `terminal_ready` payloads for mixed-version rollout fallback
- Spec files affected:
  - `service/src/agent/agent.spec.md`
  - `service/src/runtime/runtime.spec.md`
  - `bud.spec.md`

