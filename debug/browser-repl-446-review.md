# Review: Phase 5 browser REPL live run 4462398b

Reviewed 2026-09-23. Thread `4462398b-7aaf-4f74-ac43-3685ec0f9adc`.
Read-only inspection of thread/owner-scoped local messages, invocations and
provider usage. Evidence: `/tmp/bud-repl-446-review.json` (0600). No browser
actions, process changes or implementation changes during review.

## Outcome

Both invocations succeeded using gpt-5.6-luna with high reasoning effort.
Opening the community took 8.76 seconds, two cells and three provider calls,
returning 809 bytes of inline tool text. The subsequent request was to find the
seventh non-ad post, summarize comments, and draft a devil's-advocate reply.

The selected destination matches item seven in the emitted list of post
elements. An initial query selected both article wrappers and their child post
elements, duplicating stories; the agent corrected this by querying post
elements alone. All fifteen emitted records had `ad:false`, but the code did
not filter ads before numbering, and its descendant-only ad check does not
establish general exclusion of promoted items. The observed selection is
consistent; ordinal selection remains fragile on other page structures.

The final summary represents both complaints and counterarguments present in
the excerpts. The draft actually challenges the central claim and clearly says
it was not posted. The agent recovered the original post's initially omitted
tail, including caveats and updates, before answering. No execution errors,
stale handles, private-control interruptions, screenshots or submissions appear.

## Context and latency comparison

Comparison is with [8b60df59](browser-repl-8b60-review.md), the preceding reviewed
run with a similar request and the same model/effort. Posts and comment volumes
differ, so this is observational rather than a controlled Phase 5 experiment.
Metrics below cover the main request, excluding the initial opening turn.

| Metric | Previous run | Current run |
| --- | ---: | ---: |
| Work duration | 53.03 s | 84.39 s |
| REPL cells | 10 | 17 |
| Provider calls | 11 | 18 |
| Service-recorded tool duration total | 0.93 s | 1.17 s |
| Inline tool text, UTF-8 bytes | 88,760 | 43,262 |
| First → final provider input tokens | 15,105 → 59,780 | 13,969 → 34,242 |
| Input context growth | 44,675 | 20,273 |
| Cumulative provider input | 384,550 | 397,690 |
| Cached input within that total | 339,780 | 377,297 |
| Uncached input (total minus cached) | 44,770 | 20,393 |
| Provider output tokens | 2,788 | 3,696 |

Inline text fell 51%, context growth 55%, and final input 43%. However, elapsed
time increased 59%; extra calls made cumulative input slightly larger. Cached
tokens still occupy context. These counts are not a dollar-cost calculation.
Context growth includes code, messages and envelopes as well as tool output.

## What improved

- Native final-expression output and `console.log` both worked. No `repl.write`
  calls or missing-output symptoms occur.
- The runtime generation remained stable and variables were reused across
  cells. The agent projected stored arrays rather than repeatedly fetching the
  page for every batch.
- It eventually emitted compact records and text instead of the earlier run's
  large accessibility-node dumps and arbitrary artifact prefixes.
- It obtained useful opposing evidence and recovered the full post through an
  additional read rather than treating the first clipped prefix as complete.

## Remaining issues

1. **Overflow still drives too much trial and error.** Eight of seventeen cells
   emitted output-omitted notices. After the first overflow, the agent returned
   the entire artifact with `repl.files.read`, causing another overflow. Six
   cells raised the output budget. Execution succeeded, but these round trips
   contributed little immediate evidence and required further model calls.

2. **Entity boundaries remain lossy.** Reading each comment container's
   `innerText` also included descendant replies, which were then emitted again
   as separate records. For example, record 2 contains text from record 3;
   records 22–24 repeat the same reply chain. Author/depth fields help, but the
   body does not reliably belong only to its named author.

3. **Page implementation text consumed useful space.** Seven of the 100 emitted
   comment records contain repeated `SML.load(...)` source text. In several
   300-character excerpts this occupies almost all the available text, cutting
   off the actual comment. This is evidence to improve structural extraction,
   not a reason to add a Reddit-specific string blacklist.

4. **Data was truncated before being retained.** The initial extraction stored
   only 1,800 characters of the post and 1,000 per comment; emitted comment
   batches further clipped to 300–400 characters. Reprinting the saved post
   could not recover its missing tail. A subsequent fresh read retrieved the
   3,953-character post and emitted its last 2,500 characters, which overlapped
   the original prefix and supplied the missing content.

5. **Coverage was overstated by omission.** The agent emitted excerpts for all
   100 currently extracted comment elements, but the transcript shows “more
   replies” controls, empty comment bodies and clipped text. It did not expand
   those replies or establish complete discussion coverage. The final answer
   should qualify its summary as based on loaded comments, and avoid implying
   measured sentiment proportions from duplicated, incomplete records.

## General follow-up

Keep the standard output model. The next opportunity is selective extraction
and planning, not another output API or a dedicated comment-extraction tool:

- Preserve complete relevant data in REPL memory; project bounded output only
  at emission time, retaining identifiers and parent relationships.
- Inspect a small structural sample first, then extract each entity's own body
  without nested duplicates, controls or script/style content.
- After overflow, inspect/project the retained value or parse its artifact
  locally; do not emit the same oversized value again.
- Report loaded/omitted coverage and selectively expand incomplete evidence
  that matters to the requested answer.
- Assess both context and number of model round trips. Lower peak context alone
  did not make this run faster.

No prompting or implementation changes were made as part of this review.
