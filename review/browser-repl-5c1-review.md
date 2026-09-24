# Browser REPL review: same-post 16 KiB rerun

Thread: `5c1dc437-1c0f-44a0-8e0a-75ce5a4e8e44`
Reviewed: 2026-09-24
Comparators: [588, 8 KiB](./browser-repl-588-review.md) and
[1af, 16 KiB on a different post](./browser-repl-1af-review.md).

## Conclusion

This run used less context and finished faster than 588 while reading the same
post and all four captured comments. A single 12,454-byte post snapshot fitted
within the 16 KiB envelope, avoiding a separate comment-extraction call.

This is not a controlled budget comparison: the new request named the post,
whereas 588 required finding the seventh feed entry while skipping ads. Reduced
discovery work explains part of the improvement. The larger budget permitted
more post text, rather than making the representation smaller.

Keep 16 KiB for the current experiment. No runtime or budget changes were made
for this review. A same-prompt 8 KiB rerun would isolate the budget tradeoff.

## Evidence and method

Reviewed all 13 persisted messages, eight provider calls, two invocations and
six browser cells, together with all six local observation traces. Each trace's
daemon result matched its persisted tool result. All six traces recorded a
16,384-byte text limit. No trace stages were omitted or source-truncated.

Private local evidence: `/tmp/bud-repl-5c1-review.json` and
`/tmp/bud-repl-5c1-traces/`. These exports are not checked in. Usage below is
provider-reported; inline sizes measure returned text bytes, not token estimates.
Model: `gpt-5.6-luna`, high reasoning.

## All browser calls

| Cell | Operation and result | Time | Returned bytes |
|---|---|---:|---:|
| 1 | List tabs; empty list | 276 ms | 3 |
| 2 | Create/select Anthropic subreddit tab; return tab info | 244 ms | 162 |
| 3 | Wait 1.2 s, snapshot, format with 4,000-byte ceiling; 71/240 nodes printed | 1,339 ms | 3,886 |
| 4 | Search retained snapshot nodes for the named post; empty match list | 28 ms | 3 |
| 5 | Navigate to subreddit search, wait 1.2 s, snapshot with 7,000-byte ceiling; 106/173 nodes printed | 1,439 ms | 6,991 |
| 6 | Navigate to observed post URL, wait 1.5 s, snapshot with 14,000-byte ceiling; all 188 nodes printed | 1,789 ms | 12,454 |

Cells 1–3 answered “Let's go to the anthropic subreddit.” Cells 4–6 answered
the request to find “never gonna give you up,” summarize comments and draft a
devil's-advocate response from a LeetCode beginner's perspective.

Cell 4 searched the full retained 240-node object, not just the previously
printed 4 KB preview. It was approximately 70 seconds old. An empty result
established absence from that captured set only; the agent then searched the
site rather than treating it as proof the post did not exist.

Cell 5 exposed the exact title and permalink as its first result. Cell 6 used
that observed URL: `/r/Anthropic/comments/1woxxse/never_gonna_give_you_up/`.
The search preview also included unrelated results.

All cells succeeded. Two intentionally bounded snapshot previews occurred;
there was no collector overflow, artifact recovery, screenshot, click, scroll,
DOM evaluation or explicit output-envelope override. The worker persisted
between turns.

## Main-task comparison

Opening the subreddit is excluded from this table; it is present in both
threads' retained context. Different opening histories affect starting input.

| Metric | 588: 8 KiB | 5c1: 16 KiB |
|---|---:|---:|
| Recorded work duration | 37.601 s | 19.748 s |
| Browser REPL cells | 6 | 3 |
| Provider calls | 7 | 4 |
| Total browser-cell duration | 0.915 s | 3.256 s |
| Inline tool-output bytes | 32,453 | 19,448 |
| First provider input tokens | 13,717 | 15,489 |
| Final provider input tokens | 27,475 | 23,223 |
| Input growth within task | 13,758 | 7,734 |
| Cumulative provider input tokens | 151,110 | 73,176 |
| Cached input tokens | 137,251 | 65,368 |
| Provider output tokens | 1,881 | 1,144 |
| Captured comments read | 4 | 4 |
| Collector overflows | 1 | 0 |

Final input fell 15.5%, input growth 43.8%, inline output 40.1%, and work time
47.5%. Cumulative input is the sum across provider calls, including replayed
history; it is not simultaneous context-window occupancy. The latest main-task
input sequence was 15,489 → 15,909 → 18,555 → 23,223.

Browser-cell time increased because the new cells explicitly slept for a
combined 2.7 seconds. Fewer model/tool rounds nevertheless shortened the task.
Across both turns, the new thread used six cells, eight provider calls, 23,499
inline bytes, 129,306 cumulative input tokens and 1,392 output tokens.

## What the extra budget bought

The post snapshot's comment region began at byte offset 8,428: beyond an 8 KiB
prefix. At 16 KiB, the full 12,454-byte captured representation included the
post, all four comments and footer without another round.

In 588, post reading used three cells: navigation/info (237 bytes), a bounded
snapshot (7,638), and targeted comment extraction (657), totaling 8,532 bytes.
The new combined navigation/snapshot cell returned 12,454 bytes: approximately
46% more post-reading text, but fewer round trips. Overall output fell because
discovery was shorter. This is the actual tradeoff, not evidence that increasing
the envelope intrinsically reduces context.

Unlike 1af's much larger discussion and repeated broad outputs, this post's
complete captured snapshot comfortably fitted. Neither comparison establishes
a universal optimal ceiling.

## Content and correctness

Both same-post runs captured four comments: a joke about saying “please” and
“thank you” to future machines, a request for the prompt, “age of algo people,”
and a question about how the content was created. The new snapshot retained
all four bodies. Post score, relative times and advertising differed between
captures; the current ad was Otter rather than Meshy.

The final answer linked the correct post, summarized those comments and supplied
an unsent skeptical draft. One presentation issue remains: its “Comment summary”
also included two bullets describing the post itself, mixing post context with
reader responses. There was no image/video inspection, so this run does not
validate visual understanding or the post's claims about model capability.

## Remaining opportunities

- Prefer scoped output once a useful target is known; a generous ceiling need
  not become the desired output size. Search results and post chrome still add
  text that did not contribute to the answer.
- Retained observations can support cheap discovery, but absence from an older
  captured set must not imply absence from the live site.
- Separate post context from comment summaries in the answer. This is an
  attribution issue, not a reason for site-specific extraction machinery.
- For the budget decision, compare identical named-post prompts and report
  both final input and round-trip count. Preserve coverage checks alongside
  byte/token measurements.
