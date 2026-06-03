# Context Drift Progress Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 1 complete; Phase 2 implementation complete, ds4 validation pending
**Last Updated**: 2026-06-02

---

## Phase 1: Canonical Recorder Foundation

- [x] Add `AGENT_CONTEXT_DRIFT_DEBUG` config field
- [x] Document the flag in `service/.env.example`
- [x] Add `.bud-debug/` to `.gitignore`
- [x] Add JSON config loader for `.bud-debug/model-context-drift.config.json`
- [x] Define prompt snapshot schema
- [x] Define response snapshot schema
- [x] Implement exact and semantic hash helpers
- [x] Implement canonical prompt snapshot builder
- [x] Implement canonical response snapshot builder
- [x] Implement prompt-to-prompt diff engine
- [x] Implement response-continuity check
- [x] Implement tool catalog diff
- [x] Implement model config diff
- [x] Implement JSON artifact writer
- [x] Implement Markdown diff writer
- [x] Add recorder unit tests

## Phase 2: Agent Integration And ds4 Debugging

- [x] Instantiate recorder only when enabled
- [x] Capture prompt snapshots before provider invocation
- [x] Capture response snapshots after canonical reconstruction
- [x] Emit bounded structured drift log summaries
- [x] Ensure disabled mode writes no files
- [x] Add model-runner integration tests
- [x] Update service env docs
- [x] Update service/agent specs
- [ ] Run ds4 local web-agent reproduction with recorder enabled
- [ ] Record first drift findings in debug notes

## Phase 3: Provenance And Provider-Rendered Snapshots

- [ ] Decide whether Phase 3 is needed after Phase 2 ds4 output
- [ ] Add recorder-only message provenance if needed
- [ ] Include sanitized reconstruction diagnostics if needed
- [ ] Add optional provider debug-rendering interface if needed
- [ ] Implement ds4 rendered request snapshots if needed
- [ ] Extend diffs with rendered request comparisons if needed
- [ ] Add provider-rendered snapshot tests if needed
- [ ] Update LLM/provider specs if Phase 3 lands

## Closeout

- [ ] Complete validation checklist
- [x] Confirm artifacts are gitignored
- [x] Confirm default output avoids full prompt text
- [x] Confirm disabled mode has negligible overhead
- [ ] Decide whether to keep instrumentation after ds4 issue is resolved
