# Phase 3: Agent Guidance And Operational Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make the model-facing contract, developer-facing tool rows, and operational diagnostics all reflect the settled-by-default behavior so the runtime change actually reduces agent complexity in practice.

By the end of this phase:

- agent guidance assumes `terminal.send` waits for a settled result by default
- `terminal.observe(wait_for:"settled")` is framed as the explicit longer-wait tool
- developer-visible summaries and tool rendering distinguish settled, timeout, and ambiguous outcomes cleanly
- operators have enough tuning information to adjust quiet-window defaults without exposing internal noise to the model

## Context

Changing the Bud/runtime behavior is not enough by itself. If the prompt, tool guidance, summaries, or tool rendering still imply that a send usually needs an immediate observe, the model will continue to overuse observe and the product will not realize the intended cost and context improvements.

## Scope

### In Scope

- prompt and tool-guidance updates for the new default behavior
- service-side send/observe summaries and hints
- developer-visible tool rendering changes only where needed for clarity
- debug/tuning instrumentation for settle behavior

### Out Of Scope

- major web UI redesign
- async callback design for long-running jobs
- new model tools

## Implementation Tasks

### Task 1: Update model-facing guidance

Update the service prompt/tool guidance so the model is taught:

- use `terminal.send` normally
- expect the send result to already reflect the settled state in common cases
- use `terminal.observe(wait_for:"settled")` when it explicitly wants to wait longer after a timeout or ambiguity

Remove any stale guidance that implies immediate post-send observe is the default.

### Task 2: Make summaries and hints evidence-based

Update send-result summarization so it distinguishes:

- settled result
- timeout / still-processing result
- ambiguous / unchanged result

The service should avoid narrating timeout or empty delta as if the command completed successfully.

### Task 3: Update developer-visible tool rendering where needed

If current tool cards or tool summaries imply transport-only success, adjust them so developers can tell whether the send:

- settled
- timed out
- produced no visible delta

This should stay lightweight and should not reintroduce large low-level payloads.

### Task 4: Add tuning diagnostics

Expose enough debug-gated information to make tuning practical, such as:

- settle trigger
- total wait duration
- quiet-window parameters
- whether the final result was unchanged / ambiguous

These diagnostics should support development and validation without becoming part of the normal model-facing contract.

### Task 5: Document operator-facing defaults

Record the chosen defaults and why, including:

- sample interval
- unchanged-sample count
- quiet window
- send timeout
- longer observe timeout expectations

This belongs in docs/specs, not only in code.

## Files Likely Affected

### Service

- `service/src/agent/agent-service.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/agent/agent.spec.md`

### Web

- `web/src/components/message-renderers/tools/`
- `web/src/components/message-renderers/tools/tools.spec.md`

### Docs / Specs

- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Prompt guidance lags behind the runtime behavior and the model keeps over-observing | Medium | High | Treat prompt/tool-guidance updates as part of the same refactor, not follow-up cleanup |
| Tool rendering becomes noisier instead of clearer | Medium | Medium | Keep the UI change narrowly focused on settle/timeout clarity |
| Too much diagnostic detail leaks into model-facing payloads | Low | Medium | Keep tuning data debug-gated and separate from the normal tool result |

## Exit Criteria

- The model-facing guidance treats `terminal.send` as the default settled wait.
- `terminal.observe(wait_for:"settled")` is described as the explicit longer-wait hatch.
- Tool summaries and rendering make settled vs timeout vs ambiguous results understandable.
- Tuning defaults and diagnostics are documented for future iteration.
