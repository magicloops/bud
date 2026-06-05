# Validation Checklist: Send Tool Update

**Parent Spec**: [implementation-spec.md](./implementation-spec.md)

---

## Automated Validation

### Service build

- [x] `pnpm --dir /Users/adam/bud/service build`

Result: passed after fixing the executor resolver narrowing issue.

### Service agent tests

- [x] `service/src/agent/model-runner.test.ts`
- [x] `service/src/agent/contracts.test.ts`
- [x] `service/src/agent/conversation-loader.test.ts`
- [x] `service/src/agent/terminal-tool-executor.test.ts`
- [x] `service/src/agent/terminal-send-outcome.test.ts`
- [x] `service/src/agent/transcript-writer.test.ts`
- [x] `service/src/runtime/agent-runtime-state.test.ts`

Suggested command:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test \
  src/agent/model-runner.test.ts \
  src/agent/contracts.test.ts \
  src/agent/conversation-loader.test.ts \
  src/agent/terminal-tool-executor.test.ts \
  src/agent/terminal-send-outcome.test.ts \
  src/agent/transcript-writer.test.ts \
  src/runtime/agent-runtime-state.test.ts
```

Result: passed, 54 tests.

### Provider tests

- [x] `service/src/llm/providers/providers.test.ts`
- [x] `service/src/llm/provider-ledger.test.ts`

Suggested command:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test \
  src/llm/providers/providers.test.ts \
  src/llm/provider-ledger.test.ts
```

Result: passed, 30 tests.

### Runtime/wire tests

Only required if runtime or Bud wire code changes:

- [ ] `service/src/runtime/terminal/request-dispatcher.test.ts`
- [ ] `service/src/proto/wire.test.ts`
- [ ] Bud daemon terminal interaction tests

Suggested commands:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test \
  src/runtime/terminal/request-dispatcher.test.ts \
  src/proto/wire.test.ts
cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml
```

### Web rendering tests

- [x] Web renderer tests or package tests if present for tool rendering.

Completed command:

```bash
pnpm --dir /Users/adam/bud/web build
```

Result: passed.

Suggested command:

```bash
pnpm --dir /Users/adam/bud/web test
```

## Manual Validation

Run these against a local Bud terminal session after implementation.

### Shell command

- [ ] Agent calls `terminal.send` with `{ "command": "whoami" }`.
- [ ] Terminal executes the command and returns the username plus prompt.
- [ ] Tool result shows `enter_requested:true`.
- [ ] Tool summary says Enter was pressed/requested.

### Raw text without Enter

- [ ] Agent calls `terminal.send` with `{ "raw_text": "whoami" }`.
- [ ] Terminal shows `whoami` at the prompt without command output.
- [ ] Tool result shows `enter_requested:false`.
- [ ] Tool summary clearly says Enter was not pressed/requested.

### Enter-only key

- [ ] Agent calls `terminal.send` with `{ "key": "enter" }`.
- [ ] Terminal submits the currently typed line.
- [ ] Result shows key gesture metadata, not command metadata.

### Pager key

- [ ] Open `less` or another pager.
- [ ] Agent calls `terminal.send` with `{ "key": "q" }`.
- [ ] Pager exits without requiring Enter.

### REPL line input

- [ ] Launch Python or Node.
- [ ] Agent calls `terminal.send` with `{ "command": "print('hello')" }` or equivalent.
- [ ] REPL receives the line and executes/evaluates it.

### Confirmation prompt

- [ ] Trigger a simple confirmation prompt.
- [ ] Agent calls `terminal.send` with `{ "command": "y" }` or `{ "command": "yes" }`.
- [ ] Confirmation is submitted.

### Interrupt key

- [ ] Start a foreground command or TUI that can be interrupted.
- [ ] Agent calls `terminal.send` with `{ "key": "ctrl+c" }`.
- [ ] Interrupt is delivered through the normal send path.
- [ ] Summary remains evidence-based if no visible change occurs.

### Multiline command

- [ ] Agent sends a heredoc or short multiline script with `command`.
- [ ] Embedded newlines are sent as line breaks.
- [ ] Final Enter is sent.
- [ ] Result settles or times out with current terminal readiness semantics.

## Failure Handling

If any build or test command fails, record:

- exact command
- exact error output
- environment notes
- suspected affected phase

Then stop for human guidance before trying alternative command flags.
