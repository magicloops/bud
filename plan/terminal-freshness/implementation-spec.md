# Implementation Spec: Terminal Freshness Hints

**Status**: Implemented initial service pass
**Created**: 2026-05-28
**Design Doc**: [../../design/terminal-freshness-hints.md](../../design/terminal-freshness-hints.md)
**Review Doc**: [../../review/bud-offline-roundtrip-review.md](../../review/bud-offline-roundtrip-review.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-disable-preflight-and-freshness-hint-plumbing.md](./phase-1-disable-preflight-and-freshness-hint-plumbing.md)
**Phase 2**: [phase-2-terminal-visibility-watermarks.md](./phase-2-terminal-visibility-watermarks.md)
**Phase 3**: [phase-3-cleanup-metrics-and-validation.md](./phase-3-cleanup-metrics-and-validation.md)

---

## Context

Bud currently has a pre-message context-sync path that can call `terminal_observe` before the user message is persisted and before the primary agent LLM call. That path protects the model from stale terminal state, but it also adds fixed latency to many ordinary chat turns.

The current product direction is to keep user-to-assistant roundtrips thin. The service should not inspect the Bud terminal unless current terminal state is actually needed. Instead, the service should give the model a cheap warning when terminal state may have changed since the last model-visible terminal result, and let the model call `terminal.observe` during the agent turn if terminal freshness matters.

## Objective

Replace default request-time terminal context sync with internal terminal freshness hints:

- no default pre-LLM `terminal_observe` on normal message sends
- no default pre-LLM context-summary LLM call
- cheap service-side dirty detection from terminal/session/message state
- transient model hint when terminal state may be stale
- unified terminal visibility watermark advanced by terminal tool results
- no first-pass browser/mobile API surface

## Fixed Decisions

- `POST /messages` should not observe the Bud terminal by default.
- No rollback flag is required for disabling preflight context sync.
- Freshness state is internal for the first implementation.
- The model hint is enough; no user-message classifier is needed for phrases like "continue" or "what happened."
- Offline Bud mode suppresses terminal freshness hints because terminal tools are unavailable.
- `terminal.send` with no visible output still advances the model-visible terminal watermark if readiness/context/cwd/dispatch facts were shown to the model.
- Cached cwd and readiness/context changes participate in the same unified watermark as output byte offsets.
- Concrete terminal content should only be persisted when the system actually observed it through a terminal tool or send result.

## Success Criteria

- [x] Existing-session online sends no longer call `terminal_observe` before the primary agent LLM call.
- [x] Offline sends continue to use offline environment guidance and do not add a terminal freshness hint.
- [x] Dirty online terminal state produces one short transient freshness hint before the provider call.
- [x] Clean online terminal state produces no freshness hint.
- [x] `terminal.send` and `terminal.observe` persisted tool rows include enough metadata to derive model-visible terminal watermarks.
- [x] A no-visible-output `terminal.send` that exposes terminal facts still advances the model-visible watermark.
- [x] Human terminal input, new output bytes, cwd changes, and readiness/context changes can make the terminal dirty through one unified decision path.
- [x] Web and mobile response contracts remain unchanged.
- [x] Specs and docs mark the old preflight context-sync path as superseded for normal user sends.

## Non-Goals

- adding a new database table in the first implementation
- changing the Bud daemon wire protocol
- removing `terminal.observe`
- exposing terminal freshness state to clients
- building an LLM classifier for message intent
- perfectly detecting every stale-terminal case
- persisting unobserved terminal guesses as transcript context

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-disable-preflight-and-freshness-hint-plumbing.md](./phase-1-disable-preflight-and-freshness-hint-plumbing.md) | Urgent | Remove the blocking preflight observe path and add transient freshness-hint plumbing |
| 2 | [phase-2-terminal-visibility-watermarks.md](./phase-2-terminal-visibility-watermarks.md) | High | Persist terminal visibility metadata and compute clean/dirty state from unified watermarks |
| 3 | [phase-3-cleanup-metrics-and-validation.md](./phase-3-cleanup-metrics-and-validation.md) | High | Retire old normal-send context sync, add metrics, update docs/specs, and validate |

## Expected Files And Areas

### Service

- `service/src/routes/threads/messages.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/environment.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/terminal/session-store.ts`
- `service/src/terminal/context-sync-service.ts`
- new helper under `service/src/terminal/` or `service/src/agent/` for freshness calculation

### Tests

- `service/src/routes/threads/messages*.test.ts` or route integration coverage if available
- `service/src/agent/agent-service.test.ts`
- `service/src/agent/conversation-loader.test.ts`
- `service/src/agent/transcript-writer.test.ts`
- focused tests for the new freshness helper

### Docs / Specs

- `design/terminal-freshness-hints.md`
- `design/terminal-context-sync.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/runtime/runtime.spec.md`
- `plan/terminal-freshness/terminal-freshness.spec.md`
- `bud.spec.md`

## Implementation Shape

Introduce a small internal freshness contract:

```typescript
type TerminalFreshnessSnapshot = {
  sessionId: string | null;
  state: "clean" | "may_have_changed" | "unknown";
  reasons: string[];
};
```

Phase 1 may start conservative and coarse. Phase 2 should refine this into a unified watermark comparison that includes output bytes, cwd, readiness/context, status, and human input.

The model hint should be injected as transient provider context, close to the existing environment instruction flow. It should not be persisted as a normal `system` message.

Recommended hint:

```text
Terminal freshness notice: terminal activity may have changed since the last model-visible terminal result. The service did not inspect the current terminal state before this response. If your answer or next action depends on the current terminal, call terminal.observe before making device-specific claims or acting on terminal state.
```

## Impacted Contracts

- [ ] WSS protocol: no first-pass change
- [ ] SSE events: no first-pass change
- [ ] DB schema: no first-pass change
- [ ] Agent tools: no tool schema change
- [ ] Web UI: no first-pass change
- [ ] Mobile: no first-pass change
- [x] Message metadata: add internal `terminal_visibility` metadata on terminal tool result rows

## Sequencing Notes

- Phase 1 should remove the fixed latency first, even if the first dirty signal is coarse.
- Phase 2 should make the freshness signal accurate enough to avoid noisy hints.
- Phase 3 should remove or quarantine old context-sync paths only after Phase 2 has sufficient coverage.
- Do not add UI work unless validation shows users need visible freshness state.
- Do not add a new table unless deriving the latest watermark from messages becomes observably expensive.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The model ignores the freshness hint and reasons from stale terminal state | Medium | High | Phrase the hint as an observe-first instruction for terminal-dependent claims/actions; track stale-state incidents |
| Freshness is too noisy and adds prompt clutter | Medium | Medium | Use one short hint and refine dirty reasons through Phase 2 watermarks |
| Freshness is too quiet and misses out-of-band terminal changes | Medium | High | Treat unknown watermarks conservatively and include human input/output/cwd/readiness signals |
| Message-history queries for last watermark are expensive | Low initially | Medium | Start without a table; add a cache table only if metrics show it is needed |
| Removing preflight context sync reduces transcript continuity | High | Low/Medium | Accept this as product direction; only persist observed terminal content |
| Existing tests assume context-sync message insertion | Medium | Medium | Update tests to target freshness hints and explicit terminal tool observations instead |

## Definition Of Done

- [x] Normal message sends do not block on request-time `terminal_observe`.
- [x] Dirty terminal state adds a transient freshness hint to provider context.
- [x] Offline Bud turns do not ask the model to call unavailable terminal tools.
- [x] Terminal tool result metadata records model-visible terminal watermarks.
- [x] Clean/dirty freshness tests cover output bytes, human input, cwd, readiness/context, and no-visible-output sends.
- [x] Web and mobile API contracts remain unchanged.
- [x] Old context-sync docs are marked superseded or narrowed to non-normal-send/debug use.
- [ ] Manual validation confirms faster conversational turns and correct observe behavior when terminal state matters.
