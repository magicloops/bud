# Debug: REPL Phase 5 standard output

## Environment and objective
Managed Node 24.21.0 on macOS; Phase 5 console and native completion output.
See [plan](../plan/bud-owned-browser/repl-phase-5-standard-output.md).

## Validation observations
Command: `/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node --test bud/browser-helper/repl-worker.test.mjs`.
Initial result: 15 passed, 1 failed. Revoked proxy assertion expected
`/Revoked Proxy/`, but output was `[Value could not be displayed; select concrete fields from retained data]`.
The binary-value guard encounters a revoked proxy before Node inspection; the
bounded formatting fallback is intentional. Correct the assertion to verify
successful completion with the fallback, rather than require native proxy text.

`cargo fmt --manifest-path bud/Cargo.toml --check` initially requested collapsing
one shortened test call onto one line. Applied that formatting change; rerun below.

## Settled implementation

Native evaluator completion is captured once, appended only after supported
operations drain successfully, and delivered through the existing authority fence.
`repl.write` is gone with no alias. Console/completion share finite Node inspection,
complete-emission overflow and existing artifact storage. There is no new parser,
extraction subsystem, protocol field, table, compatibility path or compactor.
The agent description now covers ordinary console/final output and selective
extraction. Active examples/tests are migrated; historical reports are unchanged.

Inspection: depth 5, 100 array entries, 10,000 characters per inspected string,
getters/custom inspection disabled. Elision is a preview property, not the byte
budget's `truncated` flag. Binary completions get a size notice. Formatting failure
keeps successful effects successful and emits a bounded notice.

## Automated validation

- Managed Node: `--test bud/browser-helper/repl-worker.test.mjs bud/browser-helper/engine.test.mjs bud/browser-helper/click-point.test.mjs`, with installed Chrome in `BUD_BROWSER_EXECUTABLE`: **33 passed, none skipped**.
- `BUD_BROWSER_NODE=<managed Node> BUD_BROWSER_EXECUTABLE=<installed Chrome> cargo test --manifest-path bud/Cargo.toml --lib repl_execution -- --test-threads=1`: **16 passed**, including real Chrome, takeover, cancellation, restart and no-replay tests.
- From `service/`, `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/browser/repl.test.ts src/browser/image-artifacts.test.ts src/browser/image-references.test.ts src/agent/browser-tools.test.ts src/browser/continuation.test.ts`: **16 passed**. After replacing the mocked cell output with a real worker in the AgentService fixture, the 10 agent tests passed again. That fixture verifies selected final-expression and console evidence each appears once in the next provider request; unprinted source data remains absent. Provider networking and DB I/O remain mocked there.
- Service `pnpm exec tsc --noEmit` and standalone comparison-script strict TypeScript check passed.
- `cargo build --manifest-path bud/Cargo.toml`, `cargo fmt --manifest-path bud/Cargo.toml --check`, and `git diff --check` passed.
- Rebuilt daemon and ran `./bud/target/debug/bud browser prepare --no-restart`; matching archive installed and Chrome launch probe passed. Preparation reported no running daemon. Start/restart the daemon to activate it; existing heaps are not migrated.

## Controlled provider comparison

Same fixed table/article/form tasks, model `gpt-5.6-luna`, low reasoning and
three repetitions per catalog as Phase 4. **18/18 answers correct**. Form fixtures
also require exactly one Save. One REPL article run had a generated syntax error
(missing closing parenthesis), corrected by a subsequent cell; no runtime patch
was needed. These fixtures exercise real provider calls, Chrome and the worker,
not the complete production service or physical viewer.

Raw reports (0600, local only): `/tmp/bud-browser-phase5-measured.json` and
`/tmp/bud-browser-phase5-high.json`; baseline `/tmp/bud-browser-phase4-measured.json`.
Run from `service/` with managed `BUD_BROWSER_NODE`, installed
`BUD_BROWSER_EXECUTABLE` and `BUD_BROWSER_LIVE_MODEL=gpt-5.6-luna`:
`pnpm exec tsx scripts/compare-browser-repl.ts <report path>`.
The additional high-reasoning sample uses `BUD_BROWSER_COMPARISON_EFFORT=high`
and `BUD_BROWSER_COMPARISON_REPEATS=1`.

All following values are medians; input/cache/output counts are provider-reported.
Input is cumulative across requests and includes cached tokens. Bytes count tool
result envelopes, not just page text. Small samples do not establish latency gains.

| Fixture / catalog | Input | Peak input | Cached input | Output tokens | Tool calls | Provider calls | Tool bytes | Duration ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| table / Phase 4 repl | 8613 | 2421 | 7468 | 394 | 4 | 5 | 2545 | 9739 |
| article / Phase 4 repl | 3341 | 2055 | 2566 | 120 | 1 | 2 | 3716 | 3414 |
| form / Phase 4 repl | 6215 | 1943 | 5631 | 295 | 3 | 4 | 1752 | 7357 |
| table / Phase 5 tools | 11315 | 9422 | 0 | 146 | 2 | 3 | 21973 | 4687 |
| table / Phase 5 repl | 9835 | 3094 | 7903 | 405 | 4 | 5 | 4157 | 10119 |
| article / Phase 5 tools | 7955 | 6075 | 0 | 117 | 2 | 3 | 27066 | 4712 |
| article / Phase 5 repl | 3221 | 2049 | 2338 | 118 | 1 | 2 | 3782 | 5069 |
| form / Phase 5 tools | 7650 | 1731 | 4049 | 348 | 5 | 6 | 1350 | 10665 |
| form / Phase 5 repl | 6115 | 1922 | 5338 | 299 | 3 | 4 | 1146 | 7961 |

Compared with Phase 4 REPL, table median cumulative input rose 8,613→9,835,
peak input 2,421→3,094 and output bytes 2,545→4,157. All three low-effort table
runs began with broad prefix output and overflowed; two then made unproductive
link-name searches before extracting the right rows. Article/form input medians
fell slightly, but duration medians increased. Do not claim universal savings.
No low-effort run expanded its output budget or read a raw artifact prefix;
three emissions overflowed and were recovered through retained data/extraction.

The additional high-effort sample passed **6/6 answers** across both catalogs.
REPL table/article/form cumulative input was 7,886 / 4,710 / 6,546, with
2 / 2 / 3 tool calls respectively. One article emission overflowed; none expanded
budgets or read artifacts. Broad prefixes still occurred, and the table discovery
logged an unawaited `tab.url()` inside JSON (an empty object rather than a URL),
then correctly extracted exact URLs in its next cell. Guidance remains imperfect;
no site-specific rules or extra runtime API were added to chase this sample.

## Remaining acceptance

Implementation and automated checks are complete. A fresh high-effort **product
thread** and physical web/iOS takeover/viewer check still need a user-run session.
The high-effort disposable fixtures above are not that product acceptance.
General selective-output behavior and Phase 4 catalog cutover remain open; retain
the old catalog comparison setting until the existing acceptance gates pass.
