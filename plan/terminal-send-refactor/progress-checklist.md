# Progress Checklist: `terminal.send` Settled-By-Default Refactor

- [x] Create the plan folder, parent implementation spec, phase docs, and checklist docs
- [x] Add the new plan folder to the root `bud.spec.md` documentation index
- [x] Extend Bud terminal-session state with shared output-activity metadata
- [x] Update the existing `pipe-pane` watcher to maintain the new output-activity fields
- [x] Add a Bud-side quiescence wait helper with centralized defaults
- [x] Refactor Bud `terminal.send` to use baseline capture -> dispatch -> quiescence wait -> final capture
- [x] Keep repeated `capture-pane` polling out of the hot wait loop
- [x] Define and ship explicit settled-vs-timeout send-result semantics
- [x] Align Bud/service protocol fields and service runtime types with the new result contract
- [x] Make `terminal.send` settled-by-default in the service/runtime path
- [x] Add or confirm `terminal.observe(wait_for:"settled")` longer-wait behavior
- [x] Update agent guidance so immediate observe is no longer the normal expectation
- [x] Update developer-visible tool summaries/rendering where needed for settled vs timeout clarity
- [x] Add debug-gated diagnostics for quiet-window tuning
- [x] Add focused automated coverage where practical
- [ ] Run the manual validation checklist
- [x] Update protocol docs and relevant Bud/service/web specs
- [x] Record any deferred async-job or callback follow-up explicitly

Deferred follow-up: true async callbacks / wake-ups, multi-job orchestration, and "notify me when this finishes later" behavior remain intentionally out of scope for this synchronous refactor and should land as a separate design/plan if timeout-based partial-progress turns out to be insufficient.
