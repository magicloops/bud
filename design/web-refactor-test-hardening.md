# Design: Web Refactor Test Hardening Follow-Up

> Design document for the next layer of automated coverage after the main `web/` architecture refactor.

**Related Docs**:
- [../plan/refactor-web/implementation-spec.md](../plan/refactor-web/implementation-spec.md)
- [../plan/refactor-web/validation-checklist.md](../plan/refactor-web/validation-checklist.md)
- [../web/src/features/threads/threads.spec.md](../web/src/features/threads/threads.spec.md)
- [../web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)

---

## 1. Executive Summary

The web refactor added a small but useful Node-runner test baseline for pure helpers:

- auth redirect normalization
- transcript reconciliation helpers
- shared stream timing policy

That baseline reduced some risk during the refactor, but it does not yet protect the higher-risk browser/runtime behavior that still lives in hooks and route composition.

The next testing tranche should add a DOM-capable test layer for:

- thread transcript/hook behavior
- agent stream lifecycle behavior
- terminal reconnect/recovery behavior
- selected route-level integration behavior

### Recommendation

Adopt a two-layer model inside `web/`:

1. **Keep the current Node test runner for pure helper/unit tests**
   - fast
   - no DOM
   - no extra browser tooling required

2. **Add a DOM-capable React integration layer for hooks/components**
   - focused on the refactor’s highest-risk runtime flows
   - uses deterministic mocks for SSE, fetch, resize/observer behavior, and xterm seams
   - stays package-local and CI-friendly without jumping straight to heavyweight end-to-end browser automation

This follow-up PR should prioritize confidence in the thread workspace runtime rather than broad snapshot coverage.

---

## 2. Problem Statement

The refactor intentionally moved complex browser behavior out of the god route and into smaller ownership units:

- `useThreadMessages(...)`
- `useAgentStream(...)`
- `useTerminalSession(...)`
- `ChatTimeline`
- route-level composition in `/$budId/$threadId`

That decomposition improved maintainability, but most of the behavior is still only protected by:

- manual verification
- a small set of pure helper tests
- successful `pnpm build`

The remaining unprotected areas are exactly where subtle regressions are most likely:

- optimistic message reconciliation under real hook state updates
- agent SSE reconnect / resume / resync transitions
- terminal reconnect and recovery after disconnects or Bud offline/online changes
- scroll-anchor preservation while prepending older messages
- route-level coordination between loader state, hook bootstraps, and live updates

Without deeper automated coverage, future refactors or feature work can easily reintroduce:

- duplicate/dropped synthetic rows
- stuck streaming state
- broken reconnect loops
- stale terminal overlays
- scroll jumps during history pagination

---

## 3. Goals

- Add a practical next layer of automated coverage for the refactored web runtime.
- Protect the highest-risk thread/terminal/browser interaction paths first.
- Keep tests package-local to `web/` and runnable from `/Users/adam/bud/web`.
- Preserve fast pure-helper tests instead of replacing them.
- Make new runtime tests deterministic and mock-driven rather than flaky network simulations.
- Align the new coverage with the existing refactor validation checklist so closeout is measurable.

## 4. Non-Goals

- Full browser end-to-end coverage across the whole app in this tranche.
- Visual snapshot testing as a primary strategy.
- Exhaustive tests for every component prop combination.
- Real xterm rendering fidelity tests in a real browser.
- Performance benchmarking infrastructure.
- Solving the deferred streaming-JSON / code-block renderer work in the same PR.

---

## 5. Current State

Today the `web/` package uses:

- Node built-in test runner
- `--experimental-strip-types`
- pure `*.test.ts` files only

Current strengths:

- very fast
- zero DOM setup
- low maintenance
- good fit for state reducer/helper coverage

Current gaps:

- no DOM-capable test environment
- no hook/component rendering tests
- no route composition tests
- no controlled EventSource lifecycle tests
- no terminal/xterm-facing runtime tests

This means the refactor’s most complex runtime units are still verified mostly by manual behavior checks.

---

## 6. Proposed Test Architecture

## 6.1 Keep the existing pure-helper layer

The current Node-runner tests should stay in place for:

- `auth-redirect.ts`
- `thread-message-state.ts`
- `thread-stream-timing.ts`

These tests are still the right tool for:

- deterministic state transitions
- small helper invariants
- ID and ordering semantics

## 6.2 Add a DOM-capable integration layer

The follow-up PR should add a second test layer for React rendering and hook behavior.

### Recommended tooling

- `vitest`
- `jsdom`
- `@testing-library/react`
- `@testing-library/user-event`

Why this stack:

- it fits Vite/React naturally
- it is lighter than a full browser automation layer
- it supports hook/component/route integration testing
- it can coexist cleanly with the current Node-runner tests

### Recommendation

Use:

- `pnpm test` for the full `web` suite once the new layer is added
- a dedicated script such as `pnpm test:unit` or `pnpm test:node` for the current pure Node tests if needed
- a dedicated `vitest` config for DOM tests rather than trying to force DOM behavior through Node’s built-in runner

The goal is not to replace the current tests, but to add the missing browser/runtime tier.

---

## 7. Target Coverage Areas

## 7.1 Transcript / message runtime

Focus on `useThreadMessages(...)` and its route-facing contract.

Priority scenarios:

1. optimistic user message is inserted, then reconciled to canonical persisted IDs
2. failed send removes the optimistic row and returns the route to idle
3. older-message pagination prepends messages and preserves scroll position
4. bootstrap refresh merges latest canonical rows without discarding already-loaded older history
5. pending tool and draft assistant rows appear and are cleaned up correctly through hook callbacks

Why this matters:

- these are the core correctness guarantees for the thread transcript
- helper tests already cover the pure reducers, but not the hook wiring or scroll-anchor behavior

## 7.2 Agent stream lifecycle

Focus on `useAgentStream(...)`.

Priority scenarios:

1. initial attach uses the provided stream cursor
2. incremental `agent.message_*` events call the expected route callbacks in order
3. stale/closed stream triggers reconnect with the expected timing policy
4. `agent.resync_required` calls the provided bootstrap refresh and reattaches from the updated cursor
5. `final` transitions status correctly without breaking readiness for the next turn
6. auth-expiry abort path stops reconnect loops cleanly

Why this matters:

- this hook replaced a large portion of the old god-route runtime
- reconnect/resume bugs are subtle and easy to miss manually

## 7.3 Terminal runtime

Focus on `useTerminalSession(...)`.

Priority scenarios:

1. thread entry creates or reuses the terminal session record
2. initial history replay writes buffered output into the runtime
3. terminal stream close transitions into reconnecting and eventually recovers
4. Bud offline/online events trigger the intended recovery path
5. thread switch / unmount disposes the old runtime cleanly
6. input batching posts the expected payload shape
7. resize sync only fires on actual dimension changes

Why this matters:

- terminal recovery is one of the most failure-prone browser behaviors in the app
- the refactor extracted it well, but that also means it now has a crisp seam worth testing

## 7.4 Route-level integration

Focus on `/$budId/$threadId`.

Priority scenarios:

1. loader state bootstraps the route and wires shared hooks correctly
2. thread-title stream updates patch the Bud-level thread context
3. route error state surfaces correctly into terminal/composer UI
4. `ChatTimeline` and `ThinkingIndicator` reflect status transitions coherently during a turn

Why this matters:

- this gives confidence that the extracted hooks still compose correctly together

---

## 8. What Not To Over-Test

Avoid spending the first follow-up PR on:

- snapshots of neobrutalist markup
- exhaustive icon/rendering assertions
- testing third-party libraries
- testing every markdown/code-block rendering permutation
- real browser pixel/layout assertions

The intent is to protect behavioral contracts, not freeze implementation details.

---

## 9. Harness Design

## 9.1 EventSource test double

Introduce a small reusable fake EventSource harness that can:

- record constructor URLs
- emit `message`, `error`, and `open` events
- transition `readyState`
- expose whether the hook called `close()`

This should be shared across:

- agent stream tests
- terminal stream tests

The fake should be deterministic and synchronous where possible, with manual control over:

- event delivery
- close timing
- reconnect triggers

## 9.2 Fetch mocking

Use a thin fetch mock helper that:

- matches requests by URL and method
- returns structured `Response` objects
- supports sequential responses for reconnect/resync flows

It should be simple enough that tests can express:

- first request fails
- second request succeeds
- loader/bootstrap endpoints return known fixtures

without embedding large mock frameworks into every test.

## 9.3 DOM/observer mocks

Add a shared test setup file for browser APIs used by the workbench:

- `ResizeObserver`
- `IntersectionObserver` if needed later
- clipboard APIs
- `requestAnimationFrame`
- `matchMedia` where relevant

For `ChatTimeline`, the important pieces are:

- deterministic `requestAnimationFrame`
- `ResizeObserver` support
- controlled scroll container properties

## 9.4 xterm seam strategy

Do not try to test real xterm rendering in jsdom.

Instead:

- mock the `Terminal` and `FitAddon` constructors
- assert calls such as `write`, `open`, `focus`, `dispose`, and `fit`
- keep the tests at the hook contract level

The real question is:

- did the runtime call the right terminal APIs at the right time?

not:

- did xterm render ANSI correctly?

---

## 10. Fixture Strategy

Introduce small, reusable fixture builders for:

- `ApiMessage`
- `ApiMessagePage`
- `ApiAgentState`
- `ApiThread`
- terminal SSE payloads

Why builders instead of large static JSON blobs:

- keeps tests readable
- makes scenario deltas obvious
- avoids brittle fixture duplication

Example targets:

- `web/src/test/builders/messages.ts`
- `web/src/test/builders/agent-state.ts`
- `web/src/test/builders/threads.ts`
- `web/src/test/fakes/event-source.ts`
- `web/src/test/fakes/xterm.ts`

Exact file layout can vary, but the pattern should keep runtime test plumbing out of production modules.

---

## 11. Proposed Test File Layout

Recommended new layout:

```text
web/src/
  test/
    builders/
    fakes/
    setup/
  features/threads/
    thread-message-state.test.ts          # keep existing pure tests
    thread-stream-timing.test.ts          # keep existing pure tests
    use-thread-messages.dom.test.tsx
    use-agent-stream.dom.test.tsx
    use-terminal-session.dom.test.tsx
  routes/$budId/
    thread-route.dom.test.tsx             # name can vary; keep close to the route
  lib/
    auth-redirect.test.ts                 # keep existing pure tests
```

The important separation is:

- pure tests stay near helpers
- DOM/runtime tests sit near the hook/route they protect
- shared harness code lives in `src/test/`

---

## 12. Phased Implementation Plan

## Phase 1: Add the DOM-capable harness

Deliverables:

- `vitest` config
- jsdom environment
- shared test setup
- fake EventSource
- basic fetch mock helper
- basic xterm mock helper

Acceptance criteria:

- one small smoke test renders a React component under the new harness
- the existing pure-helper tests still run cleanly

## Phase 2: Transcript hook coverage

Deliverables:

- `useThreadMessages(...)` DOM/integration tests
- scroll-anchor preservation test
- optimistic reconcile/failure tests

Acceptance criteria:

- the core transcript checklist items can be checked off with automated coverage references

## Phase 3: Agent stream hook coverage

Deliverables:

- `useAgentStream(...)` lifecycle tests
- reconnect/resume/resync tests
- auth-expiry abort test

Acceptance criteria:

- reconnect/resync behavior is no longer manual-only validation

## Phase 4: Terminal runtime coverage

Deliverables:

- `useTerminalSession(...)` lifecycle/recovery tests
- session creation/reuse test
- reconnect and Bud offline/online recovery tests
- cleanup-on-unmount or thread switch test

Acceptance criteria:

- the major terminal validation items have automated coverage

## Phase 5: Route composition smoke tests

Deliverables:

- one or two focused `/$budId/$threadId` integration tests
- title patching into Bud route context
- basic status/render coordination test

Acceptance criteria:

- route-level composition is protected without building a huge end-to-end suite

---

## 13. Acceptance Criteria

This follow-up can be considered successful when:

- the `web/` package has a DOM-capable test layer in addition to the existing pure-helper tests
- transcript, agent stream, and terminal runtime behavior each have focused automated coverage
- the most important items in [../plan/refactor-web/validation-checklist.md](../plan/refactor-web/validation-checklist.md) can reference concrete automated tests instead of only manual verification
- the test harness is simple enough that future feature PRs can extend it without rethinking the stack

---

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The harness becomes over-engineered before useful tests land | Medium | Medium | Land one small smoke test and one hook test early, then expand |
| Tests become flaky due to timers, RAF, or observer behavior | Medium | High | Centralize fake timers/RAF/observer control in shared setup |
| xterm mocks become too implementation-specific | Medium | Medium | Assert hook-facing calls only, not library internals |
| Route tests become too broad and brittle | Medium | Medium | Keep route tests to a small number of composition smoke tests |
| The team accidentally replaces fast pure-helper tests with slower DOM tests | Low | Medium | Keep both layers and document their intended use clearly |

---

## 15. Open Questions

### 15.1 Single runner or split runners?

Recommended answer:

- keep the current Node runner for pure tests
- add `vitest` for DOM/runtime tests

This is slightly more tooling, but it preserves speed and clarity.

### 15.2 Do we need Playwright in this tranche?

Recommended answer:

- no

Playwright may be useful later for one or two end-to-end browser flows, but it is not the right first step for the current closeout gap.

### 15.3 Should terminal tests wait for a future terminal abstraction seam?

Recommended answer:

- no

The current hook boundaries are already good enough to support mock-driven lifecycle tests.

---

## 16. Recommendation

The follow-up PR should:

1. add a DOM-capable React test harness to `web/`
2. cover `useThreadMessages(...)`, `useAgentStream(...)`, and `useTerminalSession(...)` before adding broader route tests
3. keep the current Node-runner pure-helper tests intact
4. treat route tests as a narrow smoke layer rather than a replacement for hook-level coverage

That gives the web app the missing safety net from the refactor without turning the next PR into a full testing-platform rewrite.

---

*Document Version: 1.0*
*Last Updated: 2026-04-21*
