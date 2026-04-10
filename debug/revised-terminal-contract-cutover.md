# Debug: revised-terminal-contract-cutover

## Environment
- OS / arch / versions: macOS developer environment in the shared Bud workspace
- DB connection style: service-local development database
- LLM mode (real/mocked): real provider integration in the service harness

## Repro Steps
1. Ask the agent to run a simple shell command such as `pwd`.
2. Observe that the agent emits `terminal.run` with `input: "pwd\n"`.
3. Observe that the agent then often calls `terminal.capture` to retrieve output that should have been returned directly by the prior tool call.

## Observed
- The service prompt/tool layer teaches the model to encode transport details such as trailing newlines.
- The runtime overloads one terminal tool path for both shell commands and interactive/TUI input.
- Bud returns direct output for some flows, but the agent harness still treats follow-up capture as part of the normal path.
- The protocol shape is split across `service/` and `bud/`, so partial updates leave mismatched tool names and payloads.

## Expected
- Simple shell commands should use a first-class command tool that accepts a command string without `\n` and returns authoritative output in one response.
- Interactive/TUI flows should use a separate send/observe contract that preserves readiness-driven polling semantics.
- The service, Bud daemon, runtime events, and UI should all use the same tool and protocol names.

## Hypotheses
- The root issue is contract ambiguity, not the newline itself.
- Tool naming and payload drift between the agent harness and Bud protocol are causing redundant observation behavior and inconsistent persisted tool messages.
- Readiness needs to remain part of the contract, but only interactive flows should depend on explicit observation as a normal follow-up.

## Proposed Fix
- Replace `terminal.run` / `terminal.capture` with a breaking cutover to `terminal.exec`, `terminal.send`, and `terminal.observe`.
- Update the Bud protocol to `terminal_exec`, `terminal_send`, and `terminal_observe` request/response pairs while keeping low-level browser terminal input streaming intact.
- Update persisted tool messages, runtime events, web rendering, tests, and spec/protocol docs in the same change.
