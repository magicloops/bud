# Phase 4: Tests, Docs, And Validation

**Status**: Implemented
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: High

## Goal

Finish the core settled-wait rollout with focused automated coverage, protocol/spec updates, and manual validation against realistic terminal behavior.

## Scope

### In Scope

- Bud unit tests for post-dispatch guard and readiness semantics.
- Service unit tests for settled timeout policy and local timeout grace.
- Agent tests for prompt/tool schema behavior around `timeout_ms`.
- Cancellation/interrupt tests added where practical.
- Protocol docs updated for one-hour settled waits and service-owned timeout policy.
- Specs updated for every changed folder.
- Manual validation checklist run or explicitly deferred with reasons.

### Out Of Scope

- Broad end-to-end mobile automation.
- Performance benchmarking beyond basic elapsed-time/log validation.
- New async callback design.

## Automated Test Targets

### Bud

- `terminal_send` default settled wait preserves command echo in delta.
- post-dispatch guard is applied before quiescence sampling.
- echo-only / weak non-prompt capture does not produce high-confidence readiness.
- prompt return still produces high-confidence readiness.
- ongoing output reaches timeout and returns conservative readiness.
- observe settled shares updated readiness behavior.

### Service

- send default settled policy resolves to one hour.
- observe settled policy resolves to one hour.
- non-settled modes keep short defaults.
- model-supplied timeout is ignored or clamped for normal agent tools.
- local timeout is daemon timeout plus grace.
- pending long waits reject on cancel/offline/session close.

### Agent

- tool schema/prompt no longer encourages arbitrary `timeout_ms`.
- terminal send summary remains conservative on weak/timeout readiness.
- replay tolerance remains intact for old tool rows.

## Documentation Updates

Update:

- `docs/proto.md`
- `bud.spec.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`
- `plan/improve-observe/improve-observe.spec.md`
- this plan's checklist docs

Consider updating:

- [../../research/terminal-observation-long-waits.md](../../research/terminal-observation-long-waits.md) with final implementation outcome
- [../terminal-send-refactor/progress-checklist.md](../terminal-send-refactor/progress-checklist.md) only if the older plan needs a forward pointer

## Manual Validation

Run [validation-checklist.md](./validation-checklist.md) before marking the plan complete.

If a command fails because of local setup, capture the exact command/error in a debug note and stop per repo procedure.

Phase 5 remains a follow-up contract cleanup for `wait_for` mode exposure and compatibility.

Manual live-stack validation is explicitly deferred in this coding pass because it requires a running service, an authenticated web/mobile client, and a connected Bud daemon. Automated service and daemon coverage was run locally; the checklist records the deferred live cases.

## Acceptance Criteria

- [x] automated coverage lands for policy, readiness, and pending-request behavior
- [x] manual validation is run or explicitly deferred
- [x] docs and specs match shipped behavior
- [x] remaining async/job-follow-up work is recorded as out of scope
- [x] no stale docs still imply 30 seconds is the default settled wait budget
