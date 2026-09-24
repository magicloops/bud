# Debug: Phase 7b snapshot output compaction

## Environment and evidence

macOS checkout; managed Node/Chrome helper fixtures and service-local provider
comparison harness. See [plan](../plan/bud-owned-browser/repl-phase-7b-output-compaction.md)
and [01ce review](../review/browser-repl-01ce-review.md). The reviewed projection
used 27,647 bytes for 145 records, including 12,754 URL bytes and 5,482 reference
bytes. One URL repeated eight times. Seven overflows included whole-artifact
reprinting. Rich local data remained available throughout.

## Expected and approach

Retain exact structured data; use a pure snapshot formatter with scoped short
references and exact URL lookup. Add explicitly incomplete overflow excerpts to
the existing collector, preserving artifacts, receipts and authority. Measure at
8 KiB first, then compare 8/16/32 KiB. Do not replay actions to recover output.

## Implementation

- Full sanitized snapshots retain exact `nodes`, identity and coverage. Three
  non-enumerable facade methods add a pure view, original-observation-bound short
  action handles and exact URL lookup; JSON serialization is unchanged.
- `snapshot.format({nodes?,maxBytes?})` preserves source order and whole records,
  uses short eN refs, factors repeated/long URLs into uN entries and states omitted
  nodes/definitions. Requested view size cannot expand the remaining cell budget.
- Console/final completion keep preceding writes, then a UTF-8-safe, explicitly
  incomplete excerpt when room remains. Full bounded capture/artifacts, authority
  fences and exactly-once execution are unchanged. No new wire fields or routes.
- Add-on source/watch lists and REPL readiness include `repl-snapshot.mjs`.
  Service guidance teaches the view and retained-data recovery. No new parser,
  extraction tool, symbol service, conversation compactor or site-specific rule.

## Validation and corrections

Commands run from the repo root except Rust commands from `bud/` and `pnpm`
commands from `service/`. Live fixture executable:
`/Users/adam/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
Managed Node: `~/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node`.
Rust fixture helper: checkout `bud/browser-helper/main.mjs`.

- `BUD_BROWSER_EXECUTABLE=… node --test bud/browser-helper/*.test.mjs`:
  initial complete helper suite, 58 passed, none skipped.
- Final targeted `BUD_BROWSER_EXECUTABLE=… node --test
  bud/browser-helper/repl-snapshot.test.mjs bud/browser-helper/repl-worker.test.mjs`:
  25 passed, none skipped. Includes record-boundary budget capping after earlier
  writes, exact URLs, retained data, giant values/Unicode, mutation exactly once,
  scope binding and real Chrome recapture/navigation/invalidation/closure rejection.
- Managed Node/Chrome/helper `cargo test repl_execution -- --test-threads=1`:
  16 passed, including real Chrome, takeover/Return, cross-workspace authority,
  cancellation, restart, retained state and output withholding.
- Same environment `cargo test browser::repl -- --test-threads=1`: two trace tests passed.
- `pnpm exec node --import tsx --test src/agent/browser-tools.test.ts
  src/agent/browser-observation-budget.test.ts src/browser/repl.test.ts`:
  12 passed, one opt-in PostgreSQL receipt test skipped. No DB code changed.
- `pnpm build` and package-local `cargo build`: passed. Embedded archive’s
  `repl-snapshot.mjs` matches the checkout byte-for-byte. `cargo fmt --check`:
  passed after formatting `repl.rs`.

An initial repo-root `cargo build` failed with `could not find Cargo.toml in
/Users/adam/bud or any parent directory`; rerunning from `bud/` passed.
Initial `cargo fmt --check` reported the new prepared-module array and trace
assertion formatting; `rustfmt --edition 2021 bud/src/browser/repl.rs` fixed it.
Two new preview tests initially used examples small enough to fit after compaction
(expected `/PREVIEW/`, received complete views); increased the record count/reduced
available bytes to exercise actual omission. Production behavior was correct.

The first provider comparison exposed a real API usability issue: explicit
`format({maxBytes:20000})` could exceed an 8 KiB cell, producing a generic excerpt
of a structured view. The formatter now clamps to remaining cell space; explicit
expansion still belongs to `repl.setOutputBudget`. Added regressions and restarted
the fixed comparison. The interrupted exploratory report is private at
`/tmp/bud-phase7b-comparison.json`; do not combine its changing-runtime results
with the final comparison.

## Retained live-evidence reformatting

Replayed both retained 228-node snapshots from the 01ce traces, without querying
Chrome or sending content to a provider. The original selected 145-node projection
formatted to 27,647 bytes (Node inspection also limited its array display). The
new view displays all 145 selected records in 12,288 bytes at 16/32 KiB. At 8 KiB,
it displays 97/145 records in 8,190 bytes with an explicit remaining-record notice.
All 228 source nodes and exact URLs remain local. This is a presentation comparison,
not a new live-agent task, a claim of full page coverage, or proof of token savings.
Private metric-only report: `/tmp/bud-phase7b-retained-comparison.json`.

## Activation and remaining acceptance

Drain browser cells, rebuild the daemon, prepare its matching add-on, update service
guidance and restart affected workers together. No DB migration or web/mobile build.
No service/daemon restart, commit, PR update or deployment was performed here.
A fresh user-driven product run is still required for supplementary live acceptance;
Phase 8 remains the final merge gate, including physical viewer/lifecycle checks.


## Fixed-fixture provider comparison and budget decision

Private reports: `/tmp/bud-phase7b-final-comparison.json` (five core fixtures)
and `/tmp/bud-phase7b-url-navigation.json` (exact-URL navigation fixture), both
0600 with full tool/provider traces. The failed URL-transcription experiment in
the first report is analyzed separately below, not silently counted as a pass.
`gpt-5.6-luna`, high reasoning, two repeats per fixture/mode; frozen old worker/API
and catalog versus final candidate at 8/16/32 KiB. Six neutral fixtures, 48 tasks.
Order alternates by repeat. Fixture, prompt, helper and harness hashes are in the
reports. Disposable headless Chrome; excludes normal Bud system/history overhead,
daemon admission, persistence, viewer and remote-network latency.

| Mode | Correct | Tool calls | Provider calls | Input tokens | Output tokens | Cached input (included) | Max input context | Total seconds | Natural overflows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 10/12 | 45 | 59 | 147916 | 5389 | 117489 | 7890 | 159.7 | 15 |
| candidate_8192 | 12/12 | 27 | 41 | 122561 | 3420 | 93260 | 6458 | 97.5 | 0 |
| candidate_16384 | 12/12 | 27 | 41 | 146763 | 3257 | 111407 | 7250 | 98.5 | 0 |
| candidate_32768 | 12/12 | 24 | 38 | 138516 | 3264 | 97345 | 7141 | 93.9 | 0 |

Ranges over two repeats (not confidence intervals):

| Fixture | Mode | Input tokens min–max | Tool calls min–max | Wall seconds min–max |
| --- | --- | ---: | ---: | ---: |
| table | baseline | 14350–16842 | 3–5 | 10.5–16.1 |
| table | candidate_8192 | 10810–11238 | 2–2 | 7.5–7.9 |
| table | candidate_16384 | 20971–27540 | 3–4 | 12.7–15.9 |
| table | candidate_32768 | 13908–14473 | 2–2 | 8.1–10.5 |
| cards | baseline | 6117–6463 | 2–2 | 7.7–7.7 |
| cards | candidate_8192 | 6316–6459 | 2–2 | 7.3–7.8 |
| cards | candidate_16384 | 6314–6428 | 2–2 | 6.9–7.5 |
| cards | candidate_32768 | 6142–6408 | 2–2 | 6.9–8.1 |
| caveat | baseline | 10325–11935 | 4–4 | 13.6–15.6 |
| caveat | candidate_8192 | 14518–14860 | 3–3 | 10.3–12.1 |
| caveat | candidate_16384 | 17454–17590 | 3–3 | 10.0–11.9 |
| caveat | candidate_32768 | 17452–17516 | 3–3 | 9.2–10.5 |
| partial | baseline | 4861–5008 | 2–2 | 7.3–7.8 |
| partial | candidate_8192 | 5474–5494 | 2–2 | 6.9–7.5 |
| partial | candidate_16384 | 5444–5478 | 2–2 | 5.1–5.4 |
| partial | candidate_32768 | 5340–5462 | 2–2 | 5.7–7.4 |
| overflow | baseline | 6482–8808 | 2–3 | 9.5–10.7 |
| overflow | candidate_8192 | 6025–9429 | 1–2 | 5.0–7.3 |
| overflow | candidate_16384 | 8684–8735 | 1–1 | 4.2–5.1 |
| overflow | candidate_32768 | 14022–14031 | 1–1 | 5.2–7.0 |
| repeated_urls | baseline | 22661–34064 | 7–9 | 21.2–32.1 |
| repeated_urls | candidate_8192 | 11860–20078 | 2–4 | 6.2–11.8 |
| repeated_urls | candidate_16384 | 11028–11097 | 2–2 | 4.9–8.8 |
| repeated_urls | candidate_32768 | 11811–11951 | 2–2 | 6.9–8.2 |

Seeded overflow is deliberate and counted separately. Each export runs exactly
once. Natural overflow counts exclude the seeded export; provider usage includes
its prior result. Snapshot PREVIEW elision is not collector overflow. Correctness
checks include full query/fragment URLs, late policy exceptions and follow-up,
loaded-versus-total coverage, ordinal record identity and single mutations.

- baseline: 0 snapshot preview results; 0 agent budget-request cells; 1 failed tools; 68778 serialized tool-result bytes (excludes seed).
- candidate_8192: 4 snapshot preview results; 0 agent budget-request cells; 0 failed tools; 70175 serialized tool-result bytes (excludes seed).
- candidate_16384: 4 snapshot preview results; 0 agent budget-request cells; 0 failed tools; 85189 serialized tool-result bytes (excludes seed).
- candidate_32768: 4 snapshot preview results; 0 agent budget-request cells; 0 failed tools; 86128 serialized tool-result bytes (excludes seed).


### Findings and explicit budget decision

**Keep 8 KiB**, with existing explicit expansion up to 32 KiB before output.
All 36 candidate tasks passed. Relative to candidate 8 KiB, 16 KiB spent 19.7%
more cumulative input with the same call count; 32 KiB spent 13.0% more input for
three fewer tool calls and 3.6 seconds less total time. Two repeats do not establish
a reliable latency advantage. 8 KiB had the lowest observed peak context. A task
needing the complete 12.3 KB retained example can explicitly use 16 KiB; there is
no adaptive budget policy or automatic action retry.

Compare equal-success core fixtures separately: both versions passed 10/10.
Baseline cumulative input was 91,191 versus 90,623 at candidate 8 KiB (essentially
flat), while tool calls fell from 29 to 21. Table lookup improved; late-caveat
reading used fewer calls but more input; small cards/partial-loading tasks were
similar. Useful previews can increase bytes compared with dropping output; do not
claim universal context savings from formatting alone. The two candidate 8 KiB
seeded-export recoveries took one and two tools respectively; both exported once.

In exact-URL navigation, baseline chose the neighboring Record 18 in both runs,
and the browser destination check failed. Candidate identified Record 17 and
navigated to the exact complete URL in all six runs. The original baseline also
had one unavailable-artifact lookup on a caveat task before recovering. These
are agent behavior results on deterministic fixtures, not proof of immunity to
future attribution errors. Source order, identity and full local data matter.

### URL-transcription experiment, retained failure

The first full 48-run report includes a different last task: reproduce the long
opaque URL in final JSON rather than navigate with it. All eight such attempts
failed, including all six candidate runs. Several exhausted the harness's 3,000
output-token limit with empty or unfinished answers; others abbreviated or
mis-copied the repeated token. This was not loss of the URL in the helper or
formatter: the complete string was present in selected evidence.

Do not count those as passes or silently discard the result. The supplemental
navigation fixture keeps identical page/URLs and verifies `page.url()` against
the entire expected string, while asking for a short record identifier. Its
comparison is separately recorded and checks use of retained exact data instead
of model transcription. Human-facing reproduction of long opaque values remains
a limitation; raising the browser output budget did not solve it. No production
provider limit or URL-rewriting workaround was added.

### Reproduction

From root, with the managed Node/Chrome paths listed above:

```sh
BUD_BROWSER_NODE=… BUD_BROWSER_EXECUTABLE=… \
BUD_BROWSER_LIVE_MODEL=gpt-5.6-luna BUD_BROWSER_COMPARISON_EFFORT=high \
BUD_BROWSER_COMPARISON_REPEATS=2 \
BUD_BROWSER_COMPARISON_FIXTURES=table,cards,caveat,partial,overflow,repeated_urls \
BUD_BROWSER_COMPARISON_BASELINE_HELPER=/tmp/bud-phase7b-baseline \
BUD_BROWSER_COMPARISON_BUDGETS=8192,16384,32768 \
pnpm --dir service exec tsx scripts/compare-browser-repl.ts \
  /tmp/new-comparison.json /tmp/bud-phase7b-baseline/catalog.json
```

The frozen baseline directory contains pre-change worker/API/artifact modules,
semantic sources, a dependency symlink and the saved pre-change catalog. The
current harness uses the navigation version of `repeated_urls`; the original
transcription fixture, outputs and hashes remain in the first report. The first
report exited nonzero for eight incorrect transcription answers; the supplemental
report exited nonzero for the two incorrect baseline destinations. Candidate
answers and exact destination checks all passed. These exit codes are measured
agent failures, not build/infrastructure failures.
