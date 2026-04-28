# improve-observe

Implementation planning documents for improving Bud's settled terminal waits around `terminal.send` and `terminal.observe`.

## Purpose

This folder turns the findings from [../../research/terminal-observation-long-waits.md](../../research/terminal-observation-long-waits.md) into a phased implementation plan.

The plan focuses on:

- applying a one-hour product wait budget only when `wait_for: "settled"`
- keeping the model-facing `terminal.send` delta anchored from pre-send to final capture, including command echo
- starting send quiescence/readiness assessment after the send gesture has been dispatched with a short guard delay
- decoupling byte quiescence from high-confidence readiness
- preserving live terminal visibility and interrupt control while long settled waits are pending
- cleaning up the `wait_for` option contract after the settled behavior is stable

## Files

### `implementation-spec.md`

Parent implementation spec for the improved settled observation behavior.

### `phase-1-settled-wait-policy-and-agent-contract.md`

Service and agent-contract phase covering service-owned settled timeout policy, reduced model ownership of `timeout_ms`, and propagation of the one-hour budget to send/observe requests.

### `phase-2-daemon-post-dispatch-quiescence-and-readiness.md`

Daemon phase covering post-dispatch quiescence baselines, guarded send waits, and readiness assessment semantics that do not treat quiet bytes as proof of completion.

### `phase-3-interrupt-control-and-operational-hardening.md`

Operational phase covering long-running tool visibility, human interrupt control, cancellation behavior, diagnostics, and mobile handoff expectations.

### `phase-4-tests-docs-and-validation.md`

Validation phase covering automated tests, protocol/spec updates, manual validation, and rollout checks for the core settled-wait behavior. The phase records completed automated validation plus deferred live-stack manual checks.

### `phase-5-wait-for-mode-cleanup.md`

Implemented follow-up phase covering cleanup of the `wait_for` mode contract: model-facing schemas now advertise only `none`, `changed`, and `settled`, while lower layers retain compatibility for `shell_ready` and legacy `screen_stable` until production-launch cleanup.

### `progress-checklist.md`

Running checklist for implementation progress.

### `validation-checklist.md`

Manual validation checklist for shell, TUI, REPL, no-output, interrupt, and timeout cases.

## Dependencies

- [../../research/terminal-observation-long-waits.md](../../research/terminal-observation-long-waits.md) - source research and product decisions
- [../terminal-send-refactor/implementation-spec.md](../terminal-send-refactor/implementation-spec.md) - prior settled-by-default implementation plan
- [../../design/terminal-send-settled-by-default.md](../../design/terminal-send-settled-by-default.md) - original settled-by-default design
- [../../service/src/runtime/terminal/terminal.spec.md](../../service/src/runtime/terminal/terminal.spec.md) - service terminal dispatcher ownership
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent tool contract ownership
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon terminal runtime ownership

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally keeps the work synchronous. True async wake-ups, background job completion callbacks, and multi-job orchestration remain a separate future design if one-hour settled waits are not enough.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
