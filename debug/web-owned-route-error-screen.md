# Debug: web-owned-route-error-screen

## Environment
- macOS local development
- Auth-enabled Bud web app with Better Auth sessions
- Browser navigation into authenticated Bud and thread routes

## Repro Steps
1. Sign in to the web app as user A.
2. Navigate directly to a Bud or thread URL that does not belong to user A.
3. Let the loader fail on the owned API read.

## Observed
- The app shows TanStack Router's default crash UI:
  - `Something went wrong!`
  - `Hide Error`
  - raw backend/app error text such as `bud_not_found`
- The page looks like a framework fallback rather than an intentional product state.

## Expected
- The app should render a branded recovery page consistent with the rest of Bud.
- The copy should explain that the Bud or thread is unavailable or not accessible.
- The user should have a clear path back into the app, at minimum a button to go home.

## Hypotheses
- The root route in [`web/src/routes/__root.tsx`](/Users/adam/code/bud/web/src/routes/__root.tsx) does not define a custom `errorComponent`, so uncaught route-loader errors fall through to TanStack Router's default `ErrorComponent`.
- Owned-route failures such as `bud_not_found` and `thread_not_found` are correct service outcomes after Phase 4, but the web shell is surfacing those raw codes directly.

## Proposed Fix
- Add a root-level branded route error screen for uncaught route errors.
- Translate known owned-route failures (`*_not_found`, HTTP `404`) into user-facing copy.
- Provide a primary action that navigates back to `/`.
- Update the relevant web route/component spec files to document the new recovery behavior.
