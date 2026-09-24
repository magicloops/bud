# Browser REPL Phase 6: selective extraction evaluation

## Decision

The comparison tooling and expanded fixtures are implemented. **Do not retain the
prompt experiments.** All 48 final fixture runs passed correctness checks, but
neither broader guidance nor a single follow-up reuse cue established the required
context/call improvement. The service catalog is restored exactly to the frozen
Phase 5 baseline. The Phase 6 efficiency gate remains open; this is not an accepted
performance optimization or a Phase 4 catalog cutover.

On the seven ordinary tasks (excluding forced overflow), the final candidate used
165,304 cumulative input tokens versus 139,195 (+18.8%), 59 tool calls versus 53,
and 12 natural overflows versus 8. The reuse cue eliminated browser reads on the
three policy follow-ups, but did not consistently reduce model calls. Avoiding a
browser read alone is insufficient justification for adding guidance.

## Environment and reproducibility

Related [Phase 6 plan](../plan/bud-owned-browser/repl-phase-6-selective-extraction.md).
Same corrected Phase 5 worker/semantic helper on both sides, managed Node 24.21.0,
disposable headless Chrome, `gpt-5.6-luna` with high reasoning, 3 repetitions/task,
alternating catalog order and a 16-provider-call ceiling. This developer harness
does not run the full service agent, daemon authority, viewer or a user profile.
HTTP requests in the disposable context are fulfilled from fixtures; trusted Node
execution is not a network sandbox. No service DB is used.

Reports retain complete catalogs, helper/fixture/harness hashes, generated code,
results and actual provider usage with mode 0600. Reports are local artifacts,
not checked-in transcripts. The baseline was saved **before** editing guidance:
`/tmp/bud-browser-phase6-baseline-catalog.json`.

Final report: `/tmp/bud-browser-phase6-narrow.json`.

- Baseline catalog SHA-256: `160628adbede699ec0ce32778ad8f0aa88fd05868d2773c24e89e2fddb66aea0`
- Rejected narrow candidate SHA-256: `4a633291b3537c0d39db97de0a925e80e10e73dd1dbfddfed290359bad4bd66d`

The only narrow-candidate difference was: “For follow-up questions, reuse retained
page evidence unless current state is needed; filter locally before rereading the
page.” Even that small edit changed initial-task behavior. Three repetitions are
descriptive evidence, not statistical proof of a universal regression; they do not
support claiming an improvement either.

Run from `service/` after saving a baseline catalog and making a candidate edit:

```sh
BUD_BROWSER_LIVE_MODEL=gpt-5.6-luna \
BUD_BROWSER_COMPARISON_EFFORT=high \
BUD_BROWSER_NODE=/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node \
BUD_BROWSER_EXECUTABLE='/Users/adam/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
pnpm exec tsx scripts/compare-browser-repl.ts \
  /tmp/browser-comparison.json /tmp/bud-browser-phase6-baseline-catalog.json
```

The third argument selects saved-baseline/current-REPL comparison. Omitting it
preserves the existing old-tools/REPL comparison needed for Phase 4.
`BUD_BROWSER_COMPARISON_FIXTURES=name,name` selects a known subset for focused
reruns and rejects unknown names before provider calls. Saving a baseline is simply
serializing `BROWSER_REPL_TOOLS`; no production flag or second catalog was added.
After this evaluation the current catalog equals the baseline, so rerunning the
command without a candidate edit compares identical guidance.

## Fixture coverage and review

Retained table/article/form cases plus:

- Nested records: exact parent/author/body attribution; equal text belongs to
  distinct records, nested bodies cannot be duplicated, inert script text excluded.
- Ordered cards: third distinct active entity, explicit `data-record` identity,
  full query/fragment URL and duplicate wrapper classes.
- Long policy: exception near the end and a follow-up requiring other tail facts.
- Partial loading: collect five readings through Load more and report honest
  loaded/total/complete fields.
- Forced overflow: one recorded export, a retained value and complete artifact;
  select flagged records without repeating the mutation. Seed source does not
  disclose answers. Report forced overflow separately from natural overflows.

All final exact-answer checks passed, including both policy questions. Page
counters confirmed exactly one save/load/export in each applicable run. No call
limit was exhausted. One baseline nested-record run generated invalid JavaScript
by mixing `&&` and `??` without parentheses; it corrected the expression and
finished correctly. No runtime patch was needed.

Manual transcript review found no wrong parent attribution, lost policy exception,
partial-read completeness claim, changed destination URL or duplicated mutation.
The narrow candidate made zero browser operations on all policy follow-ups;
baseline made 2, 0 and 2. This did not translate to fewer tool calls: policy totals
were 13 candidate versus 11 baseline. One candidate article run used seven calls,
including four oversized emissions and a full artifact reprint before selecting
relevant evidence. No successful text emission of at least 1 KiB was repeated
byte-for-byte; that metric does not detect overlapping selections or omitted
oversized emissions, so overflow counts and transcript review remain necessary.

## Final per-task results

Every row is 3/3 correct. Values are median [min–max]. “Input” is cumulative actual
provider input across the run, including cached input; “growth” is peak minus first
provider input. KiB counts serialized returned tool envelopes (not just body text).
The forced seed is excluded from generated tool-byte/call counts and recorded
separately. No output budget expansion was requested in this final comparison.

| Task / catalog | Tool KiB | Input tokens | Context growth | Tool calls | Wall seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| table / baseline | 6.1 [6.1–8.9] | 7619.0 [7607.0–9326.0] | 2186.0 [2179.0–3040.0] | 2.0 [2.0–2.0] | 7.8 [7.2–8.1] |
| table / candidate | 8.5 [8.0–8.7] | 11868.0 [9223.0–17187.0] | 3614.0 [2952.0–4125.0] | 3.0 [2.0–4.0] | 10.8 [10.6–11.7] |
| article / baseline | 1.9 [1.9–2.7] | 4692.0 [4472.0–5899.0] | 723.0 [722.0–925.0] | 2.0 [2.0–3.0] | 9.6 [6.2–10.5] |
| article / candidate | 4.0 [1.4–4.6] | 4840.0 [2825.0–15830.0] | 1075.0 [435.0–2006.0] | 2.0 [1.0–7.0] | 6.8 [3.4–21.3] |
| form / baseline | 1.6 [1.3–1.7] | 6062.0 [4688.0–6633.0] | 809.0 [701.0–1003.0] | 3.0 [2.0–3.0] | 7.8 [6.2–8.3] |
| form / candidate | 1.7 [1.2–1.9] | 6664.0 [4593.0–6926.0] | 955.0 [702.0–1076.0] | 3.0 [2.0–3.0] | 6.9 [6.5–7.6] |
| nested / baseline | 2.7 [2.2–4.6] | 5042.0 [4893.0–11646.0] | 1073.0 [886.0–2072.0] | 2.0 [2.0–4.0] | 8.9 [7.5–13.3] |
| nested / candidate | 2.7 [2.4–2.7] | 5426.0 [5422.0–7264.0] | 1175.0 [1171.0–1191.0] | 2.0 [2.0–3.0] | 9.5 [8.1–10.2] |
| cards / baseline | 4.0 [3.7–4.0] | 5830.0 [5680.0–7375.0] | 1429.0 [1292.0–1545.0] | 2.0 [2.0–3.0] | 9.2 [7.3–12.7] |
| cards / candidate | 4.6 [4.2–4.7] | 6802.0 [6443.0–6827.0] | 1897.0 [1885.0–2070.0] | 2.0 [2.0–2.0] | 7.7 [7.7–7.7] |
| caveat / baseline | 1.4 [1.0–2.2] | 9968.0 [7813.0–10143.0] | 940.0 [712.0–1049.0] | 4.0 [3.0–4.0] | 12.4 [9.5–12.5] |
| caveat / candidate | 1.3 [1.0–3.9] | 9647.0 [9625.0–13590.0] | 848.0 [717.0–1687.0] | 4.0 [4.0–5.0] | 12.5 [12.0–17.5] |
| partial / baseline | 1.7 [1.7–1.8] | 4610.0 [4568.0–4629.0] | 722.0 [720.0–738.0] | 2.0 [2.0–2.0] | 5.9 [5.8–7.0] |
| partial / candidate | 1.7 [1.7–1.9] | 4727.0 [4692.0–4883.0] | 767.0 [730.0–882.0] | 2.0 [2.0–2.0] | 7.4 [5.7–18.6] |
| overflow / baseline | 2.7 [2.6–2.7] | 7159.0 [6041.0–7781.0] | 1009.0 [848.0–1082.0] | 3.0 [2.0–3.0] | 8.7 [6.2–9.2] |
| overflow / candidate | 2.9 [2.0–3.0] | 7627.0 [5377.0–10070.0] | 1053.0 [708.0–1212.0] | 3.0 [2.0–4.0] | 10.1 [7.5–12.1] |

Across all eight tasks, baseline/candidate respectively: 160,176/188,378 input
tokens, 130,781/151,095 cached input, 7,728/8,198 output tokens, 61/68 tool calls,
9/14 natural overflows, and three forced seed overflows each. Aggregate tool
execution was 1.793/1.590 seconds; model time dominates. These totals are diagnostic,
not a blended score that can conceal task regressions. Cache/timing vary between
runs; no pricing or universal speedup is inferred.

## Earlier experiments and fixture corrections

- `/tmp/bud-browser-phase6-comparison.json`: broad retention/boundary/coverage/
  recovery advice. On the seven ordinary tasks it used 168,492 versus 150,800 input
  tokens with 55 calls on both sides. Article performance improved, but policy and
  nested-record costs increased. Rejected as a general optimization.
- That first overflow fixture exposed expected values in seed code. Exclude its
  six recovery results. The corrected seed reads unknown records from fixture data
  and requires an actual overflow with a complete artifact before evaluation.
- `/tmp/bud-browser-phase6-final.json`: shorter expanded candidate with explicit
  first-emission filtering/reuse. Six table runs completed; baseline article then
  hit `Request was aborted.` after 90.8 seconds. Raw failure retained; excluded
  from completed-run statistics. No product/browser failure or mutation replay.
- `/tmp/bud-browser-phase6-final-remaining.json`: seven remaining tasks with identical
  catalogs/runtime/model. The cards task ambiguously requested an `id`; four runs
  gave URL item number `4` rather than DOM record ID `w4`, despite correct workshop
  and URL selection. Clarified the task to require `data-record`, kept the oracle
  strict, and reran both catalogs in the final full suite. Those older card rows
  are not acceptance evidence for the corrected fixture.
- This expanded candidate improved policy reuse and forced recovery but increased
  context/calls on table/form tasks. The narrower follow-up-only cue was tested
  last, also failed the overall efficiency criterion, and was reverted.

## Validation and remaining work

- `pnpm build` from `service/`: passed.
- `pnpm exec node --import tsx --test src/agent/browser-tools.test.ts`: 10/10 passed,
  including after restoring the baseline catalog.
- Standalone strict TypeScript check of the harness: passed.
- Final provider fixture suite: 48/48 correct; exit 0.
- `git diff --check`: passed.
- Setup initially called unavailable `python` (`zsh: command not found: python`);
  rerun with installed `python3` succeeded. This was not a product/build issue.

Keep the new behavioral evaluation and existing Phase 5 guidance. A fresh live
product run using the corrected snapshot helper remains supplementary evidence;
it may show whether the earlier fidelity fixes already reduce unnecessary DOM
extraction. Do not respond to these results by adding a generic extractor,
site-specific filters, more mandatory prompt steps or a compaction change inside
this phase. Context-efficiency acceptance remains open.

No service/daemon restart, prepare, commit, deployment, protocol/schema/budget or
ownership change was performed. The existing Phase 4 catalog cutover, physical
viewer/private-control acceptance and separately reproduced scroll/click regression
remain open; these isolated fixtures do not establish lifecycle guarantees.
