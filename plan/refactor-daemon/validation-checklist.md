# Validation Checklist: Bud Daemon Modularization

## Build / Smoke

- [ ] `cargo build` succeeds for `bud/`
- [ ] daemon starts with an existing identity
- [ ] daemon starts without an identity and enters claim flow

## Identity / Claim

- [ ] installation-id persists across restarts
- [ ] successful browser claim persists identity correctly
- [ ] invalid stored identity falls back into reauth behavior

## WebSocket / Handshake

- [ ] Bud sends `hello` successfully after the refactor
- [ ] challenge/proof flow still succeeds
- [ ] heartbeat loop still runs during an active session
- [ ] reconnect behavior still restores steady-state operation after disconnect
- [ ] inbound protocol validation behaves as expected for supported frames

## Terminal Lifecycle

- [ ] `terminal_ensure` creates a fresh tmux-backed session
- [ ] `terminal_ensure` reattaches to an existing tmux-backed session
- [ ] `terminal_resize` still resizes correctly
- [ ] `terminal_close` still closes the session cleanly
- [ ] `terminal_status.info` retains the expected metadata fields

## Terminal Output / Observe / Readiness

- [ ] `terminal_output` still streams from the watcher path
- [ ] `terminal_send(wait_for:"settled")` preserves current behavior
- [ ] `terminal_send(wait_for:"changed")` preserves current behavior
- [ ] `terminal_observe(view:"delta")` preserves current behavior
- [ ] `terminal_observe(view:"screen")` preserves current behavior
- [ ] readiness assessments still return expected prompts/hints in common shell cases
- [ ] TUI or REPL flows still work after readiness unification

## Low-Level Input

- [ ] low-level `terminal_input` with `\n` still submits once
- [ ] low-level `terminal_input` with `\r\n` submits once, not twice
- [ ] low-level `terminal_input` still supports readiness waiting

## Legacy Run Path

- [ ] legacy `run` still executes a simple command
- [ ] stdout/stderr streaming still works
- [ ] `run_finished` still arrives with expected fields

## Documentation / Follow-Up

- [ ] Bud specs describe the new module layout accurately
- [ ] retained legacy run ownership note is present in specs
- [ ] deferred tmux wire-cleanup follow-up is documented explicitly
