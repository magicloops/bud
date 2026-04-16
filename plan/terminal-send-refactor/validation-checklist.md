# Validation Checklist: `terminal.send` Settled-By-Default Refactor

Manual validation pending.

## Automated Verification Completed

- [x] `cargo test --manifest-path bud/Cargo.toml`
- [x] `pnpm --dir service exec node --import tsx --test src/agent/terminal-send-outcome.test.ts src/agent/agent-service.test.ts src/runtime/terminal-session-manager.test.ts`

## Quick Shell Commands

- [ ] `pwd` or `git status` completes through a single `terminal.send` without an immediate `terminal.observe`
- [ ] The returned delta reflects the post-command rendered state rather than dispatch-only success
- [ ] A command that produces little or no visible output is handled as unchanged/ambiguous rather than falsely successful

## Interactive Startup / TUI / REPL

- [ ] A TUI or REPL that emits startup bytes keeps the send call open while output is still changing
- [ ] The send result returns once the interactive screen reaches a stable state
- [ ] Claude Code or an equivalent shared-session interactive tool is spot-checked

## Bursty Output Robustness

- [ ] A bursty command does not settle on the first brief quiet pause
- [ ] The chosen quiet-window defaults still feel responsive in fast cases

## Timeout / Partial Progress

- [ ] An intentionally long-running command times out into a partial-progress send result
- [ ] Timeout returns the latest rendered delta plus conservative still-processing semantics
- [ ] Timeout is not surfaced as if the command completed successfully

## Explicit Longer Waits

- [ ] `terminal.observe(wait_for:"settled")` can wait longer after a send timeout
- [ ] A single longer observe can replace repeated immediate poll loops in the test scenario

## Browser / Streaming Non-Regression

- [ ] Browser terminal live streaming still works
- [ ] History backfill and attach/recovery still work
- [ ] No unexpected regression appears in the SSE terminal plane

## Docs / Specs

- [x] `docs/proto.md` reflects the shipped send and observe semantics
- [x] Relevant Bud/service/web specs are updated
- [x] `bud.spec.md` includes the new plan references and still reads coherently
