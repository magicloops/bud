# send-tool-update

Phased implementation planning documents for changing the model-facing `terminal.send` contract from `text` plus optional `submit` to explicit `command`, `raw_text`, and `key` gestures.

## Purpose

This folder turns [../../design/terminal-send-command-raw-text-contract.md](../../design/terminal-send-command-raw-text-contract.md) into an actionable implementation plan.

The plan assumes:

- `terminal.send` remains the primary model-facing terminal input tool.
- `terminal.observe` remains the explicit terminal inspection and longer-wait tool.
- `terminal.exec` is not reintroduced as the normal model-facing shell command path.
- The first implementation changes the service model-facing contract and maps it onto the existing Bud `terminal_send{text, submit, key}` wire frame.
- Bud's daemon wire contract changes only if explicit daemon-derived gesture metadata becomes necessary.
- There are no external model-tool consumers, so the advertised `text`/`submit` schema can be removed rather than kept as public compatibility.

## Files

### `implementation-spec.md`

Parent implementation spec for the send-tool update.

Documents:

- fixed contract decisions
- current implementation map
- phase sequencing
- impacted files and contracts
- risks, open questions, and definition of done

### `phase-1-agent-contract-and-parser-cutover.md`

Service agent-contract phase covering:

- `terminal_send` JSON Schema changes
- prompt and replay guidance
- model-runner parsing
- directive type and effective-args changes
- exactly-one gesture validation

### `phase-2-executor-result-and-stream-clarity.md`

Execution/result phase covering:

- service mapping from `command` / `raw_text` / `key` to runtime `text` / `submit` / `key`
- pending-command tracking updates
- send summaries
- model-visible result metadata that separates dispatch from Enter
- agent runtime and stream payload shape cleanup

### `phase-3-docs-tests-fixtures-and-client-rendering.md`

Finalization phase covering:

- provider fixtures
- service and web tests
- first-party tool rendering
- protocol docs and specs
- manual validation scenarios

### `phase-4-daemon-wire-cleanup-decision.md`

Optional follow-up phase covering:

- whether to keep the current Bud wire as an internal adapter contract
- whether to introduce explicit daemon wire gestures
- terminal protocol bump considerations
- daemon-derived result metadata such as `enter_sent`

### `progress-checklist.md`

Running implementation checklist for the rollout.

### `validation-checklist.md`

Automated and manual validation checklist for the rollout.

## Dependencies

- [../../design/terminal-send-command-raw-text-contract.md](../../design/terminal-send-command-raw-text-contract.md) - source design
- [../../debug/terminal-send-submit-omission.md](../../debug/terminal-send-submit-omission.md) - original provider failure investigation
- [../../design/reconsidering-terminal-exec-vs-terminal-send.md](../../design/reconsidering-terminal-exec-vs-terminal-send.md) - model-facing tool split context
- [../../design/terminal-send-settled-by-default.md](../../design/terminal-send-settled-by-default.md) - settled-by-default send behavior
- [../../design/backend-neutral-terminal-wire-contract.md](../../design/backend-neutral-terminal-wire-contract.md) - current Bud wire boundary direction
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current service agent contract
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - runtime state and pending-tool surfaces
- [../../service/src/runtime/terminal/terminal.spec.md](../../service/src/runtime/terminal/terminal.spec.md) - terminal request-dispatcher boundary
- [../../service/src/terminal/terminal.spec.md](../../service/src/terminal/terminal.spec.md) - service terminal wire types
- [../../bud/src/terminal/terminal.spec.md](../../bud/src/terminal/terminal.spec.md) - daemon terminal dispatch behavior
- [../../docs/proto.md](../../docs/proto.md) - protocol and stream docs
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Fixed Decisions

- `command` means send text and press Enter.
- `raw_text` means send text without an implicit final Enter.
- `key` means send one semantic key gesture with no implicit Enter.
- New model-facing calls must provide exactly one of `command`, `raw_text`, or `key`.
- `text` and `submit` should be removed from the advertised model-facing schema.
- Existing service-to-Bud `terminal_send{text, submit, key}` can remain the first implementation target.
- `submitted` must no longer be the only model-visible indicator of what gesture happened.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
