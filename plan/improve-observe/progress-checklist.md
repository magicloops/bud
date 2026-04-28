# Progress Checklist: Improve Settled Terminal Observation

- [x] Create the plan folder, parent implementation spec, phase docs, and checklist docs
- [x] Add the new plan folder to the root `bud.spec.md` documentation index
- [x] Add central service-owned terminal wait policy constants
- [x] Apply one-hour timeout to `terminal.send` settled waits
- [x] Apply one-hour timeout to `terminal.observe(wait_for:"settled")`
- [x] Keep non-settled wait modes on shorter defaults
- [x] Stop advertising arbitrary `timeout_ms` as a normal model-facing control
- [x] Clamp or ignore model-supplied timeout values under service policy
- [x] Update agent prompt guidance around settled waits
- [x] Add daemon post-dispatch guard for send quiescence
- [x] Start send quiescence/readiness sampling after dispatch plus guard
- [x] Preserve pre-send-to-final send delta semantics, including command echo
- [x] Make settled readiness evidence-based instead of quiet-byte-based
- [x] Add Codex-style echo-only readiness regression coverage
- [x] Confirm prompt/confirmation/password/pager readiness remains high confidence
- [x] Confirm terminal SSE remains live during long pending tools
- [x] Define and implement human interrupt behavior for pending settled waits
- [x] Ensure cancel/offline/session-close rejection works for long pending waits
- [x] Add debug logging for long settled waits
- [x] Decide public `wait_for` mode set after settled behavior lands
- [x] Remove or justify `shell_ready` in the model-facing schema
- [x] Keep `screen_stable` as a legacy alias or document a migration away from it
- [x] Clarify `none` as an explicit fast/no-output workflow
- [x] Add wait-mode cleanup tests for schema, parser compatibility, and observe restrictions
- [x] Update protocol docs
- [x] Update Bud/service/root specs
- [x] Run or explicitly defer the manual validation checklist

Deferred follow-up: true async callbacks / wake-ups, multi-job orchestration, and "notify me when this finishes later" behavior remain intentionally out of scope.
