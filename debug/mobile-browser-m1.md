# Debug: Mobile browser M1 contract alignment

## Environment
2026-09-25; current REPL-only service and initial Swift/WKWebView mobile viewer.

## Observed
Native inventory refreshes every five seconds while foregrounded. Thread browser
state upgrades use cookie-session liveness, so OAuth callers cannot subscribe.
Native transcript presentation still specializes retired browser_observe results.

## Expected / approach
Subscribe to owner-authorized thread hints before inventory, coalesce reads and
stop on background/account/selection changes. Retry failures only. Add bearer
support only on this read-only route with ongoing token and ownership validation;
preserve cookie Origin and scoped-visit boundaries. Render bounded current REPL
output and optional explicit image retrieval, with honest execution uncertainty.

## Validation
Focused route/stream authorization and native presentation/lifecycle tests, service
TypeScript and simulator build. Physical idle-traffic measurement remains separate.
See bud-mobile/plan/browser-sessions/phase-m1-repl-and-discovery.md.

## Commands and results

- `pnpm --dir service exec tsc --noEmit`: passed.
- `pnpm --dir service exec node --import tsx --test src/browser/state-routes.test.ts src/browser/state-stream.test.ts`: four tests passed.
- Mobile `xcodebuild -project Bud.xcodeproj -scheme Bud -configuration Debug -destination 'platform=iOS Simulator,id=BC8F97A1-47D7-416C-8682-4E4D7D342B9E' -derivedDataPath /tmp/bud-mobile-m1-build CODE_SIGNING_ALLOWED=NO build`: passed.
- Same build arguments with `-only-testing:BudTests/BrowserDiscoveryTests -only-testing:BudTests/BrowserToolPresentationTests -only-testing:BudTests/BrowserSessionTests -only-testing:BudTests/WebRetrievalTests test`: 18 tests passed in both the initial and final runs.
- Logs: `/tmp/bud-m1-service-final.log`, `/tmp/bud-mobile-m1-build.log`, `/tmp/bud-mobile-m1-final-tests.log`.

Test development caught unsupported Fastify v10 `injectWS` onInit options
(`TS2554: Expected 0-2 arguments, but got 3`, then `TypeError: (intermediate value)
is not iterable`). Replaced it with actual loopback WS and attached listeners
before connecting. The subscription mock initially decremented twice on cleanup
(`-1 !== 0`); made it idempotent like the real listener set. Focused checks then
passed. No runtime or dependency change was needed for these test harness errors.

The first final mobile rerun was accidentally invoked from `/Users/adam/bud` with
`-project Bud.xcodeproj`, which reported `xcodebuild: error: 'Bud.xcodeproj' does
not exist.` (exit 66). Reran the same command from `/Users/adam/bud-mobile`.
