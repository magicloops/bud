# Review: Phase 4 browser REPL live run 8b60df59

Reviewed 2026-09-23. Thread `8b60df59-dfc5-4de6-a72a-91dbae2e3724`.
Read-only inspection of thread/owner-scoped local messages, invocations and
provider usage. No browser actions, process restarts or implementation changes.
Local evidence: `/tmp/bud-repl-8b60-review.json` (0600).

## Outcome and timing

Model: gpt-5.6-luna, high reasoning effort. Both invocations succeeded.

| Request | Work duration | REPL cells | Provider calls | Tool duration | Inline text |
| --- | ---: | ---: | ---: | ---: | ---: |
| Open community | 12.23 s | 3 | 4 | 2.63 s | 3,211 bytes |
| Find seventh post, summarize comments, draft reply | 53.03 s | 10 | 11 | 0.93 s | 88,760 bytes |

All cells completed without execution errors. No stale-reference or missing-API
errors, screenshots, handoffs, fills or submissions appear. The agent navigated to
the selected post and returned a draft in chat. Tool duration is service wall
clock, not all browser or provider latency; the remainder includes model and
orchestration time.

The opened post matches the seventh distinct destination in the emitted feed
list after resolving relative URLs against the page URL. However, the agent's
own deduplication kept relative and absolute versions separately and stripped
query strings. It then counted the distinct stories in reasoning. It filtered
links by the community's comments URL pattern rather than proving exclusion of
promoted entries through item boundaries/metadata. The result is consistent with
the visible evidence, but this is not a robust general ordinal-selection method.

The summary themes are supported by the returned comments. The final selective
read emitted 50 paragraph strings, not 50 distinct comments. It starts after a
heading and continues to the end of the snapshot without a subtree boundary;
there is no demonstrated exhaustive coverage of all 51 displayed comments or
unloaded replies. The final answer does not qualify loaded-comment coverage.
The draft largely agrees with the skeptical comments rather than strongly
arguing the opposite perspective requested; this is answer quality, not tool failure.

## Output behavior and actual provider usage

Phase 4 controls are demonstrably active: setOutputBudget succeeded and two
oversized writes were omitted whole with intact local artifacts (43,831 and
56,439 bytes). No action was replayed to recover output.

However, eight of ten main-turn cells explicitly increased the budget to
16,000–24,000 bytes. After each overflow the agent read the exact artifact path
but printed its first 15,000 or 19,000 characters, ending mid-JSON/mid-URL. The
runtime preserved the complete string it was asked to emit; it cannot make an
agent-authored arbitrary string slice semantically complete.

| Main-turn output | Bytes | Following provider input increase |
| --- | ---: | ---: |
| Raw feed artifact prefix | 15,005 | 8,594 tokens |
| Raw post artifact prefix | 19,005 | 11,122 tokens |
| First 120 comment-area nodes | 12,397 | 4,438 tokens |
| Next 160 comment-area nodes | 21,864 | 9,464 tokens |
| Last 80 pre-comment nodes | 11,181 | 6,070 tokens |

These five broad outputs are 79,452 bytes, 89.5% of the turn's inline text.
They repeat controls, profile links, wrappers and long URLs unrelated to the
requested extraction. Token increases also include generated code, envelopes
and other context changes, so they are not exact isolated output tokenizations.

The same retained observations eventually yielded a 3,932-byte story list and
5,086-byte paragraph extraction. These demonstrate useful smaller output without
recapture; a better extraction would also preserve entity/reply associations and
coverage rather than flattening everything to text.

Actual provider input grew **15,105 → 59,780 tokens** during the main turn
(+44,675). Cumulative input across its eleven calls was 384,550 tokens, including
339,780 cached input tokens; output was 2,788 tokens. Cached input still occupies
context. Cumulative input is not peak context or an uncached billing count.

Against [the earlier similar run](browser-repl-692-context.md): 17 → 10 cells,
72.71 → 53.03 seconds, 121,693 → 88,760 inline bytes (27% less), and main-turn
context growth 62,867 → 44,675 tokens (29% less). Live pages/destinations differed,
and the earlier request also involved editor interaction. This is directional
observational evidence, not a controlled savings or speed comparison.

## Implications

The output mechanism works, but this run does not establish efficient selective
usage: the agent treats expansion and artifact prefix reads as its default
recovery. Do not mark Phase 4's efficiency/coverage acceptance complete from this.

General follow-up, not site-specific filtering:

- Make local parsing/projection the first overflow recovery, retaining exact
  source URLs and entity boundaries. Expand only for already relevant content.
- Extract records (title/body/replies/coverage) instead of arbitrary node counts
  or character prefixes; verify missing boundaries and relative URL identity.
- Assess whether exposing easy expansion encourages broad emission despite the
  existing guidance. Do not silently remove relevant data to improve metrics.
- Keep historical thinning separate: it could reduce repeated context later,
  but does not correct broad initial extraction or association mistakes.

No new implementation or prompt changes made during this review.
