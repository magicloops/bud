# revised-terminal-contract

Implementation planning documents for replacing the current overloaded terminal tool contract with separate execution, interaction, and observation tools.

## Purpose

This folder turns the design work in [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md) into an actionable implementation and validation plan.

The plan assumes:

- this contract can break developer-only workflows because Bud is not yet in production for real users
- we do not need compatibility aliases for `terminal.run` or `terminal.capture`
- simple shell commands should stop encoding `\n` at the model layer
- interactive/TUI flows still need readiness-based waiting and explicit observation
- command execution must remain inside the thread-scoped tmux session rather than falling back to the legacy detached `shell.run` path
- the browser's manual terminal input route remains a separate low-level concern from the agent tool contract

## Files

### `implementation-spec.md`

Parent implementation spec for the revised terminal contract work.

Documents:

- the current overloaded-tool problem
- the fixed breaking-contract decisions
- phase sequencing
- risks and definition of done

### `phase-1-service-tool-contract-and-agent-harness.md`

Service and agent-harness phase covering:

- new `terminal.exec`, `terminal.send`, and `terminal.observe` tool definitions
- removal of `\n`-as-Enter from shell-command prompts
- result-shape redesign
- tool-call parsing, persistence, and runtime event updates

### `phase-2-runtime-and-bud-protocol-cutover.md`

Runtime and Bud protocol phase covering:

- new service/runtime request methods
- Bud wire-message replacements for execution, interaction, and observation
- structured interactive input semantics
- replacement of `terminal_run` with a command-oriented execution path

### `phase-3-context-policy-and-observation-semantics.md`

Context and semantics phase covering:

- shell-only gating for `terminal.exec`
- REPL/TUI launch and tracking rules
- explicit observation semantics
- context refresh and follow-up-hint behavior
- reference web tool-display adjustments if needed

### `phase-4-tests-docs-and-developer-cutover.md`

Finalization phase covering:

- service and daemon tests
- protocol/spec/doc updates
- developer cutover expectations without compatibility shims
- manual validation

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the revised terminal contract.

## Dependencies

- [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md) - main design review and recommended contract split
- [../../design/terminal-context-sync.md](../../design/terminal-context-sync.md) - current context-sync behavior that must keep working after the tool cutover
- [../../design/agent-terminal-context-awareness.md](../../design/agent-terminal-context-awareness.md) - current context-tracking assumptions and known REPL guidance
- [../../design/terminal-run-refactor-v2.md](../../design/terminal-run-refactor-v2.md) - current request-response ownership direction for command execution
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally avoids a compatibility layer for the old agent tool names. Existing local developer threads may need to be recreated if historical tool rows become confusing after the cutover.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
