# Phase 3d validation

2026-09-15, local macOS arm64, Chrome for Testing 152, Playwright 1.63.0.

Initial `cargo test --manifest-path bud/Cargo.toml browser:: -- --test-threads=1`
failed the table and blank-page legacy reference fixtures after replacing AX
with Playwright: an empty body no longer had a root reference and the legacy
256-element limit was no longer applied. Keep a document reference and cap only
the old response adapter; the new contract uses bounded continuation.

Helper tests cover ordered story links, duplicate-name refusal, atomic fill,
field-value redaction, continuation, stale observation IDs and visible boxes.
Further test outcomes will be recorded below.

`pnpm --dir service build` initially rejected the capture test's `payload: unknown`
with TS2322 (not assignable to InjectPayload), cascading into response overload
errors. Narrowed the fixture input to a JSON object; no runtime change.


The first mobile fixture failed because canonical browser JSON was not merged
into tool metadata on reload. Extended the existing canonical payload merge for
`browser_observe` (without classifying it as web retrieval). The same fixture then
passed. Ambiguous/stale semantic lookups now leave the service session ready;
unknown outcomes still interrupt. PostgreSQL tests cover subsequent observation.

An accidental repo-root `npm test` reported Missing script: test; reran from
`bud/browser-helper`, the owning package, successfully.

Final automated checks:
- `BUD_BROWSER_EXECUTABLE=... cargo test browser --lib` from bud/: 13 pass,
  including live Chrome private capture/renewal, reconnect, ref and table tests.
- Helper `npm test` with CfT configured: 2 pass, including actual Chrome hierarchy,
  continuation/scope, duplicate-name refusal, fill, visible boxes and expiry/nav.
- `BUD_DATA_DB_TEST=1 node --env-file=.env --import tsx --test src/browser/*.test.ts
  src/agent/browser-tools.test.ts` from service/: 32 pass, 1 optional prototype
  test skipped. Temporary PostgreSQL schemas are dropped afterward.
- Service TypeScript build passes. Web production build passes with the existing
  large-chunk advisory; browser-observation render fixture passes.
- iOS simulator app build and seven WebRetrievalTests pass, including browser
  snapshot/partial-result extraction and artifact path restrictions.
- `cargo fmt --check` and both repositories' `git diff --check` pass.

No daemon was launched under the user's identity and no service deployment or
phone installation was performed. Live normal-agent text/vision acceptance and
comparative p50/p95/resource measurements remain in the phase checklist. Helper
fixtures and provider serializer tests do not claim model-level visual success.
