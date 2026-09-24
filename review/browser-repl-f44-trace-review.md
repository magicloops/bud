# Browser REPL trace review: f44c19fd

Thread: `f44c19fd-16d2-41a5-b2af-0420de049dc1`.

Related: [previous run review](./browser-repl-48e-pre-json.md),
[observation tracing](../plan/bud-owned-browser/repl-observation-tracing.md).

## Outcome and evidence

The agent opened the community, selected the seventh non-ad entry from its
observed feed, inspected the post and comments, and produced a draft without
posting it. Its final response explicitly disclosed that one comment remained
collapsed. This was a useful but incomplete comment review, not full coverage.

Reviewed the ownership-scoped service transcript, provider usage records, all
31 matching local cell traces, and all four retained screenshot artifacts.
Each trace's `daemon_result` exactly matches its persisted tool result `data`.
No trace stages were omitted, and no recorded stage was cut by diagnostic
capture limits. This validates the daemon-to-transcript result path; it is not
an independent capture of the final provider HTTP payload.

Raw evidence remains local in `/tmp/bud-repl-f44-review.json` and
`/tmp/bud-repl-f44-traces/`, with owner-only permissions. Page dumps and images
are deliberately not checked into this review.

## Cost and timing

The thread has two successful invocations: three browser cells to open the
community, followed by 28 for the substantive task. Both used gpt-5.6-luna with
high reasoning. The table compares only the substantive tasks.

| Metric | Previous 48e run | Current f44 run |
| --- | ---: | ---: |
| Invocation duration | 99.3 s | 134.9 s |
| Browser cells | 25 | 28 |
| Provider calls | 26 | 29 |
| Inline browser text | 37,949 bytes | 22,921 bytes |
| Inline output overflows | 5 | 4 |
| First → last provider input tokens | 13,998 → 39,059 | 15,444 → 42,120 |
| Input growth | 25,061 | 26,676 |
| Cumulative provider input tokens | 686,642 | 832,065 |
| Cumulative cached input tokens | 661,437 | 805,238 |
| Provider output tokens | 4,629 | 4,286 |
| Sum of recorded tool durations | 6.29 s | 9.38 s |

Inline text fell about 40%, but this task took about 36% longer. Smaller text
output alone does not guarantee smaller total context or faster completion:
code, envelopes, conversation history, screenshots and repeated provider calls
also matter. Cumulative input counts include repeated cached history and are
not the context window size. These runs involved different posts and imagery,
so this is an observational comparison, not a controlled benchmark. The timing
records do not isolate a single cause for all non-tool time.

## What worked

- The compact feed query returned distinct post IDs, titles, URLs and ad flags.
  Its seventh entry was `t3_1wog0vc`, “These Days Man,” matching the selected
  page. This supports the selection within the observed feed; it does not prove
  that the generic ad heuristic correctly classifies every possible feed item.
- The screenshot of the post confirms the environmental-impact cartoon and
  caption described in the answer. The comment image and surrounding text are
  also consistent with the answer. The agent associated the image with its
  owning comment rather than the adjacent comment.
- The same REPL generation survived all 31 calls. There was no private-control
  reset or JSON-endpoint fallback in this run.
- The final answer acknowledged its missing collapsed comment rather than
  inventing its contents.

## Oversized emission and redundant recovery

Cell numbers below include the three initial opening cells.

| Cells | Observation |
| --- | --- |
| 4 | A query matching both article and post wrappers duplicated entries. |
| 10 | The retained `feed` value formatted to 11,902 bytes and overflowed the 8,192-byte inline limit. |
| 11 | The agent read the overflow artifact and printed its first 12,000 characters, producing another overflow of 11,903 bytes. |
| 12 | It queried the page again with a compact projection instead of projecting the already-retained feed. |
| 14 | A filtered snapshot projection formatted to 8,558 bytes and overflowed. The complete snapshot remained in the REPL. |
| 15–18 | Broad DOM inspection included style records, all post attributes, and up to 2,500 characters of HTML per comment. The latter formatted to 15,546 bytes and overflowed. |

The instrumentation distinguishes complete extraction from failed inline
emission. Increasing extraction limits would not fix these examples: the
values were already available in memory. Arbitrary character slicing also
does not reliably meet a byte budget or select useful content.

The generic improvement is to project retained values to the needed fields
and records before printing, including during overflow recovery. Large raw
HTML and attribute dumps are particularly poor first-line diagnostics.

## Collapsed disclosure: an upstream gap plus a lost hint

The agent obtained four comment records: two textual comments, one image
comment, and one collapsed comment. DOM inspection confirmed a collapsed
attribute and a `details`/`summary` structure for the collapsed item. Its
`innerText` contained only the author and time. The sampled HTML stopped in
the header; this run does **not** establish whether the full hidden body was
already present in the DOM.

The raw Playwright snapshot likewise lacked the collapsed body and an
explicitly named expansion button or expanded state. This omission therefore
predates Bud's snapshot processing; it was not caused by output truncation.

However, the raw snapshot did expose this useful structure:

```text
article "Comment from …"
  generic [ref=f6e290, cursor=pointer]
    link "…'s profile"
    link
      time "9h ago"
```

Bud retained the generic node and reference but dropped `cursor: "pointer"`.
The agent then filtered for names containing the author or expansion words,
which excluded the unnamed generic node. In cell 28 it clicked the enclosing
article, receiving `browser_click_blocked` after 102 ms.

The click-point selector emits that error when it cannot find an allowed
point before input dispatch. It rejects points through nested interactive
elements, including `summary`; that is consistent with this enclosing-article
choice. The trace does not include candidate rejection details, so it does
not prove which particular geometry/hit test failed here. This is not evidence
that a click was sent and then misreported as intercepted.

The third screenshot visibly shows the small plus control next to the
collapsed header. Preserving the pointer hint could help discovery, but a
pointer cursor is not proof of a disclosure action or a safe click target.
Do not automatically redirect arbitrary container clicks to their children.

## Other friction

- Cells 5 and 7 failed scrolling with `browser_stale_reference`. Recreating
  the tab handle and reading its URL did not repair this; a fresh snapshot in
  cell 8 did, and cell 9 scrolled successfully. The traces establish the
  recovery sequence, not the exact invalidation trigger. Investigate whether
  viewport scrolling unnecessarily depends on semantic observation freshness.
- Four screenshots were emitted. The last enlarged a comment image already
  visible in an earlier screenshot; this may improve legibility, but creates
  additional tool/provider work. The extra image tab was left open after
  selecting the original tab again.

## Recommended next steps

1. Add a neutral collapsed-disclosure fixture with a custom article role,
   unnamed clickable header, nested profile link and hidden body. Compare
   upstream snapshot, Bud representation and safe action targeting. Preserve
   useful generic interaction hints if that fixture demonstrates the benefit.
2. Reinforce bounded projection of retained REPL values, especially after
   overflow. Validate this on non-Reddit lists and detail pages; do not add a
   dedicated comment extractor or raise budgets based on this run.
3. Reproduce stale-reference scrolling across turns and separate the scrolling
   requirement from element-reference freshness if the current guard is
   unnecessarily restrictive. Preserve ownership/document safety checks.

The new traces were sufficient to separate capture omissions, Bud field loss,
agent projection choices and inline overflow. A focused click-preparation
reason/candidate count would help the remaining actionability question;
additional full-page logging is not needed to explain the observed context
waste.

No runtime changes, browser actions, service restarts or commits were made
as part of this review.
