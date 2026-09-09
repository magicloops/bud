# Debug: Automation model inheritance

Local development, September 9, 2026. Existing automation authoring stored resolved model values as if explicitly selected. Admission copied them, and dispatch required exact equality with revisions, so later thread changes could not affect future automation runs.

Fix: persist selection mode and source, resolve at admission, keep invocation snapshots fixed, and project fallback warnings. Use the existing JSON definition and input-message metadata storage; migrate existing rules to inherited as directed by the user.

Initial `pnpm --dir service build` failed with TS2322/TS2345 (`reasoning_effort` possibly undefined). Adding Zod defaults exposed the parse helper's assumption that input and output types match. Corrected the helper to allow a different input type while returning the validated output type.

## Final validation findings

- `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/personal-data/*.test.ts` initially found retired GPT-5.4 fixture selections and old copied-model expectations. Updated active fixtures and added frozen input snapshot integrity checks; all 82 pass.
- Drizzle data migration fixture initially referenced bootstrap `definition`, which is nested in `frozen`; corrected SQL. Local transaction applied migration 0038 with zero remaining unmigrated drafts.
- `xcodebuild ... CODE_SIGNING_ALLOWED=NO test` built but could not launch the simulator test host. Retried with normal simulator signing.
- Signed simulator test reached the new selection test, then crashed in `ChatModelSelectionStore.__deallocating_deinit`, via `swift_task_deinitOnExecutorMainActorBackDeploy` and `BUG_IN_CLIENT_OF_LIBMALLOC_POINTER_BEING_FREED_WAS_NOT_ALLOCATED`. Exact crash report: `~/Library/Logs/DiagnosticReports/Bud-2026-09-09-153916.ips`. This matches the documented UserDefaultsChatPersistence teardown workaround. Apply the same explicit empty deinit and rerun; do not suppress the test.

Final signed simulator rerun passed all 19 selected tests after the explicit deinit workaround.

Final `pnpm --dir web build` found TS2353/TS2339: the internal ThreadSummary omits model_warning. Kept warning presentation on the authoritative thread detail instead of duplicating it through sidebar summaries; rebuilding.

Final combined validation passed: 141 service tests, five web render tests, 19 signed simulator tests; service/web builds and both-repo diff whitespace checks pass.
