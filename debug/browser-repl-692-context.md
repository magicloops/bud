# Review: browser REPL context in thread 69229029

Thread `69229029-4918-451e-a60b-b3b6c3fa5007`, reviewed 2026-09-23 using
owner-scoped local message, invocation and provider-call records. No browser
actions or runtime changes performed.

## Outcome and timing

The Phase 3 interaction API is now functioning: getByReference().fill() executed
successfully, without missing-method errors or editor-internals workarounds.
The selected destination is seventh in the explicitly numbered, depth-bounded
article extraction (unlike the previous run). The final editor read contains the
draft, and no submit action appears in the transcript.

Opening the subreddit took 9.23 seconds, three cells and four provider calls.
Selecting the seventh non-ad post, reading comments and filling a draft took
72.71 seconds, 17 cells and 18 provider calls. Recorded tool durations total
1.66 seconds for that second turn. Remaining elapsed time includes model/provider
and service overhead, not exclusively reasoning. Model: gpt-5.6-luna, high effort.

## Context growth

Provider-reported input rose from 14,008 to 76,875 tokens during the main turn,
a gain of 62,867. These are per-request context sizes, not summed token billing.
The 17 outputs emitted 121,693 bytes (~118.8 KiB) of inline text. Three broad
outputs account for ~78.6% of those bytes and precede ~72.7% of token growth:

| Output | Inline bytes | Next provider input increase |
| --- | ---: | ---: |
| First 220 broadly filtered feed nodes | 32,768 | 16,278 |
| First 260 broadly filtered post nodes | 32,768 | 14,132 |
| Entire visibleDom result | 30,090 | 15,312 |

Token deltas include surrounding generated code/tool envelopes and other request
changes; they are not exact standalone token counts for each output. Full local
artifacts for the first two outputs were 47,352 and 45,745 bytes; only 32 KiB of
each was inline. Artifacts were not read back in this run.

The agent subsequently extracted a useful 5,355-byte numbered post list from the
already-retained feed snapshot and 6,854 bytes of comment paragraphs from the
retained post snapshot. Those operations demonstrate that large model-visible
dumps were unnecessary for the eventual selective workflow. The comment query
slices from a Comments region to the end rather than respecting its subtree;
future guidance should retain boundaries and coverage rather than imply all
comments were read from a displayed comment count.

## Avoidable verification detour

The first fill succeeded at dispatch, but the observed editor later contained
no draft. The agent inferred that the collapsed composer was replaced by a rich
editor. That is plausible from the new reference and empty editor, not a proven
root cause from this transcript alone. A fresh-reference fill eventually worked.

In between:
- visibleDom() was incorrectly treated as an array (`vd.filter`); it returns an
  object with nodes. Instead of using vd.nodes, the next cell printed all of vd.
- visibleDom refreshed observations, then an older snapshot reference was used
  for fill and correctly rejected as browser_stale_reference.
- A broad all-input verification emitted unrelated hidden/application field
  values (~3.6 KiB); verification should target the intended editor only.
- Nearby-node output included long unrelated link URLs (~8 KiB).

## Recommended follow-up

Phase 4 should prioritize general API usage and selective-output guidance:
retain observations locally; print purpose-specific, bounded fields; document
nodes-bearing observation return shapes; target verification narrowly; reacquire
handles after observations; verify actual editor contents after dynamic updates.
Do not remove site-specific ad URLs or reduce capture coverage as a workaround.
Assess history thinning after preventing unnecessary emission: otherwise the
same avoidable data still consumes each immediate model decision.

No code changes in this review. Related: [previous run](browser-repl-15ed-review.md).
