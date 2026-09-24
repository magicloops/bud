# scripts

Standalone utility scripts for querying and debugging.

## Purpose

Command-line tools for inspecting data outside the main service. Useful for debugging and ad-hoc queries.

## Files

### `query-messages.ts`

Query messages for a thread.

**Usage**:
```bash
npx tsx scripts/query-messages.ts <thread-id>
```

**Output**: Lists messages with role, timestamp, and content preview.

### `query-terminal-output.ts`

Query terminal session output history.

**Usage**:
```bash
npx tsx scripts/query-terminal-output.ts <session-id> [options]
```

**Options**:
- `--bytes <n>` - Limit output bytes
- `--since <offset>` - Start from byte offset
- `--raw` - Output raw bytes (no formatting)

**Output**: Terminal output with byte offsets and timestamps.

### `compare-browser-repl.ts`

Opt-in Phase 4 comparison using actual provider usage and disposable Chrome,
semantic engine and REPL worker. Fixed table, article and form tasks run with
both catalogs, alternating order and repeating three times by default. Writes
0600 JSON reports to an explicit path; no service DB or user Chrome profile.
Requires `OPENAI_API_KEY`, `BUD_BROWSER_NODE`, `BUD_BROWSER_EXECUTABLE` and
`BUD_BROWSER_LIVE_MODEL` (or `DEFAULT_MODEL`). Optional
`BUD_BROWSER_COMPARISON_REPEATS=1..5` and
`BUD_BROWSER_COMPARISON_EFFORT=low|high` (default low). Phase 5 reuses the
same fixtures with console/native completion output. Run from `service/`:
`pnpm exec tsx scripts/compare-browser-repl.ts /tmp/browser-comparison.json`.
An optional third argument is a previously saved `BROWSER_REPL_TOOLS` JSON
catalog. This Phase 6 mode compares baseline/candidate guidance on the same
corrected helper; it adds nested-record attribution, ordinal cards, tail caveats
with follow-up, partial loading and seeded overflow recovery. The report records
prompt/fixture/helper/harness hashes, exact answer and mutation checks, actual
provider usage, first/peak context, natural versus forced overflows, literal budget
request cells, operation counts and tool/total time. A 16-provider-call ceiling
counts exhaustion as failure. HTTP fixture routing applies to the whole disposable
context; trusted Node execution is not a security sandbox. Optional
`BUD_BROWSER_COMPARISON_FIXTURES=name,name` selects a known subset for focused
reruns (recorded in the report). See
[Phase 6 results](../../debug/browser-repl-phase6.md).
Opt-in Phase 7 `disclosure,layered` fixtures check expansion/post confirmation
and count unintended profile/preview events using the real agent and element API.
Engine errors are canonicalized like the product helper, without raw Playwright
call logs that would give the comparison agent additional diagnostic evidence.
This is output/agent measurement, not daemon ownership or physical viewer acceptance.

Phase 7b adds the `repeated_urls` neutral fixture and optional
`BUD_BROWSER_COMPARISON_BASELINE_HELPER` (frozen helper directory plus the saved
catalog argument). `BUD_BROWSER_COMPARISON_BUDGETS=8192,16384,32768` runs candidate
budgets using the existing explicit per-cell budget API and corresponding guidance.
Reports record budget and baseline module hashes, with the same correctness,
provider usage and timing metrics. This does not change production defaults.

### Accessibility representation spike

`compare-browser-accessibility.mjs` captures raw Chrome AX, browser-use-pi's
projection, raw Playwright ARIA JSON and the current Bud full compact REPL
snapshot on disposable fixed fixtures and public live pages. Three alternating
captures record complete private artifacts, JSON byte/node counts, repeated text,
field coverage, preview sizes and timing. No provider calls, service DB, running
Bud browser/profile, or production behavior changes. Requires installed helper
dependencies and `BUD_BROWSER_EXECUTABLE`; run from `service/` with
`node scripts/compare-browser-accessibility.mjs /tmp/bud-ax-spike`.
See [findings](../../debug/browser-accessibility-spike.md), including the initial
string-child/state omissions and corrected-runtime follow-up. Phase 6 comparisons
use that corrected runtime on both sides.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../src/db/client.js` | Database connection |
| `../src/db/schema.js` | Table definitions |
| `drizzle-orm` | Query helpers |

## Note

These scripts are in `service/scripts/` (top-level), separate from `service/src/scripts/` (internal utilities).

---

*Referenced by: [../service.spec.md](../service.spec.md)*
