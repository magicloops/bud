# Validation Checklist: Improve Settled Terminal Observation

Use this checklist after implementation. Record environment details and any failures in a debug note if local setup blocks validation.

## Status

- Automated validation run locally for Phase 4 service and daemon targets.
- Phase 5 adds automated wait-mode cleanup coverage for model schema exposure, prompt guidance, parser compatibility, and the unsupported delta/shell-ready observe combination.
- Live manual validation is deferred in this coding pass because it requires a running service, an authenticated web/mobile client, and a connected Bud daemon terminal session.
- Deferred live cases remain below for product/manual QA before rollout.

## Environment

- [ ] Service running locally
- [ ] Web or mobile client connected to an authenticated thread
- [ ] Bud daemon connected with terminal enabled
- [ ] Terminal session created for the test thread
- [ ] Agent debug logging enabled if practical

## Shell Cases

- [ ] `terminal.send` for `pwd` returns in one tool call with settled readiness
- [ ] `terminal.send` for `git status` returns in one tool call with useful delta
- [ ] command echo remains visible in the send delta when it is part of the rendered terminal change
- [ ] a no-output shell command can be handled by choosing a non-settled mode or by send plus observe, without changing default settled policy

## TUI / Long Wait Cases

- [ ] Start a TUI command that emits output for more than 30 seconds
- [ ] `terminal.send` stays pending past 30 seconds instead of returning early
- [ ] terminal SSE continues streaming output while the tool is pending
- [ ] the tool returns once the TUI settles before one hour
- [ ] no repeated model-driven `terminal.observe` loop is needed for the same settled wait

## Codex-Style Echo Case

- [ ] Send a Codex command where the first visible change is only shell echo
- [ ] the send delta may include the echoed command
- [ ] readiness is not high-confidence ready solely because the echo went quiet
- [ ] the agent does not claim final task completion based only on the echoed command

## Observe Cases

- [ ] `terminal.observe(wait_for:"settled")` waits past 30 seconds when output is still active
- [ ] observe returns a useful delta after settle
- [ ] observe timeout returns conservative processing readiness
- [ ] observe `view:"screen"` and `view:"history"` still work when explicitly requested

## Wait Mode Cleanup Cases

- [ ] model-facing schema advertises only the chosen public `wait_for` modes
- [ ] `screen_stable` payloads normalize to `settled` if legacy compatibility is retained
- [ ] `shell_ready` is either absent from the model-facing schema or explicitly documented as public
- [ ] `wait_for:"none"` still supports deliberate fast/no-output workflows
- [ ] unsupported mode/view combinations return clear errors

## Interrupt / Cancel Cases

- [ ] while a long settled tool is pending, the client can send an interrupt
- [ ] interrupt sends `ctrl+c` to the terminal
- [ ] the pending tool does not remain blocked until the one-hour deadline
- [ ] the agent regains control with a conservative interrupted/canceled result
- [ ] explicit agent cancel rejects the pending terminal wait
- [ ] Bud disconnect rejects the pending terminal wait

## Regression Checks

- [ ] Python REPL prompt still yields high-confidence readiness
- [ ] Node REPL prompt still yields high-confidence readiness
- [ ] confirmation prompts still set `looks_like_confirmation`
- [ ] password prompts still set `looks_like_password`
- [ ] pager prompts still set `looks_like_pager`
- [ ] browser terminal streaming remains unchanged

## Docs / Handoff

- [ ] `docs/proto.md` describes settled wait policy accurately
- [ ] specs are updated for all changed folders
- [ ] remaining async wake-up/background-job work is explicitly deferred
