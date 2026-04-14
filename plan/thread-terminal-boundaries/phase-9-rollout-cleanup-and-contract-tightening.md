# Phase 9: Contract Tightening And Cleanup

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Tighten the terminal-boundary contract now that the new architecture is working in practice.

This project is still internal-only. We do not need compatibility shims for older callers just because they existed during implementation. The one external coordination task is to inform the mobile team when the API surface changes.

## Context

Phases 1 through 8 established the target architecture:

- browser input is classified before it reaches the backend
- browser typing uses the shared structured `terminal_send` path
- observation is optional instead of implicit
- `/terminal/state` returns a richer `bootstrap` contract
- terminal stream attach is live-only by default with explicit durable resume

That work intentionally left a few temporary or transitional pieces in place while the behavior was being validated:

- flat legacy send-observe fields alongside nested `observe`
- transitional `/terminal/state.snapshot`
- extra bootstrap / stream debug logging
- a raw `/terminal/input` path that was partly serving as a rollout escape hatch
- degraded text-trim behavior in browser bootstrap fallback

The validation work is now good enough to stop treating those as provisional.

Note: the raw-input retention decision in this phase was intentionally revisited later by [phase-10-emulator-protocol-suppression-and-raw-input-narrowing.md](./phase-10-emulator-protocol-suppression-and-raw-input-narrowing.md), after live Codex TUI validation showed that xterm-generated emulator replies should not keep using the raw browser input lane.

## Preconditions

Before this phase is considered complete:

- browser typing remains fast on the shared `terminal_send` path
- the `1;2c` replay/input bug class remains unreproducible
- fresh-page reopen behavior is stable for shell and TUI sessions
- any remaining fallback surface is justified by current behavior, not by rollout caution

## Scope

### 1. Canonical Terminal Send Contract

Remove compatibility for the older flat terminal-send observation fields.

Cleanup targets:

- Bud `terminal_send` parsing accepts only nested `observe`
- service agent/tool parsing and replay normalization accept only nested `observe`
- protocol/docs stop describing the flat fields as supported

Expected outcome:

- one canonical terminal-send contract
- no ambiguity about whether `observe` is nested or flat

### 2. Canonical Terminal Bootstrap Contract

Remove transitional `snapshot` support from `/terminal/state`.

Cleanup targets:

- route payload in `service/src/routes/threads.ts`
- runtime/browser typing in `service/src/runtime/terminal-session-manager.ts` and `web/src/lib/api.ts`
- protocol/docs/spec text that still treats `snapshot` as active contract surface

Expected outcome:

- `bootstrap` is the only terminal bootstrap contract
- degraded text restore remains explicit through `bootstrap.kind: "text"`

### 3. Debug Logging Reduction

Remove investigation-era bootstrap and stream logging that is no longer part of the intended product behavior.

Cleanup targets:

- service bootstrap / stream validation logs
- browser route/controller debug logging that was only useful during diagnosis

Expected outcome:

- long-term logs stay intentional
- validation-only log noise is gone

### 4. Raw Input Decision

Make an explicit keep-or-remove decision on `/terminal/input`.

Decision for this phase:

- keep `/terminal/input`, but only as a narrow low-level fallback for emulator protocol traffic and unsupported browser/xterm sequences
- do not treat it as a normal browser typing path

Expected outcome:

- raw input remains available where structured send is not the right primitive
- the reference web client uses it only for the cases that actually require byte-exact forwarding

### 5. Degraded Bootstrap Fallback Scope

Reconfirm the browser-side blank-line trim behavior now that rich bootstrap is the normal path.

Decision for this phase:

- keep trimming only for explicit degraded text bootstrap paths
- do not apply shell-oriented trimming to rich grid restore

Expected outcome:

- the workaround remains tightly scoped
- rich bootstrap keeps TUI cursor/blank-row fidelity

### 6. Mobile Coordination

Because the project is internal-only, coordination is simpler:

- no compatibility layer is required for old clients
- the mobile team should be informed that `terminal_send` now requires nested `observe` and `/terminal/state` no longer includes `snapshot`

This is a communication task, not a code-level compatibility requirement.

## Deliverables

- flat terminal-send observe compatibility removed
- `/terminal/state.snapshot` removed
- temporary bootstrap/stream debug logging removed
- `/terminal/input` retained only as an explicit narrow fallback
- degraded text trimming documented as degraded-path-only behavior
- updated protocol/spec/plan docs that match the tightened contract
- clear note that mobile consumers need the API surface update

## Success Criteria

- [x] No active caller relies on flat terminal-send observation fields.
- [x] `bootstrap` is the only browser bootstrap contract on `/terminal/state`.
- [x] `/terminal/input` is retained only as an explicit narrow fallback.
- [x] Temporary bootstrap/stream validation logging is removed.
- [x] Degraded text trimming is scoped only to explicit degraded fallback.
- [x] Docs/specs describe the tightened contract consistently.

## Expected Files

- `bud/src/main.rs`
- `service/src/agent/agent-service.ts`
- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `web/src/lib/api.ts`
- `web/src/lib/thread-terminal-controller.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `docs/proto.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

## Non-Goals

- redesigning the terminal boundary architecture again
- adding style-faithful TUI bootstrap
- removing `/terminal/input` if it still serves unsupported-sequence forwarding
- adding a separate compatibility layer for internal callers

## Risks And Notes

- Removing compatibility means older local tooling or stale branches may stop working until they adopt the tightened contract. That is acceptable for this internal phase.
- The remaining raw input path should stay narrow; do not let it silently expand back into the main typing path.
- The TUI color-on-refresh gap remains out of scope here. That is a future enhancement, not a cleanup blocker.
