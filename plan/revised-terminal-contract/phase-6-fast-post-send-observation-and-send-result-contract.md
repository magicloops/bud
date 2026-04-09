# Phase 6: Fast Post-Send Observation And Send Result Contract

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Implemented

---

## Objective

Redesign `terminal.send` so it returns immediate post-send evidence instead of only transport acknowledgement and readiness optimism.

By the end of this phase:

- `terminal.send` returns a lightweight post-send observation by default
- the result explicitly distinguishes dispatch success from observed program response
- the agent has a reliable basis for deciding whether to send again, observe, or verify

## Current Problem

Today `terminal.send` returns fields such as:

- `submitted`
- `readiness`
- `context_after`
- `follow_up_hint`

That is not enough. It lets the system say:

- "tmux accepted the keystrokes"

and then treat that as if it meant:

- "the TUI accepted the prompt and is now working"

The result contract needs to expose evidence instead of optimism.

## Scope

### In Scope

- service-side `terminal.send` directive/result schema
- Bud ↔ service `terminal_send_result` payload shape
- post-send observation defaults and fields
- persisted tool metadata and summaries for the richer send result

### Out Of Scope

- the low-level browser typing route
- final wait-engine implementation details beyond what the contract requires

## Contract Direction

### Request direction

`terminal.send` should remain structured and should add a lightweight post-send observation control, for example:

```json
{
  "text": "Please summarize the design doc as a haiku.",
  "submit": true,
  "keys": [],
  "observe_after_ms": 150,
  "wait_for": "none",
  "timeout_ms": 5000
}
```

`settled` remains Phase 7 work. Phase 6 keeps the existing explicit wait modes and changes the default `terminal.send` path to fast post-send observation rather than a long wait.

### Result direction

The exact schema can vary, but the result should capture these semantics:

- transport dispatch status
- whether the screen changed
- whether the program appears to have reacted
- whether the UI appears settled or still processing
- what the next likely action should be

Illustrative fields:

- `submitted`
- `observation`
- `acceptance`
- `state`
- `next_action_hint`
- `context_after`

## Implementation Tasks

### Task 1: Define a richer send result shape in service types

Update the service-side type system so `terminal.send` has a dedicated result variant rather than reusing a generic ack shape that hides ambiguity.

### Task 2: Add default fast post-send observation

For the agent path, `terminal.send` should trigger a lightweight capture after `150ms` unless the caller overrides it explicitly.

This should be enough to answer:

- did text appear?
- did the screen change?
- is the UI still rendering?
- is the UI already back to waiting for input?

### Task 3: Separate acceptance from dispatch

The result should be able to say:

- dispatch succeeded but no visible change was observed
- dispatch succeeded and the program visibly reacted
- dispatch succeeded and the UI is ambiguous

Do not collapse those states into a single readiness score.

### Task 4: Rewrite summaries and hints around evidence

Replace overly strong summaries such as:

- "Sent the prompt and Claude is now working"

with evidence-based summaries such as:

- "Attempted to send the prompt; no visible change observed after 150ms"
- "Attempted to send the prompt; observed Claude begin rendering output"

### Task 5: Persist the richer send metadata

Tool-message metadata should store the fields needed for:

- debugging
- future agent replay
- developer-visible inspection in the UI

Without forcing developers to infer meaning from a single readiness blob.

## Validation Checklist

- [ ] `terminal.send` returns a post-send observation by default
- [ ] the default post-send observation wait is `150ms`
- [ ] the default timeout for the fast-observe send path is `5000ms`
- [ ] the result clearly distinguishes dispatch success from observed program response
- [ ] unchanged screens are represented as ambiguous or not observed, not as success
- [ ] summaries and hints no longer claim progress without evidence
- [ ] persisted tool metadata captures the new send result fields

## Exit Criteria

This phase is done when `terminal.send` is no longer an acknowledgement-only tool and the agent has enough immediate evidence to choose its next step rationally.
