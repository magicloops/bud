# Debug: Reopening a paused private browser

## Environment / reproduction
- iPhone hosted viewer, shared web/service; CDP private streaming experiment.
- Take control, close the viewer, reopen it.
- User confirmed control had been acquired before closing.

## Observed / expected
Closing releases the viewer lease but preserves private content. A new visit cannot
attach private media, so the UI showed only a paused message and Take control.
Reopening should instead display the last shared agent image, clearly saved/read-only.
It must not acquire control, return to the agent, or expose subsequent private pixels.

## Cause and fix
Live media authority and availability of a historical shared image were conflated.
Retain the last authorized passive frame in a bounded 24-hour service cache; private
frames never enter it. Fall back to existing seven-day agent screenshot artifacts
when no newer passive image exists. Empty passive captures supersede older images.
Authorize the session before reading either source. Display a separate static image,
without input evidence, live media, automatic resizing or a control mutation.

## Ownership / rollout / validation
The resource is the owner/thread/Bud-bound browser workspace. Existing live web
session or scoped mobile visit resolves the viewer; repository.get authorizes before
image reads. Scoped visits cannot cross sessions. No new rows or owner stamps.
Service and hosted web update together; no daemon/native rebuild or migration.
Tests cover cache isolation/fences, artifact scope, saved-view rendering and lifecycle.

## Validation
- Service: `pnpm exec node --import tsx --test src/browser/media.test.ts src/browser/image-artifacts.test.ts src/browser/mobile-routes.test.ts` — 8 passed.
- Web: `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/mobile-viewer.test.tsx src/features/browser/viewer.test.tsx` — 17 passed; mobile suite rerun after adding saved-image authorization-loss coverage.
- Service `pnpm exec tsc --noEmit` and web `pnpm exec tsc -b` passed.
- Physical iPhone reopen after takeover remains to be checked. Existing sessions
  with neither retained public pixels nor a surviving agent screenshot truthfully
  show no saved view; the service never captures a private page to fill that gap.
