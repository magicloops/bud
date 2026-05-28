# Phase 3: Cleanup, Metrics, And Validation

## Objective

Finalize the terminal freshness rollout by retiring the old normal-send preflight summary path, adding observability, updating documentation/specs, and validating the latency and correctness tradeoff.

## Scope

- Remove or quarantine request-time context-sync summary injection for normal user sends.
- Keep any remaining context-sync code only for explicit maintenance/debug flows if it still has a use.
- Add logs or metrics for freshness behavior.
- Update related design/spec docs to mark preflight context sync as superseded for normal sends.
- Run automated tests and manual validation.

## Metrics

Add structured logs or counters for:

- normal sends that skip preflight context sync
- freshness snapshots by state: `clean`, `may_have_changed`, `unknown`
- freshness dirty reasons
- transient freshness hints applied
- first provider step after a freshness hint calls `terminal.observe`
- stale-state correction patterns if detectable
- send-route latency before/after removal, if existing request timing infrastructure can report it
- context-sync summary LLM calls remaining after rollout

Metrics should be internal. Do not add product UI.

## Cleanup

Expected cleanup actions:

- ensure `POST /messages` no longer calls `contextSyncService.checkAndSync(...)` for normal sends
- delete unreachable route wiring if the context-sync service is no longer used
- otherwise move context sync behind explicit debug/maintenance ownership and document that it is not in the normal send path
- remove tests that assert preflight context message insertion on normal sends
- replace them with freshness hint and terminal tool observation tests

## Docs And Specs

Update:

- [../../design/terminal-context-sync.md](../../design/terminal-context-sync.md) to mark preflight context sync as superseded for normal sends
- [../../design/terminal-freshness-hints.md](../../design/terminal-freshness-hints.md) if rollout decisions changed during implementation
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/runtime/runtime.spec.md`
- `bud.spec.md`
- [terminal-freshness.spec.md](./terminal-freshness.spec.md)
- [validation-checklist.md](./validation-checklist.md)

## Automated Verification

Run the focused service tests added in Phases 1 and 2. Then run the normal package verification that is practical for the touched areas, for example:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test <focused-test-files>
```

Follow repo guidance if a build/run command fails: capture the exact command and error in a debug note, then stop for human direction.

## Manual Validation

Use a local online Bud and validate:

- rapid chat back-and-forth on an idle thread does not trigger preflight observe
- a general question after terminal output changes can answer without observing when terminal state is irrelevant
- "what happened?" after terminal output changes causes the model to call `terminal.observe`
- manual browser-terminal input after the latest tool result produces a freshness hint
- cwd changes after the latest tool result produce a freshness hint through the unified watermark
- a no-visible-output send advances the model-visible watermark
- offline Bud sends still produce offline-aware assistant responses

## Acceptance Criteria

- [ ] The old context-sync preflight path is no longer part of normal message sends.
- [ ] Freshness metrics/logs are available for internal review.
- [ ] Docs and specs reflect terminal freshness hints as the active design.
- [ ] Validation checklist is completed or has explicit unchecked items with notes.
- [ ] Any deferred database-cache-table work is recorded as follow-up, not hidden in code comments.
