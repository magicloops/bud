# Validation Checklist: Revised Terminal Contract

## Local Stack Setup

- [ ] Start a fresh local service, web, and Bud stack after the contract change
- [ ] Use a fresh thread for validation rather than relying on old tool-history rows

## Shell Command Flow

- [ ] Ask the agent a simple shell question such as "what directory are we in?"
- [ ] Confirm the tool call is `terminal.exec`, not `terminal.send`
- [ ] Confirm the stored/streamed tool args show `command: "pwd"` rather than `pwd\n`
- [ ] Confirm the result is marked as a command result and is treated as definitive
- [ ] Confirm the agent does not immediately call `terminal.observe` on the happy path

## Interactive / TUI Flow

- [ ] Ask the agent to launch an interactive program such as Claude Code, Python, or `less`
- [ ] Confirm the launch uses `terminal.send`
- [ ] Confirm structured submit/key semantics are used instead of embedded newline conventions
- [ ] Confirm the follow-up screen inspection uses `terminal.observe`
- [ ] Confirm the agent can continue interacting with the program after observing

## Shell Gating

- [ ] Put the terminal in a REPL/TUI context
- [ ] Trigger a situation where the agent tries or could try a shell command
- [ ] Confirm `terminal.exec` is rejected or failed explicitly with non-shell context details
- [ ] Confirm the result suggests `terminal.send` / `terminal.observe` instead of silently coercing

## Observation Semantics

- [ ] Confirm `terminal.observe` can capture rendered screen content
- [ ] Confirm `terminal.observe` can wait before capturing when requested
- [ ] Confirm `terminal.send` does not quietly return a full screen snapshot by default

## Browser Manual Input

- [ ] Manually type in the browser terminal
- [ ] Confirm low-level terminal input still works after the runtime refactor
- [ ] Confirm manual input does not depend on the agent's structured tool contract

## Docs And Specs

- [ ] Confirm `docs/proto.md` documents exec/send/observe
- [ ] Confirm service and Bud specs no longer describe `terminal.run` / `terminal.capture` as the main agent contract
- [ ] Confirm the root spec indexes the new plan

## Developer Cutover

- [ ] Confirm the implementation notes make it clear that old local tool history may be stale
- [ ] Confirm a developer can understand the new contract from the plan/spec/doc set without relying on chat history
