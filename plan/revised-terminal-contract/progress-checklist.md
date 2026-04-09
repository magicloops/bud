# Progress Checklist: Revised Terminal Contract

## Phase 1: Service Tool Contract And Agent Harness

- [ ] Replace `terminal.run` / `terminal.capture` tool definitions with `terminal.exec` / `terminal.send` / `terminal.observe`
- [ ] Remove shell-command `\n` guidance from the system prompt
- [ ] Redesign service-side tool result types around `kind`
- [ ] Update tool persistence and summaries for the new names
- [ ] Update runtime-stream/tool-call test fixtures

## Phase 2: Runtime And Bud Protocol Cutover

- [ ] Add service runtime methods for exec/send/observe
- [ ] Rewrite service terminal protocol types
- [ ] Rewrite gateway schemas and routing for the new message family
- [ ] Implement Bud-side exec/send/observe handlers
- [ ] Keep browser manual input working on the low-level path

## Phase 3: Context Policy And Observation Semantics

- [ ] Enforce shell-only behavior for `terminal.exec`
- [ ] Update REPL/TUI launch and exit tracking around `terminal.send`
- [ ] Refresh context snapshots after the right operations
- [ ] Normalize wait semantics (`shell_ready`, `screen_stable`, `none`)
- [ ] Add structured follow-up hints / definitive flags where needed
- [ ] Update developer-visible tool rendering if required

## Phase 4: Tests, Docs, And Developer Cutover

- [ ] Update service tests for new tool names and payloads
- [ ] Add targeted Bud tests where practical
- [ ] Update `docs/proto.md`
- [ ] Update touched specs
- [ ] Document local developer cutover expectations
- [ ] Complete manual validation on a fresh local stack
