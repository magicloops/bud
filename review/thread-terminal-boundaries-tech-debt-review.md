# Branch Review: `thread-terminal-boundaries` vs `origin/main`

**Reviewed:** 2026-04-14  
**Scope:** `origin/main...HEAD` on `thread-terminal-boundaries`  
**Method:** static diff/code/spec/design-plan-debug review; I did not run builds or tests.

## Diff Profile

Overall diff:

- 56 files changed
- `+7348 / -921`

Top-level net change by area:

| Area | Files | Net lines |
|---|---:|---:|
| `plan/` | 16 | `+1921` |
| `design/` | 4 | `+1774` |
| `debug/` | 5 | `+568` |
| `reference/` | 1 | `+281` |
| `service/` | 13 | `+807` |
| `bud/` | 3 | `+479` |
| `web/` | 10 | `+480` |
| `AGENTS.md` + `TODO.md` | 2 | `+62` |

The non-code planning/debug/process additions alone are roughly `+4606` net lines, versus roughly `+1766` net lines across `bud/`, `service/`, and `web/`.

## Summary

The branch is directionally solving a real problem, but the strongest evidence in the current codebase points to a narrower real fix than the rest of the branch implies.

What appears to have actually resolved the terminal-character issue is:

- unsupported human control/escape bytes now fall back into the structured `terminal.send` path instead of depending on the raw browser `/terminal/input` pipe
- browser-generated xterm `emulator_protocol` is now suppressed by default rather than forwarded upstream merely because xterm emitted it

That behavior is visible in:

- `web/src/lib/thread-terminal-controller.ts`
- `web/src/lib/terminal-xterm-input.ts`
- `docs/proto.md`

If that is the true fix point, then the debt issue is scope. A narrow boundary bug pulled in a durable browser-input redesign, optional send-observation semantics, rich bootstrap contracts, stream-resume changes, and unrelated repo-process/template work that may not have been necessary to eliminate the original symptom.

Compared to `origin/main`, the branch is much harder to review, much harder to cherry-pick, and much more expensive to keep aligned across daemon, service, web, specs, and planning docs. Simple is not the dominant property of this branch anymore.

## Debt Created By This Branch

### 1. Cross-layer contract multiplication for one bug class

The branch adds permanent protocol and API surface across all three tiers:

- `terminal_send.observe`
- `dispatch_only` readiness
- `terminal.observe` views: `delta | screen | history`
- browser bootstrap kinds: `grid | text | unavailable`
- `screen_state` metadata: cursor, pane size, capture scope, pane mode, wraps
- terminal stream durable resume via `after_offset`
- explicit `terminal.resync_required`

This is spread across:

- `bud/src/main.rs`
- `service/src/terminal/types.ts`
- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `web/src/lib/api.ts`
- `web/src/lib/thread-terminal-controller.ts`
- `docs/proto.md`

Debt: the branch fixed a boundary issue by creating a much broader long-lived contract surface, which now needs phase-9/10 cleanup docs just to stay understandable.

### 2. Multiple sources of truth for key/input semantics

The same interaction model now exists in three places:

- browser escape/key parsing in `web/src/lib/thread-terminal-controller.ts`
- service-side audit reconstruction in `service/src/routes/threads.ts`
- Bud tmux dispatch mapping in `bud/src/main.rs`

Concrete examples:

- `ESCAPE_SEQUENCE_TO_KEY`
- `TERMINAL_AUDIT_KEY_TO_BYTES`
- `resolve_interaction_key_dispatch_action(...)`

Debt: every new key or behavior needs synchronized updates in browser, service, and daemon. That creates drift risk between what the UI sends, what the service audits, and what Bud actually dispatches.

### 3. Xterm private-API coupling is now part of correctness

`web/src/lib/terminal-xterm-input.ts` depends on xterm internals:

- `terminal._core.coreService.onData`
- `terminal._core.coreService.onUserInput`

If those internals are unavailable, the fallback path logs a warning and treats all outbound data as `human`.

Debt: the core protection against replay/protocol leakage now depends on a private xterm hook with no browser-side automated coverage. An xterm upgrade can silently collapse the distinction the branch is built around.

### 4. The browser terminal path still carries dead or transitional transport surface

The controller/route still model raw transport even after emulator protocol was intentionally suppressed:

- `sendRaw` remains in the transport interface
- `sendTerminalRaw(...)` remains wired in the route
- `/api/threads/:threadId/terminal/input` remains mounted
- `isAllowlistedEmulatorProtocol(...)` currently returns `false`

Debt: the branch carries more code and more contract than it actively uses. That is rollout scaffolding left behind as production surface.

### 4a. Phase 10 looks like the minimal effective fix, which makes the earlier branch scope look overfit

The current implementation strongly suggests the key behavioral change was not the whole contract expansion. It was:

- classify xterm output into `human` vs `emulator_protocol`
- drop `emulator_protocol` by default
- pass unsupported human terminal bytes through the structured send function as literal text instead of switching transport modes

Concretely:

- `attachClassifiedTerminalInput(...)` in `web/src/lib/terminal-xterm-input.ts` marks non-user xterm output as `emulator_protocol`
- `isAllowlistedEmulatorProtocol(...)` in `web/src/lib/thread-terminal-controller.ts` currently always returns `false`
- `parseHumanTerminalInput(...)` falls back to `{ kind: 'send', request: { text: data } }` for unsupported human escape/control sequences
- `docs/proto.md` now says reference web clients should route unsupported human control/escape sequences through structured send and should not forward browser-generated emulator replies upstream by default

Debt: if this Phase 10 behavior is the real fix, then much of the earlier branch likely solved an over-broad diagnosis rather than the actual failure mode. That raises the odds that the branch contains architecture that is defensible in isolation but unnecessary for this incident.

### 5. Rich bootstrap is a larger contract without full fidelity

The branch adds a richer bootstrap contract, but it also explicitly leaves major fidelity gaps:

- style/color loss on TUI reopen
- text degradation when geometry mismatches
- degraded blank-line trimming heuristics
- follow-up docs already required for cursor/bootstrap validation

Evidence is explicit in:

- `debug/thread-terminal-tui-colors-missing-after-bootstrap.md`
- `debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md`
- `TODO.md`

Debt: the branch paid the cost of a richer bootstrap protocol without actually finishing the hard part of faithful TUI restore.

### 6. Typing latency was improved, but the transport is still fundamentally head-of-line blocked

`ThreadTerminalController` still serializes sends behind a `sendQueue`, and browser typing still depends on HTTP request completion for each flushed text batch.

The branch removed the worst `observe` delay for browser typing, but it did not simplify the underlying transport model.

Debt: a lot of protocol and controller complexity was added, yet the basic human-typing path is still an ordered request queue rather than a simpler low-latency transport primitive.

## Debt Exacerbated By This Branch

### 7. Existing god files got larger instead of smaller

The branch added new modules, but the largest integration files still absorbed more responsibility:

| File | `origin/main` | Branch |
|---|---:|---:|
| `bud/src/main.rs` | 4338 lines | 4810 lines |
| `service/src/routes/threads.ts` | 1011 lines | 1435 lines |
| `service/src/runtime/terminal-session-manager.ts` | 1686 lines | 1828 lines |
| `service/src/agent/agent-service.ts` | 1650 lines | 1690 lines |
| `web/src/routes/$budId/$threadId.tsx` | 1990 lines | 2038 lines |
| `web/src/lib/thread-terminal-controller.ts` | new | 361 lines |

This is most obvious in:

- `bud/src/main.rs`, which now holds more protocol parsing, tmux dispatch planning, visible-screen capture, wait logic, and tests
- `service/src/routes/threads.ts`, which now owns thread CRUD, agent routes, terminal bootstrap, terminal replay planning, input auditing, send routing, raw fallback, and SSE wiring
- `web/src/routes/$budId/$threadId.tsx`, which still owns chat timeline, agent SSE, terminal lifecycle, reconnect policy, bootstrap orchestration, and status UI even after the controller extraction

Debt: conceptual boundaries improved, but physical ownership did not improve enough to make the codebase simpler.

### 8. Validation burden grew much faster than executable coverage

The branch changed daemon, service, browser, protocol docs, specs, and runtime semantics, but the added automated coverage is narrow:

- `service/src/agent/terminal-send-outcome.test.ts`
- `service/src/runtime/event-bus.test.ts`
- a few new unit tests in `bud/src/main.rs`

Missing coverage is notable for:

- browser input classification
- browser controller bootstrap hydration
- geometry mismatch handling
- `/terminal/state` and `/terminal/send` route behavior
- cross-tier replay/resync behavior

The manual validation plan is large, but `plan/thread-terminal-boundaries/validation-checklist.md` is still mostly unchecked.

Debt: the branch relies heavily on manual reenactment of terminal behavior instead of executable confidence.

### 9. The branch mixes terminal work with unrelated process/template changes

In the same branch, we also get:

- `AGENTS.md` workflow expansion
- `plan/portable-agents-template.md`
- `AGENTS.template.md` references added into the root spec/docs index

That work may be reasonable on its own, but it is unrelated to the terminal-character issue.

Debt: this widens the PR for no terminal-runtime gain and makes future archaeology, revert selection, and merge review harder.

### 10. Contract tightening happened in-place, which raises branch skew cost

The plan explicitly removes compatibility for:

- flat observe fields on `terminal_send`
- transitional `/terminal/state.snapshot`

The phase-9 notes also explicitly accept that stale branches/tools may break until they adopt the new shape.

Debt: for an internal codebase this may be tolerable, but it increases coordination cost for any concurrent terminal-stack work because the contract moved in place rather than behind a cleaner version boundary or adapter layer.

## Recommended Trim Candidates Before Merge

If the goal is to keep the fix robust and simple, these are the first places I would cut or split:

- Split the repo-process/template work out of this branch:
  - `AGENTS.md`
  - `plan/portable-agents-template.md`
  - related root-spec indexing
- Keep the minimum terminal-boundary fix set that actually solved the bug, and reconsider whether phases 7-10 belong in the same merge window.
- Remove dead raw-transport scaffolding if emulator protocol is now intentionally suppressed:
  - `sendRaw`
  - any unused allowlist plumbing
  - any route/docs that no longer have an active caller
- Centralize key mapping instead of maintaining separate browser/service/Bud lookup tables.
- Push more terminal orchestration out of `web/src/routes/$budId/$threadId.tsx` if the controller architecture is meant to be real, not nominal.
- Prove the minimal-fix hypothesis explicitly:
  - keep the Phase 10 behavior that suppresses `emulator_protocol` by default
  - keep the structured-send fallback for unsupported human bytes
  - then re-test whether the original symptom stays gone without the broader bootstrap/observe/contract work
- If the symptom stays gone with that smaller slice, treat the rest of the branch as optional follow-on refactor work rather than part of the bug fix.

## Net Assessment

The branch appears to have found a plausible fix, but the current code strongly suggests the real fix point was later and smaller than the branch narrative. The most compelling change is: stop forwarding xterm `emulator_protocol` upstream by default, and route unsupported human bytes through structured send instead.

The debt problem is that the branch kept expanding after that likely fix point.

Relative to `origin/main`, the biggest debt increase is not one bad code path. It is the combination of:

- larger permanent contracts
- bigger integration files
- duplicated input semantics across layers
- xterm-internal coupling
- thin executable coverage
- heavy design/plan/debug/process accretion in the same branch

If this lands as-is, the codebase will be more explicit than `origin/main`, but not simpler.
