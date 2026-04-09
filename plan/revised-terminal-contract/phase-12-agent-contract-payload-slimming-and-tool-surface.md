# Phase 12: Agent Contract, Payload Slimming, And Tool Surface

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Draft

---

## Objective

Align the agent, persisted tool metadata, and developer-visible tool surface with the new minimal model-facing contract: success, readiness, and delta.

By the end of this phase:

- the model no longer receives low-level comparison metadata
- agent policy is written against success/readiness/delta plus explicit observe modes
- developer-visible tool rendering stays understandable without exposing noisy internals by default

## Current Problem

The current service and renderer layers still reflect an earlier intermediate contract that exposed more low-level send metadata than the model really needs. Even if Bud/service compute richer internal state, the model-facing and developer-facing surfaces should center on the information that actually drives next action:

- did the tool succeed
- what is the readiness state
- what changed visibly

## Scope

### In Scope

- agent tool-result shaping
- tool persistence for minimal model-facing payloads
- prompt/tool-guidance updates for delta-first behavior
- developer-visible tool rendering updates
- keeping richer internal metadata out of the model transcript unless explicitly needed

### Out Of Scope

- core Bud delta extraction logic
- protocol wait-engine changes unrelated to delta payload shaping
- final cross-repo doc/spec sweep

## Implementation Tasks

### Task 1: Slim the agent-facing tool result contract

Update the service so the model-facing tool-result content for:

- `terminal.send`
- default `terminal.observe`

is shaped around:

- success
- readiness
- delta

Keep `submitted` for `terminal.send` if it continues to help the model disambiguate transport success from broader tool success.

### Task 2: Revisit which derived fields remain model-facing

Re-evaluate whether fields like:

- `acceptance`
- `state`
- verbose summaries
- low-level observation metadata

should stay in the model transcript, move to internal-only state, or be reduced to concise derived guidance.

The target is not "zero helper fields." The target is "only fields that improve model behavior enough to justify the context cost."

### Task 3: Update the system prompt and tool guidance

Update the agent prompt so it understands:

- `terminal.send` usually returns enough delta to continue without an observe
- `terminal.observe` defaults to delta
- `terminal.observe view:"screen"` and `view:"history"` are the escape hatches for broader context

### Task 4: Update developer-visible tool rendering

Update the web tool-card rendering so developers can still understand what happened without reading noisy internal details.

Recommended emphasis:

- success/failure
- readiness state
- delta excerpt
- explicit view mode when observe used `screen` or `history`

### Task 5: Keep internal debug detail available off the main path

If richer comparison metadata is still useful for local debugging:

- keep it in logs
- keep it in internal debug-only structures
- or expose it only behind explicit debug toggles

Do not make it part of the default model-facing contract.

## Validation Checklist

- [ ] model-facing send/observe tool results center on success, readiness, and delta
- [ ] the model can ask for explicit `screen` / `history` observe modes when needed
- [ ] the system prompt no longer teaches the model to depend on low-level comparison fields
- [ ] developer-visible tool cards remain understandable after payload slimming

## Exit Criteria

This phase is done when the agent contract, persisted tool results, and developer-visible tool surface all align with the minimal delta-first design.
