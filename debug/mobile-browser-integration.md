# Debug: Mobile browser integration validation

## Environment

macOS development checkout, local PostgreSQL, Xcode/iOS 26.2 simulator.
No production deployment or physical-device acceptance in this task.

## Observed and fixes

- `xcodebuild -project Bud.xcodeproj -scheme Bud -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/bud-mobile-browser-build CODE_SIGNING_ALLOWED=NO build`
  initially failed in ChatBrowserVisit with `extra trailing closure passed in call`,
  then `incorrect argument label ... expected '_:arguments:in:in:completionHandler:'`.
  Corrected the WebKit signature to its current SDK labels. New handoff source was
  added while the first build was running; the subsequent build includes it.
- `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/viewer.test.tsx`
  was accidentally invoked at repo root (exit 254). Reran via `pnpm --dir web exec`
  so the package-local dependency/config resolve correctly.
- The final `xcodebuild -project Bud.xcodeproj ... test` was initially launched
  from the main repository, where that project does not exist. Reran from
  `/Users/adam/bud-mobile`; simulator tests pass.
- `pnpm db:push` from service proposed recreating the unrelated
  `agent_invocation_dedupe_key` constraint and asked whether to truncate existing
  invocation rows. Did not approve or apply that proposal. Generated migration
  0041 contains only the new browser_viewer_visit table/FK/indexes; applied that
  reviewed SQL transactionally to local PostgreSQL. Existing rows were preserved.
- Mobile bootstrap mapping previously suppressed pending tools when the canonical
  invocation was inactive. Preserve structurally identified browser handoffs so a
  parked invocation still exposes Return/Cancel. Canonical inventory supplies the
  exact current handoff/invocation identity before actions are enabled.

## Validation

- Service and web builds pass.
- Isolated PostgreSQL migration/auth tests: two pass, zero skipped.
- Existing desktop viewer regressions: eleven pass.
- New mobile lifecycle and touch regressions: two pass.
- iOS app simulator build and three BrowserSessionTests pass.
- Final incremental checks after lifecycle/navigation polishing recorded in the
  mobile implementation plan. Live cookies/WSS, keyboard/IME, app-switcher privacy,
  multi-user/desktop-phone exclusion and device performance remain manual gates.
