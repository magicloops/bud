# Phase 10: Shared Delta Engine And Send Payload Minimization

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Draft

---

## Objective

Introduce a shared Bud-side delta engine and use it first on `terminal.send`, so the model sees a minimal, additive, post-send result instead of low-level comparison metadata.

By the end of this phase:

- `terminal.send` computes a visible additive delta from baseline to post-send screen
- the model-facing send payload is reduced to success, readiness, and delta
- Bud/service may still keep richer internal comparison data for logs and heuristics

## Current Problem

`terminal.send` now proves more than transport-only success, but it still sends the wrong shape of information back to the model:

- too little semantic content
- too much low-level comparison detail

The result is a tool payload that is noisy for the model and still too weak to avoid many extra `terminal.observe` calls.

## Scope

### In Scope

- Bud-side shared delta comparison helper
- additive-only delta extraction for `terminal.send`
- fallback heuristics for append-like vs repaint-like changes
- slimming the model-facing `terminal.send` payload
- keeping hashes/previews/timing internal-only unless debug output needs them

### Out Of Scope

- changing default `terminal.observe` semantics
- adding explicit `screen` / `history` observe modes
- final agent prompt and web-renderer cleanup

## Implementation Tasks

### Task 1: Define the shared internal delta representation

Add a Bud-side internal comparison structure that can support both `terminal.send` and `terminal.observe`.

It should capture:

- baseline capture
- current capture
- whether anything changed
- shared prefix/suffix information
- chosen delta strategy
- additive delta text
- truncation metadata

This structure is internal. It is not the final model-facing payload.

### Task 2: Implement the hybrid additive delta extraction heuristic

Implement the hybrid strategy from the design doc:

- prefer novel suffix for clean append-like changes
- prefer changed-window extraction for bounded middle rewrites
- fall back to a bounded current-tail excerpt when repaint behavior is noisy

Hard requirement:

- the model-facing delta is additive-only from the current screen
- removed lines from the baseline are not shown to the model

### Task 3: Route `terminal.send` through the shared delta engine

For `terminal.send`:

1. capture baseline immediately before dispatch
2. dispatch text / keys / submit
3. wait the post-send observe window or wait mode
4. capture current screen
5. compute delta
6. return minimal model-facing output

The current send-state/readiness logic may keep using richer internal information as needed, but the model payload should not expose hashes or preview fragments.

### Task 4: Redesign the model-facing send result shape

Update the service/runtime/agent contract so the model-facing `terminal.send` result centers on:

- success
- submitted
- readiness
- delta

Examples of fields to remove from the default model-facing payload:

- baseline hash
- current hash
- preview head
- preview tail
- line counts
- internal delta-strategy metadata

### Task 5: Preserve internal observability

Keep the richer low-level information available for:

- Bud debug logs
- service debug logs
- future heuristics
- internal testing

But keep it out of the default model/tool-result contract.

## Validation Checklist

- [ ] `terminal.send` returns additive delta text after a changed post-send screen
- [ ] unchanged screens return `delta.changed = false`
- [ ] model-facing send payload omits hashes/previews/line-count metadata
- [ ] append-heavy Claude Code responses return a clean useful delta
- [ ] repaint-heavy screens fall back to a bounded current-tail excerpt instead of noisy diff output

## Exit Criteria

This phase is done when `terminal.send` is powered by a shared internal delta engine and its model-facing contract has been slimmed to success, readiness, and additive delta.
