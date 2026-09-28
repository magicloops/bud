# Debug: M3 mobile input targeting and gesture lifetime

## Environment
2026-09-25, service/web branch feat/mobile-browser-service after M2; mobile
feat/mobile-browser-m1-m2. A paired iPhone 17 Pro Max is available; no physical
input run has been performed yet. Local deterministic tests use Node/React fixtures.

## Reproduction and observations
The touch helper emits only delta. The viewer maps every swipe to the remote
viewport center, so an off-center nested scroller cannot be targeted by touch.
The touch effect also depends on `send`, whose identity changes with control/busy
state. Its cleanup removes the CSS transform, resetting local pinch zoom.
Two stationary fingers do not mark a gesture dragged, and cancellation shares
normal pointer-up handling, permitting an accidental click after those gestures.

## Expected / proposed fix
Carry a stable gesture-start client point with wheel deltas to the existing
coordinate mapping and serialized queue. Stable point allows adjacent unsent
wheels to coalesce without changing scroll containers during a swipe. Keep the
helper mounted across callback updates; read current dispatch via a ref. Cancel
obsolete gestures on document/viewport/control identity changes and suppress
post-pinch/cancel clicks. Preserve existing server owner/controller/frame checks.
Use deterministic off-center scroller/forms/links for device acceptance; do not
claim simulator or unit tests establish iPhone keyboard/privacy correctness.

## Scope / ownership
No new route, protocol, table, or control authority. Session remains owned through
thread/Bud; shared input still uses authorized scoped viewer identity, current
controller and displayed frame. Update shared browser spec and M3 evidence record.

## Validation
Web `pnpm exec tsc -b` passed. 29 focused tests passed:

```sh
# Run from web/
pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/touch.test.ts src/features/browser/input-queue.test.ts src/features/browser/mobile-viewer.test.tsx src/features/browser/viewer.test.tsx src/features/browser/viewport-fit.test.ts src/features/browser/state-feed.test.tsx
```

The standalone fixture is served successfully by the current local Vite server.
No physical keyboard, privacy, ngrok or 30-minute measurements were performed.
