# Debug: remove-terminal-interrupt-cutover

## Environment
- OS / arch / versions: repository-local development on macOS, service in Node/TypeScript, Bud daemon in Rust
- DB connection style: service Drizzle/Postgres runtime, not directly exercised for this note
- LLM mode (real/mocked): both mocked unit tests and real model-facing tool contract are affected

## Repro Steps
1. Put the terminal into a TUI or REPL that may consume `Ctrl+C` or require repeated interrupts.
2. Trigger agent `terminal.interrupt`.
3. Observe the tool summary `Sent Ctrl+C, but interrupt result was incomplete: interrupt_timeout`.
4. Observe that the agent may then fall back to `terminal.observe` and other follow-up input such as `exit`.

## Observed
- The current agent-facing `terminal.interrupt` path is not a stronger primitive than the shared send path.
- Bud ultimately implements interrupt as `tmux send-keys ... C-c`.
- The dedicated interrupt tool adds bespoke dispatch/result/timeout semantics and extra protocol frames (`terminal_interrupt`, `terminal_interrupt_result`) on top of the same underlying tmux behavior.
- Browser interrupt remains useful as a manual escape hatch, but it does not require a separate model-facing tool.

## Expected
- The model-facing contract should have a single terminal-input primitive for shell and interactive input.
- `Ctrl+C` should be expressible through `terminal.send.keys` using tmux-native notation such as `C-c`.
- Browser interrupt should keep working, but as a wrapper over the shared send path.

## Hypotheses
- The dedicated interrupt path is creating false semantic precision around a best-effort tmux key send.
- Separate interrupt plumbing increases failure modes, dead code, and documentation drift without adding real capability beyond `terminal.send`.
- Keeping both tools biases the model toward the more specialized tool even though the shared send path is the more accurate abstraction.

## Proposed Fix
- Extend the shared Bud `terminal_send` key handling to accept tmux-native modifier chords, at minimum `C-c` and `C-d`, with optional alias normalization for `ctrl+c`-style inputs.
- Remove agent-facing `terminal.interrupt` from prompt guidance, tool schemas, parsing, execution, summaries, persistence replay, and tests.
- Keep browser `POST /api/threads/:thread_id/terminal/interrupt`, but implement it as a wrapper over the shared send-key path using `["C-c"]`.
- Delete dedicated service/Bud interrupt protocol/runtime code once the browser route no longer depends on it.
- Update active docs/specs so only the browser escape hatch remains an active interrupt surface.

## Spec Files Affected
- `/Users/adam/bud/bud.spec.md`
- `/Users/adam/bud/AGENTS.md`
- `/Users/adam/bud/docs/proto.md`
- `/Users/adam/bud/docs/terminal-testing.md`
- `/Users/adam/bud/service/src/agent/agent.spec.md`
- `/Users/adam/bud/service/src/runtime/runtime.spec.md`
- `/Users/adam/bud/service/src/terminal/terminal.spec.md`
- `/Users/adam/bud/service/src/ws/ws.spec.md`
- `/Users/adam/bud/service/src/routes/routes.spec.md`
- `/Users/adam/bud/bud/src/src.spec.md`
- `/Users/adam/bud/bud/bud.spec.md`
- `/Users/adam/bud/web/src/components/message-renderers/tools/tools.spec.md`
