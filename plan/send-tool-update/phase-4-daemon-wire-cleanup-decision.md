# Phase 4: Daemon Wire Cleanup Decision

**Status**: Optional
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Medium

---

## Objective

Decide whether the current service-to-Bud `terminal_send{text, submit, key}` wire frame should remain as an internal adapter contract, or whether Bud should adopt explicit gesture fields that match the model-facing `command` / `raw_text` / `key` contract.

This phase is optional. It should proceed only if Phase 1-3 validation shows that service-derived gesture metadata is insufficient or the remaining wire mismatch is causing concrete confusion.

## Decision Gate

Proceed with daemon wire cleanup only if one or more of these are true:

- We need daemon-derived truth for `enter_sent`, not service-derived `enter_requested`.
- Partial dispatch failure needs to distinguish text dispatch from Enter dispatch.
- Docs/specs become too confusing with service `command` mapping to daemon `text+submit`.
- A future non-tmux backend would benefit from explicit gesture kinds on the wire.

Skip this phase if:

- model-facing behavior is fixed by the service-layer contract
- result summaries and metadata are clear enough
- Bud wire mismatch remains contained to internal adapter code

## Option A: Keep Current Bud Wire

Keep:

```json
{
  "type": "terminal_send",
  "text": "whoami",
  "submit": true,
  "key": null
}
```

Benefits:

- no daemon protocol churn
- no protobuf/wire codec changes
- no daemon rollout coordination
- all user-facing confusion already fixed at the agent layer

Required cleanup:

- docs must label this as the service-to-daemon adapter shape
- `submitted` must be documented as dispatch acknowledgement
- service results should expose `enter_requested`

## Option B: Add Explicit Wire Gesture

Change Bud wire to an explicit gesture shape:

```json
{
  "type": "terminal_send",
  "gesture": {
    "kind": "command",
    "text": "whoami"
  },
  "wait_for": "settled"
}
```

Possible gesture kinds:

- `command`
- `raw_text`
- `key`

Possible result metadata:

```json
{
  "input_dispatched": true,
  "text_sent": true,
  "enter_sent": true,
  "key_sent": null,
  "submitted": true
}
```

Benefits:

- daemon and service speak the same product language
- result metadata can report actual dispatch state
- future backends get a cleaner semantic input boundary

Costs:

- update JSON protocol types
- update protobuf/wire codec if typed carrier fields are active for terminal send
- update daemon parser and tests
- decide whether `terminal_proto` bumps
- update service gateway validation
- update `docs/proto.md` and specs

## Implementation Steps If Option B Is Chosen

### 1. Update service terminal types

Touch likely files:

- `service/src/terminal/types.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/ws/protocol.ts`
- `service/src/proto/wire.ts`
- `service/src/proto/wire.test.ts`

### 2. Update daemon protocol and dispatch

Touch likely files:

- `bud/src/protocol.rs`
- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/backend.rs` only if result metadata requires backend-level returns
- `bud/src/terminal/tmux.rs` only if backend result detail needs to be split

### 3. Decide `terminal_proto` behavior

If old and new frames are both accepted during a local rollout, a protocol bump may not be necessary.

If the old `text`/`submit` fields are removed from the daemon-service wire, bump `terminal_proto` and update capability negotiation/docs.

### 4. Update docs and specs

Expected updates:

- `docs/proto.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/proto/proto.spec.md`
- `bud/src/terminal/terminal.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

## Acceptance Criteria For Option B

- Service sends Bud explicit terminal gestures.
- Bud rejects ambiguous gesture frames.
- Bud reports whether Enter was actually sent.
- `submitted` is either removed from active results or documented as an alias for `input_dispatched`.
- Protocol docs and specs no longer describe `text`/`submit` as the active Bud wire shape.
- Service and daemon tests cover command, raw text, key, and partial/failed dispatch behavior.

## Recommendation

Default to Option A after Phase 1-3.

The immediate issue is model-facing ambiguity. The current Bud wire can express the desired behavior, and a daemon wire cleanup should wait until there is evidence that service-derived metadata is not enough.
