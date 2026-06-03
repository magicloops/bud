# Phase 3: Docs, Tests, Fixtures, And Client Rendering

**Status**: Proposed
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: High

---

## Objective

Complete the contract cutover across first-party tests, provider fixtures, protocol docs, specs, and browser rendering.

By the end of this phase, the codebase should no longer describe `terminal.send` as `text` plus optional `submit` in model-facing docs or tests.

## Scope

### In Scope

- Provider fixture/test updates.
- Agent, runtime-state, transcript, and terminal outcome tests.
- Web tool renderer update.
- Protocol docs for agent tool-call args and current Bud wire adapter.
- Spec updates for every touched folder.
- Manual validation checklist execution.

### Out Of Scope

- Bud daemon wire changes.
- New database migrations.
- New browser routes.

## Implementation Steps

### 1. Update provider fixtures and tests

Replace old tool inputs:

```json
{ "text": "pwd", "submit": true }
```

with:

```json
{ "command": "pwd" }
```

For cases that intentionally type without Enter, use:

```json
{ "raw_text": "pwd" }
```

Expected files include:

- `service/src/llm/providers/providers.test.ts`
- `service/src/llm/provider-ledger.test.ts`
- provider-specific fixtures under `service/src/llm/` if any are added later

### 2. Update first-party client rendering

Update `web/src/components/message-renderers/tools/terminal-run.tsx` so it renders:

- command text plus Enter
- raw text without Enter
- key gesture
- gesture metadata such as `enter_requested`

It should not label `submitted:true` as proof that Enter was pressed.

Update:

- `web/src/components/message-renderers/tools/tools.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- any relevant renderer tests if present

### 3. Update protocol docs

Update `docs/proto.md` in two layers:

1. Model-facing/browser-facing agent tool args:
   - `terminal.send` uses `command`, `raw_text`, or `key`
   - `agent.tool_call.args` and `/agent/state.pending_tool.args` expose the new shape
   - effective `wait_for` behavior remains unchanged

2. Bud daemon wire:
   - the active Bud frame can remain `terminal_send{text, submit, key}` for Phase 1-3
   - document that the service maps model-facing gestures to the existing daemon wire
   - `submitted` is dispatch acknowledgement, not Enter proof

If Phase 4 later changes the Bud wire, update this again.

### 4. Update specs

Expected spec updates:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `plan/send-tool-update/send-tool-update.spec.md` if phase scope changes
- `bud.spec.md` if related docs or architecture index entries change

If the implementation touches additional folders, update their specs too.

### 5. Run targeted automated tests

Recommended targeted service tests:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test \
  src/agent/model-runner.test.ts \
  src/agent/contracts.test.ts \
  src/agent/conversation-loader.test.ts \
  src/agent/terminal-tool-executor.test.ts \
  src/agent/terminal-send-outcome.test.ts \
  src/agent/transcript-writer.test.ts \
  src/runtime/agent-runtime-state.test.ts \
  src/llm/providers/providers.test.ts \
  src/llm/provider-ledger.test.ts
```

Run broader package tests if the targeted set passes and the touched area warrants it:

```bash
pnpm --dir /Users/adam/bud/service test
pnpm --dir /Users/adam/bud/web test
```

If a command fails, record the exact command and error output in a debug note and stop for human guidance per repo policy.

### 6. Complete manual validation

Use [validation-checklist.md](./validation-checklist.md) to validate:

- shell command
- raw text without Enter
- pager key
- REPL command
- confirmation command
- interrupt key
- Enter-only key
- multiline command

## Acceptance Criteria

- No model-facing docs or tests teach `terminal.send` as `text` plus `submit`.
- Provider tests and fixtures use `command`, `raw_text`, and `key`.
- First-party renderer displays the new gestures accurately.
- `submitted` is not displayed as "command submitted" or "Enter pressed".
- Protocol docs clearly distinguish model-facing gestures from the current Bud wire adapter.
- All touched folder specs are updated.
- Targeted tests pass or a debug note captures the exact failure and the work stops.
