# Browser observation budget: 32 KiB decision

Status: selected default — 32 KiB observations / 36 KiB tool envelopes after Phase 3i
structure compaction. The comparison below records the earlier serializer at
32 versus 8 KiB. Post-Phase-3i results are recorded below. Load the larger service
guard before restarting the daemon/helper; an older 12 KiB service guard will
reject larger observations explicitly. No schema or request-shape changes.

The previous 8 KiB compact page budget can split useful article content across
many calls. Compact serialization reduces duplication; a smaller page limit alone
does not reduce the cost of reading the complete content.

Raise the helper's serialized observation budget to 32 KiB and the service's
complete tool-envelope guard to 36 KiB (same 4 KiB allowance). Applies to compact
snapshot and visible-DOM output. Keep node-boundary pagination, explicit oversized
node errors, reference fences, retained-memory limits and legacy serialization.
Screenshots and private viewer media are unaffected.

Deploy the service guard first, then restart the helper/daemon. Old helpers work
with the larger guard; a new helper with the old service may receive explicit
browser_observation_limit for results exceeding the old guard. No schema change.

Validate Unicode/envelope bounds, advancing continuations, acceptance of content
above the old limit, and rejection above the new limit. Compare calls, task-wide
tokens, latency and reading coverage in subsequent actual-agent runs. Previous
Phase 3f benchmark numbers describe the earlier budget, not this trial.


## Actual-agent comparison — 2026-09-16

Source: owner-scoped local database reads of messages, llm_call usage and
agent_invocation timing. Threads:
- 32 KiB: `c46968cb-3897-4efc-abbc-223eb98b8a19`
- 8 KiB: `0dfa159e-cf14-47a7-928e-c28a1a9defa1`

Both used GPT-5.6 Luna, the identical prompt to read the first three HN links and
write a haiku, and the same initial 12,538 input tokens. Both visited the Postgres
query-planning article, MiMo live RL dashboard, and ternary-LLM paper (abstract
and HTML). HN reordered the latter two between runs, so visit order differs.

| Measurement | 32 KiB | 8 KiB |
| --- | ---: | ---: |
| Service work duration | 49.072 s | 51.474 s |
| Model calls | 15 | 15 |
| Browser calls | 14 | 14 |
| Snapshots | 7 | 7 |
| Continuation calls | 0 | 0 |
| Truncated snapshots | 2 | 6 |
| Failed browser calls | 0 | 0 |
| Serialized observation bytes, total | 166,968 | 55,826 |
| Complete browser tool-result bytes, total | 172,949 | 61,838 |
| Peak model input tokens | 82,367 | 38,166 |
| Cumulative model input tokens | 689,144 | 370,371 |
| Cached input tokens | 606,735 | 344,698 |
| Uncached input tokens | 82,409 | 25,673 |
| Output tokens | 1,849 | 1,786 |
| Reasoning tokens (subset of output) | 736 | 655 |

Observation bytes measure compact UTF-8 JSON including observation metadata;
tool-result bytes measure stored tool content. Cumulative input counts repeat
history across model calls; it is not unique context. Provider usage supplies
token counts, not a tokenizer estimate. Cache warmth differed (first request:
0 cached tokens vs 12,535), so uncached totals are not a controlled cost comparison.

The smaller budget reduced observation bytes by 66.6%, peak context by 53.7%,
and cumulative input by 46.3%, with no extra calls. Duration was 2.4 seconds
longer; a single pair cannot establish a latency difference.

Coverage caveat: neither run read every available continuation. At 32 KiB, the
Postgres article and paper HTML were still truncated. At 8 KiB, those plus the
MiMo dashboard and all three HN snapshots were truncated. The 8 KiB Postgres
snapshot stopped in the introductory outline; the larger one reached the
“A model and its harness” heading. Both final answers identified the three
subjects and produced a haiku, but this does not demonstrate equivalent detailed
reading or factual accuracy. There were no web_read/web_search fallbacks.

Initial recommendation (superseded by the post-Phase-3i decision below): retain 8 KiB. This task gained no call-count
benefit from 32 KiB and paid substantially more context for it. Preserve explicit
continuations for deeper reading; evaluate a full-reading task separately before
claiming a general cost or quality advantage. No code changed for this comparison.


## Post-Phase-3i comparison: stories 1, 17 and 28

Owner-scoped local reads, 2026-09-16:
- 8 KiB: `2c9e1062-d6a7-4d49-95a7-be3b5738afc8`
- 32 KiB: `b8c65595-6b7d-40c1-be6f-bbb60beec897`

Both used the same prompt, GPT-5.6 Luna and 12,542 initial input tokens. Both
snapshots show Phase-3i compact annotations/indentation. The first story remained
the Postgres article. The 8 KiB run's other pages were “Anecdotally, programmers
dislike reduce” and GitHub jevlike; the 32 KiB run's were the e-ink bird frame's
GitHub repository and FailPop startup generator. This is a browsing-pattern
comparison, not a controlled article-content or latency benchmark.

| Measurement | 8 KiB | 32 KiB |
| --- | ---: | ---: |
| Service work duration | 53.710 s | 33.069 s |
| Model calls | 16 | 13 |
| Browser calls | 15 | 12 |
| Observation calls | 9 | 6 |
| HN continuation calls | 3 | 0 |
| Article continuation calls | 0 | 0 |
| Failed browser calls | 0 | 0 |
| Observation bytes | 68,332 | 114,187 |
| Complete tool-result bytes | 74,838 | 119,571 |
| Peak input tokens | 44,787 | 61,105 |
| Cumulative input tokens | 453,554 | 481,214 |
| Cached input tokens | 421,231 | 432,612 |
| Uncached input tokens | 32,323 | 48,602 |
| Output tokens | 2,143 | 1,488 |
| Reasoning tokens (subset of output) | 874 | 467 |

At 8 KiB, each HN visit needed a second observation to reach the requested later
ranks. At 32 KiB, all 30 stories fit in each HN observation. The larger budget
therefore eliminated three browser/model round trips. It used 67.1% more observation
bytes and 36.4% more peak context, but only 6.1% more cumulative input tokens.
Elapsed active work was 20.641 seconds shorter (38.4%); provider variation and
changed stories prevent assigning that entire difference to pagination.

Coverage: both Postgres captures were truncated and neither was continued. The
larger run's other two page snapshots were complete; the smaller run captured the
reduce essay completely but truncated jevlike. Complete snapshot means returned
accessible DOM, not proof of full article comprehension. The larger run's claim
that it was reading the “full linked pages” is not supported for Postgres.

Interpretation: unlike the earlier top-three-only task, this task demonstrates a
concrete pagination benefit from 32 KiB. Keeping 32 KiB for the current trial is
reasonable: fewer calls for broad page navigation, traded against larger retained
context. It does not establish 32 KiB as universally cheaper or better. No runtime
settings changed during this review.


## Decision

Keep 32 KiB as the default, confirmed by the user on 2026-09-16. Retain the 36 KiB
service envelope guard, Phase-3i compaction and explicit continuation behavior.
The later-rank task demonstrated fewer browser/model round trips with a modest
cumulative-input increase, accepting the larger peak context. Earlier 8 KiB
measurements remain historical evidence, not the current configuration. No new
flag or budget mode is introduced. The code and budget tests already use 32/36 KiB.
