# Progress Checklist: Send Tool Update

**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

---

## Phase 1: Agent Contract And Parser Cutover

- [x] Update `terminal_send` schema to `command` / `raw_text` / `key`.
- [x] Remove `text` and `submit` from advertised model-facing schema.
- [x] Update agent prompt examples and guidance.
- [x] Update terminal directive types.
- [x] Update model-runner parsing.
- [x] Update tool arg serialization and effective wait args.
- [x] Decide and implement historical replay normalization if needed.
- [x] Add/update schema and parser tests.
- [x] Update affected specs for Phase 1 files.

## Phase 2: Executor Result And Stream Clarity

- [x] Add executor gesture validation.
- [x] Map `command` to runtime `text + submit:true`.
- [x] Map `raw_text` to runtime `text + submit:false`.
- [x] Map `key` to runtime key only.
- [x] Update pending-command tracking to use `command`.
- [x] Update send summaries and follow-up hints.
- [x] Add explicit gesture metadata to tool results.
- [x] Update transcript and runtime state payload tests.
- [x] Update affected specs for Phase 2 files.

## Phase 3: Docs, Tests, Fixtures, And Client Rendering

- [x] Update provider fixtures/tests from `{ text, submit }` to `{ command }`.
- [x] Update web terminal tool renderer.
- [x] Update renderer specs/tests.
- [x] Update `docs/proto.md`.
- [x] Update service, runtime, terminal, provider, web, and root specs.
- [x] Run targeted service tests.
- [x] Run broader package tests if appropriate.
- [ ] Complete manual validation checklist.

## Phase 4: Daemon Wire Cleanup Decision

- [x] Evaluate whether current Bud wire adapter is sufficient.
- [x] If keeping current wire, document it as an internal adapter shape.
- [ ] If changing wire, define explicit gesture frame and result metadata.
- [ ] Decide whether `terminal_proto` bumps.
- [ ] Update daemon/service protocol code if Phase 4 proceeds.
- [ ] Update daemon/service protocol tests if Phase 4 proceeds.
- [ ] Update protocol docs/specs if Phase 4 proceeds.

## Closeout

- [x] No model-facing prompt/schema/docs mention `submit:true` as the ordinary path.
- [x] Tool result rendering no longer treats `submitted` as Enter proof.
- [x] All touched folder specs are current.
- [x] Any skipped optional work is captured as follow-up.
