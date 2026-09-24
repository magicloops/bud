# Debug: Unknown browser actions restart a healthy viewer

## Environment and reproduction

Local daemon/service and web viewer over ngrok, 2026-09-23. In thread
`002ffbbd-52f9-4aa0-8c12-8857006cc033`, agent semantic clicks timed out while
another element intercepted pointer events. Keep the passive browser pane open.

## Observed

At 06:20:28, 06:20:45 and 06:20:56 UTC, click attempts failed. Shortly afterward,
the web viewer closed with `viewer_cleanup`; daemon media then ended with
`transport_error`. Fresh connections received frames in approximately 700–800ms.
Chrome remained running, and the browser resource epoch stayed at 164.

The daemon conservatively reports admitted failures as `browser_outcome_unknown`.
Repository completion previously changed every unknown result to `interrupted`.
Metadata consequently reported the runtime ended, and active viewer ensure tore
down healthy media. Action uncertainty was being used as runtime-health evidence.

## Fix

For ordinary page operations (inspect, navigate, click, insert_text), a canonical
unknown outcome preserves the existing workspace state while clearing pending
admission. It does not mark an already interrupted workspace ready. Open/close
failures and explicit runtime errors retain existing recovery behavior.

The failed tool result and durable dispatch receipt remain unchanged: no action
replay, forced click, fabricated success, or authority change. Actual carrier loss,
boot changes and media failures still use existing detection/ensure. Agent calls
also ensure runtime health before each new dispatch. No extra health polling,
protocol fields, or UI delay is introduced.

Ownership remains owner/thread/Bud scoped; completion keeps its owner, generation
and sequence checks. No route, row-stamping or schema change.

## Validation and rollout

Repository regressions exercise uncertain clicks, subsequent observation, replay
rejection, preserved interruption, explicit runtime failure and uncertain lifecycle
operations. Existing web viewer tests cover same-metadata continuity and real
restart/privacy/media recovery. Service-only change; no migration or daemon rebuild.
Manual acceptance: repeat an intercepted click with the pane open and verify the
media connection ID stays unchanged.

Related spec: [browser broker](../service/src/browser/browser.spec.md).

Test invocation correction: running `pnpm exec node --import tsx --test
src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx`
from web failed with `ReferenceError: React is not defined`. This bypassed the
render-test script's explicit JSX configuration. Use `pnpm exec tsx --tsconfig
tsconfig.app.json --test` with those files, matching `test:render`.

Validation passed: isolated PostgreSQL repository suite (including the new
regressions), 26 broker/control/transport tests, 12 mounted web/mobile viewer
tests with the correct JSX configuration, service TypeScript check, and
`git diff --check`. Manual ngrok reproduction remains to be repeated.
