# Phase 5: Wait Mode Contract Cleanup

**Status**: Implemented
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Follow-up

## Goal

Clean up the `wait_for` contract after the settled-wait behavior is stable.

The current runtime accepts several modes:

- `settled`
- `changed`
- `none`
- `shell_ready`
- legacy `screen_stable` alias for `settled`

The model-facing contract should be smaller and easier to reason about, while the service and daemon should remain tolerant of older stored tool rows, replayed messages, and older clients.

## Proposed Direction

Use a three-tier contract:

| Tier | Modes | Contract |
|------|-------|----------|
| Preferred model-facing | `settled`, `changed`, `none` | Advertised in current tool schema and prompt guidance |
| Internal / compatibility | `shell_ready` | Accepted where implemented, but not encouraged for normal model calls |
| Legacy alias | `screen_stable` | Accepted and normalized to `settled`, never advertised |

Decision for Phase 5:

- remove `shell_ready` from model-facing tool schemas
- keep `shell_ready` out of prompt guidance
- keep `shell_ready` accepted below the model layer for compatibility until production-launch cleanup
- keep `screen_stable` accepted as a legacy alias for now, but never advertise it

The default model behavior should remain:

- omit `wait_for` on normal `terminal.send`; service treats it as `settled`
- use `terminal.observe(wait_for:"settled")` for explicit longer waits
- use `wait_for:"changed"` only for first-visible-reaction checks
- use `wait_for:"none"` only for deliberate fast sends or commands expected to produce no immediate useful output

## Scope

### In Scope

- Remove `shell_ready` from advertised model-facing schema and prompt guidance.
- Keep parser compatibility for `shell_ready` unless code owners explicitly choose removal.
- Keep `screen_stable` normalization to `settled` for old transcripts and clients.
- Align service TypeScript types, model schema, prompt guidance, protocol docs, and daemon docs.
- Clarify observe-specific constraints, especially that `terminal.observe(view:"delta", wait_for:"shell_ready")` is currently unsupported.
- Add tests that preserve accepted legacy inputs while validating the smaller model-facing schema.

### Out Of Scope

- Removing wire-level `wait_for` support.
- Renaming `wait_for` to a new field.
- Introducing new wait modes.
- Changing the settled-wait timeout policy from Phase 1.
- Changing quiescence/readiness behavior from Phase 2.

## Current Issues To Resolve

### `shell_ready` Is Overexposed

`shell_ready` appears in the model-facing schema, but it is not the normal path for either send or observe:

- `terminal.send` defaults to `settled`
- `terminal.observe` defaults to `none`
- `terminal.observe(view:"delta", wait_for:"shell_ready")` is rejected by the daemon

This creates a mode the model can select even though it is rarely the right choice and has view-specific restrictions.

### `screen_stable` Exists As A Hidden Alias

The service and daemon still tolerate `screen_stable` as an older spelling of `settled`. That compatibility is useful, but docs and schema should consistently present `settled` as the only canonical name.

### `none` Needs Clearer Product Semantics

`none` is still useful, especially for:

- commands expected to produce no immediate output
- fire-and-follow workflows where the agent intentionally sends first and observes later
- interactive inputs where a fast capture is enough

But it should be described as an explicit fast path, not as an alternative readiness strategy.

## Implementation Notes

### Model Schema

Preferred target:

```typescript
enum: ["none", "changed", "settled"]
```

for both `terminal_send.wait_for` and `terminal_observe.wait_for`.

Keep `shell_ready` out of the model schema and preserve it only in lower-level service/daemon parsers until production-launch cleanup.

### Parser Compatibility

`parseWaitForArg(...)` should continue to normalize:

```typescript
"screen_stable" -> "settled"
```

The implementation should decide whether `shell_ready` remains part of the public `TerminalWaitFor` union or moves to a wider internal type. Avoid breaking old stored rows.

### Prompt Guidance

The prompt should describe only the modes the model should select:

- omit `wait_for` for ordinary sends
- `settled` for explicit observe waits
- `changed` for quick visible reaction checks
- `none` for deliberate fast/no-output workflows

Do not mention `shell_ready` unless it remains intentionally model-facing.

For Phase 5, `shell_ready` should not remain model-facing.

### Protocol Docs

`docs/proto.md` should distinguish:

- canonical wait modes
- compatibility aliases
- mode/view constraints

This can be done without a protocol version bump if the wire remains tolerant.

## Acceptance Criteria

- [x] The advertised model-facing `wait_for` enum no longer includes any mode that the model should not normally choose.
- [x] `settled` is documented as the canonical stable/quiescent wait mode.
- [x] `screen_stable` remains accepted as a legacy alias or is removed only with an explicit migration decision.
- [x] `shell_ready` is removed from the model-facing schema and prompt guidance.
- [x] `terminal.observe` docs describe any mode/view restrictions.
- [x] Tests verify old `screen_stable` payloads still normalize to `settled`.
- [x] Tests verify schema/prompt output matches the chosen public mode set.

## Production-Launch Cleanup

`screen_stable` and `shell_ready` should be removed before production launch after compatibility telemetry/search confirms no old clients, stored tool rows, or internal callers still depend on them. The root [../../TODO.md](../../TODO.md) tracks this launch cleanup item.

## Tests

- Service contract tests for `parseWaitForArg(...)`.
- Model schema tests for the advertised `wait_for` enum.
- Conversation-loader tests for prompt guidance.
- Daemon parser tests for accepted canonical and legacy modes.
- Observe validation tests for unsupported mode/view combinations if `shell_ready` remains accepted below the model layer.

## Specs To Update In This Phase

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `bud/src/src.spec.md`
- `plan/improve-observe/improve-observe.spec.md`
