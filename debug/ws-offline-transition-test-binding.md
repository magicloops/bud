# Debug: ws-offline-transition-test-binding

## Environment
- OS / arch / versions: macOS, local desktop workspace
- DB connection style: service test suite with `db.update(...)` mocked
- LLM mode (real/mocked): mocked/unit-test context

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service test`
2. Observe the failing test `handleOfflineTransition rejects pending waits before suspending Bud-owned sessions`

## Observed
- The test throws `Cannot read properties of undefined (reading 'terminalSessionManager')`
- The failure originates from `handleOfflineTransition(...)` in `service/src/ws/bud-connection.ts`

## Expected
- The test should verify the ordering of offline-transition side effects:
  1. reject pending waits
  2. clear caches
  3. clear event buffers
  4. suspend sessions
  5. emit offline events

## Hypotheses
- The test extracts `handleOfflineTransition` via `Reflect.get(...)` and then calls it as a bare function.
- Because `handleOfflineTransition` is an instance method that uses `this.terminalSessionManager`, invoking it unbound loses the `BudConnection` receiver.

## Proposed Fix
- Keep the implementation unchanged.
- Update the test to invoke `handleOfflineTransition` with `connection` as `this`, for example via `.call(connection, "bud-1")`.
- Spec files affected: none beyond this debug note because the runtime contract is unchanged.
