# Context Drift Validation Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Automated canonical recorder and runner-hook validation passed; manual ds4 validation pending
**Last Updated**: 2026-06-02

---

## Automated Validation

### Config And Safety

- [x] `AGENT_CONTEXT_DRIFT_DEBUG` defaults to disabled
- [x] disabled mode creates no output directory or files
- [x] enabled mode loads default config when JSON config is absent
- [x] invalid JSON config disables recorder and logs a warning
- [ ] unknown JSON config keys log a warning and are ignored
- [x] `.bud-debug/` is ignored by git
- [x] default snapshots do not include full prompt text
- [x] `includeText: true` includes full text only in local artifacts

### Snapshot Builder

- [x] prompt snapshot includes thread/turn/provider/model metadata
- [x] prompt snapshot includes message summaries
- [x] prompt snapshot includes tool summaries
- [x] prompt snapshot includes model config summary
- [x] response snapshot includes stop reason and usage
- [x] response snapshot includes text/tool/reasoning summaries
- [x] exact hash detects object-order differences
- [x] semantic hash ignores object-order differences
- [x] previews are bounded by config

### Diff Engine

- [x] append-only prompt growth is reported as append-only
- [ ] top-of-prompt insertion is reported as drift
- [ ] middle message rewrite is reported as drift
- [ ] tool count change is reported
- [ ] tool order change is reported
- [ ] tool schema hash change is reported
- [ ] model config change is reported
- [ ] prior assistant text replay is found when present
- [x] prior assistant tool-call replay is found when present
- [ ] missing tool result is reported

### Agent Integration

- [x] prompt snapshot is captured before provider invocation
- [x] response snapshot is captured after provider response reconstruction
- [ ] provider error preserves prompt snapshot and omits response snapshot
- [ ] adjacent provider calls in one tool loop produce a diff artifact
- [ ] structured log summary omits full text
- [x] provider/model filters skip non-matching calls
- [ ] context-window retry does not crash recorder

### Optional Phase 3

- [ ] provenance labels identify runtime environment and terminal freshness messages
- [ ] reconstruction diagnostics are sanitized
- [ ] providers without debug-rendering hooks continue to work
- [ ] ds4 rendered request summaries are deterministic
- [ ] ds4 rendered snapshots avoid full text by default
- [ ] rendered diff identifies provider message/tool drift

## Manual Validation

### ds4 Cache-Miss Reproduction

- [ ] Configure ds4 direct provider locally
- [ ] Set `AGENT_CONTEXT_DRIFT_DEBUG=1`
- [ ] Optionally filter config to provider `ds4`
- [ ] Reproduce the web-agent flow that yielded repeated ds4 `common=3673` misses
- [ ] Confirm prompt snapshots are written
- [ ] Confirm response snapshots are written
- [ ] Confirm adjacent-call diff Markdown is written
- [ ] Compare first drift index with ds4 cache log common-prefix behavior
- [ ] Determine whether drift is in messages, tools, model config, assistant replay, or provider rendering

### Safety Check

- [ ] Stop service, disable `AGENT_CONTEXT_DRIFT_DEBUG`, restart service
- [ ] Confirm no new drift artifacts are written
- [ ] Confirm normal OpenAI/Anthropic behavior remains unchanged
- [ ] Confirm `.bud-debug/` artifacts are not shown as untracked git files

## Documentation And Handoff

- [x] `service/.env.example` documents the single local flag
- [x] `service/service.spec.md` documents local debug artifact behavior
- [x] `service/src/agent/agent.spec.md` documents model-context drift recorder ownership
- [ ] `service/src/llm/llm.spec.md` updated if provider debug-rendering interface lands
- [ ] `service/src/llm/providers/providers.spec.md` updated if ds4 rendered snapshots land
- [ ] ds4 debug findings are linked from [../../debug/ds4-live-kv-cache-token-mismatch.md](../../debug/ds4-live-kv-cache-token-mismatch.md) or a follow-up debug note
