# Debug: Browser controls presentation

## Environment
- Shared React web/WK viewer after daemon v0.1.29 and PR #152.
- User confirms working production takeover and resolved reconnect loops.

## Reproduction
1. Open browser controls while watching an idle page.
2. Observe takeover, native window, viewport, workspace and profile controls together.
3. Recover from private media loss; the prior failure can remain in the menu.

## Observed / expected
The hover-open panel duplicates takeover and mobile dismissal and permanently
explains maintenance/input limitations. Routine viewing should have one primary
Take control/Return action and contextual More options. Native mobile already
owns its title and Close button. Transient connection errors should resolve with
current passive viewing without hiding unconfirmed input.

## Fix scope
Implement [U1–U3](../plan/browser-streaming/browser-controls-redesign.md) in the
shared hosted viewer. Keep control/input/media contracts, scoped authorization,
exact-override release and no-replay behavior. Bud-wide management mounts only
on demand through its existing owner-authorized endpoint. No server/schema or
native bridge change is planned. Physical iPhone acceptance remains explicit.

## Validation
- `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test
  src/features/browser/controls.test.tsx src/features/browser/viewer.test.tsx
  src/features/browser/mobile-viewer.test.tsx src/features/browser/lifecycle.test.tsx
  src/features/browser/mobile-bridge.test.tsx`: 25 passed.
- `pnpm --dir web build`: passed (existing Vite large-chunk warning).
- `pnpm --dir web exec tsc -b`: passed.
- `pnpm --dir web exec eslint src/features/browser/controls.tsx
  src/features/browser/controls.test.tsx`: passed.
- `git diff --check`: passed.
- Compiled CSS contains the named browser-pane container query, so status adapts
  to pane width rather than the full desktop viewport.

The first focused run failed because existing node mocks did not implement focus
for the new options trigger (`trigger.current?.focus is not a function`). Guarded
focus restoration and dedicated focus mocks corrected that fixture issue.
A new recovery assertion initially used a fake release response with an older
revision than acquire, which correctly prevented passive attachment. The fixture
now advances revision on release and waits for the replacement before presenting
its frame. A keyboard-cycle fixture also changed its callback on each update,
rerunning initial focus; it now uses the stable callback of the real viewer.
All of these checks pass after correction.

No browser was available through the browser skill (discovery returned an empty
list); desktop screenshots/visual acceptance could not run. Physical iPhone,
VoiceOver, long idle and multi-user live checks remain explicitly open. Native
source was inspected: its existing Browser/Close header stays unchanged.

## October 14 — contradictory recovery notice

User observed “You have control” and “Control ended. You’re watching Bud again”
together. The resolved control-loss message shares the general notice string and
has no presentation guard tying it to passive ownership. A passive callback may
also race a control transition. The new takeover cleared notices only at its start.

Give the resolved control-loss notice its own presentation flag, admit it only
outside an active transition, clear it on takeover completion as well as start,
and display it only while passive. Keep runtime-restoration notices and uncertain
input errors separate. Regression: lose private media → passive frame → notice →
new explicit takeover; current control and the ended notice cannot coexist.

Validation for the notice fix: all 19 desktop/hosted-mobile viewer tests pass,
including loss → passive recovery → renewed takeover in both modes. TypeScript
and diff whitespace checks pass. Resolved-loss notice presentation no longer
shares the runtime-restoration message; input uncertainty remains unaffected.
