# Phase 2: Send And Observe Contract Cutover

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Cut the Bud/service contract over so `terminal.send` is settled-by-default and `terminal.observe(wait_for:"settled")` becomes the explicit longer-wait follow-up tool rather than the immediate normal companion.

By the end of this phase:

- `terminal.send` semantics are aligned end to end around settled-or-timeout behavior
- timeout results return partial-progress information rather than thin dispatch-only success
- `terminal.observe(wait_for:"settled")` is available for explicit longer waits
- the protocol and runtime types match the new semantics cleanly

## Context

Phase 1 provides the Bud-side engine. This phase threads those semantics through the wire contract and the service/runtime behavior so the model and developer-facing tool rows see the new defaults consistently.

## Scope

### In Scope

- Bud/service message-shape alignment for settled-by-default send results
- explicit timeout and processing semantics
- `terminal.observe(wait_for:"settled")` support and default handling
- service runtime changes so immediate observe chaining is no longer the default expectation
- protocol documentation updates for the new behavior

### Out Of Scope

- final prompt/policy cleanup for the model
- deep renderer polish beyond what is needed to avoid confusion
- async completion callbacks or multi-job orchestration

## Implementation Tasks

### Task 1: Lock send-result semantics

Define the service-facing meaning of a `terminal.send` result, including:

- whether the send settled or timed out
- the final rendered delta relative to the pre-send baseline
- conservative readiness / processing flags when timeout occurs
- any explicit trigger field such as `settled` vs `timeout`

The important rule is that timeout should mean:

- "here is the latest visible state"

not:

- "the send failed to dispatch"

### Task 2: Align Bud/service protocol frames

Update the Bud/service transport so the wire contract carries the new send-result semantics cleanly.

That may require updating:

- frame payload fields
- runtime type definitions
- send-result parsing and validation

The contract should remain explicit and machine-readable rather than inferred from free-form summary strings.

### Task 3: Make `terminal.send` settled-by-default in the service runtime

Update the runtime/service path so the normal `terminal.send` request assumes settled waiting by default, with the larger timeout budget.

This includes removing or simplifying any existing service-side assumptions that the model will immediately follow a send with observe in ordinary cases.

### Task 4: Preserve `terminal.observe(wait_for:"settled")` as the longer-wait hatch

Update `terminal.observe` so the model can explicitly request:

- a longer settled wait
- broader inspection after a send timeout

This should collapse repeated poll loops into a single observe wait when the model genuinely wants to keep waiting.

### Task 5: Normalize timeout and processing semantics

Make sure service summaries, persistence, and any runtime hints interpret send timeout consistently:

- transport success remains distinct from terminal still-processing
- timeout is not narrated as completion
- ambiguous or unchanged delta stays explicit

### Task 6: Update protocol docs

Document the new defaults and result semantics in:

- `docs/proto.md`
- the relevant service/Bud specs

## Files Likely Affected

### Service

- `service/src/agent/agent-service.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `service/src/ws/gateway.ts`

### Bud

- `bud/src/main.rs`

### Docs / Specs

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The service still treats timeout as an error path instead of partial progress | Medium | High | Lock result semantics explicitly before updating summaries/rendering |
| Old send-result fields linger and confuse the agent or developer-facing tool rows | Medium | Medium | Remove or de-emphasize obsolete transport-only success assumptions in the same phase |
| Observe and send semantics diverge in subtle ways | Medium | Medium | Share terminology and trigger semantics between the two tools where possible |

## Exit Criteria

- `terminal.send` is settled-by-default end to end.
- Timeout returns the latest rendered delta plus conservative processing semantics.
- `terminal.observe(wait_for:"settled")` supports a single explicit longer wait instead of repeated manual polling.
- Protocol docs and runtime types describe the new contract clearly.
