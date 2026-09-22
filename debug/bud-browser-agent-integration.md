# Debug: browser agent integration

## Environment

Phase-0 browser spike; service TypeScript, local fixture tests. No production
database or real account changes.

## Observed

Initial `cd service && pnpm exec tsc --noEmit`:

```text
src/agent/browser-tools.ts(46,52): error TS2322: Type 'Record<string, unknown>' is not assignable to type '{ [key: string]: JSONSchema7Definition; }'.
```

## Cause and fix

The new schema helper used an overly broad property type. Use the canonical
tool's JSON Schema property type and literal string schema type. This changes
TypeScript validation, not the emitted schema.

Integration scope and validation: [plan](../plan/bud-owned-browser/phase-0-agent-integration.md).

## Subsequent validation repairs

- A repo-root `pnpm exec tsc --noEmit` could not resolve the package-local
  compiler (`Command "tsc" not found`). Reran checks from `service/`.
- The first fixture used a nonexistent `providerRegistry.get`; corrected to
  `getProvider`. This affected test setup, not the production registry API.
- TypeScript rejected the dynamic `node:events` import's `once` typing under
  this package configuration; used its normal static named import.
- The real-browser fixture selected a label by name instead of its textbox.
  Select by role and name; no host input/focus guard was relaxed.
- During review, generic navigation host errors were changed to unknown outcome,
  matching click/text errors: a command may already have executed.

Final checks: service `pnpm build` passed; focused agent regression suite 62
passed/one optional browser skip; browser + relay suites with the configured
Chrome for Testing executable 8 passed/no skips. Commands and fixture limitations
are recorded in the linked plan and spike README. No production DB was accessed.

## Live validation follow-up

While preparing SQL authority tests, comparison with `getAuthorizedThread`
showed the browser executor omitted `thread.deleted_at IS NULL`. That could
admit work on a soft-deleted thread. Add the same predicate and test real SQL
against temporary tables, including deletion during a read and Bud unclaim.

First live-model workflow command (from service; Chrome executable configured):
`BUD_BROWSER_LIVE_MODEL_TEST=1 pnpm exec node --import tsx --test --test-name-pattern="real browser host" src/agent/browser-tools.test.ts`.
It reached handoff but failed the all-tools-success assertion with `false == true`
at browser-tools.test.ts:281. Add bounded tool name/action/outcome diagnostics
(no arguments, page text, credentials or raw provider response) to isolate it.

Bounded diagnostics isolated repeated `browser_invalid_arguments`: the model
included `target_id` on focus/click/text actions and sometimes other unrelated
nonnull fields. It then tried insert_text after click, yielding an unknown host
outcome because click does not establish the guarded text target. Added per-field
applicability/null descriptions and static action-shape guidance on validation
failure. Strict validation and host focus protection remain intact. Strengthened
the page fixture so Submit succeeds only when Name actually equals the requested
value. Private input is checked against both model requests and transcript writes.

`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/browser-ownership.test.ts`
passed against local PostgreSQL connection-private temporary tables; no existing
rows were changed. Service build and eight deterministic browser/relay tests pass.

Final live rerun passed: GPT-5.6 Luna, 13 calls, eight successful tool results,
three corrected validation rejections, ~22.5s. Live success requires verified
fixture state and safe recovery, not a scripted call sequence. The stricter
scripted suite still requires every operation to succeed. Final combined
browser/relay/SQL run: nine passed, no skips; service build passed.
