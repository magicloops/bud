# Review: browser REPL run 48e11445

Reviewed 2026-09-23 Pacific (run timestamps September 24 UTC).
Thread `48e11445-1b07-4552-ab93-d00d27e6d497`.
Read-only local thread inspection; messages/invocations scoped to the thread owner,
provider records checked against the same owner. Private evidence:
`/tmp/bud-repl-48e-review.json` (0600). No browser actions or runtime changes.

## Outcome

Both invocations succeeded on gpt-5.6-luna/high. Opening the community took
9.08 seconds, two browser cells and three provider calls. The main request asked
for the seventh non-ad post, a comment summary and a devil's-advocate draft from
a LeetCode beginner's perspective. It completed in 99.27 seconds, using 25 browser
cells and 26 provider calls. No comment was posted.

The agent counted three pinned announcements plus four ordinary feed posts and
explicitly disclosed that interpretation in the final answer. The selected
South Korean YouTube post matches that ordering in the emitted links. This is
not the seventh ordinary feed post. The user did not specify treatment of pinned
announcements. Ad exclusion was inferred from inspected links/structure rather
than demonstrated by an explicit entity-level classification/count. Deduplication
by literal URL left relative and absolute links to the same post as separate
entries; final counting was done by the model, not verified in code.

The final summary matches the five bodies returned by the JSON endpoint, including
the nested author reply. Five extracted comments match the returned num_comments=5
for this observation. The answer attributes broad AI claims to commenters, and the
draft supplies a counterargument rather than submitting it. No screenshot or
private-control interruption appears. One runtime generation survives throughout.

## Main-task measurements

Comparison is observational with [4462398b](browser-repl-446-review.md), not a
controlled experiment: different posts, comment volumes and page states.

| Metric | 4462398b | 48e11445 |
| --- | ---: | ---: |
| Work duration | 84.39 s | 99.27 s |
| Browser cells | 17 | 25 |
| Provider calls | 18 | 26 |
| Inline tool text bytes | 43,262 | 37,949 |
| Output-omitted cells | 8 | 5 |
| Recorded tool duration total | 1.17 s | 6.29 s |
| First → final provider input | 13,969 → 34,242 | 13,998 → 39,059 |
| Context growth | 20,273 | 25,061 |
| Cumulative actual input | 397,690 | 686,642 |
| Cached input, included above | 377,297 | 661,437 |
| Uncached input | 20,393 | 25,205 |
| Output tokens | 3,696 | 4,629 |

Inline text fell 12%, but context growth rose 24% and cumulative input rose 73%.
More tool calls/code/envelopes and repeated processing matter even when individual
outputs are smaller. Cached input still occupies context; this is not a pricing
calculation. Tool time includes explicit waits; remaining wall time includes
model generation, service orchestration and transport, not model compute alone.

## What happened (cell numbers include the two opening cells)

- Cells 3–10 discover feed items and scroll twice to load more. Initial DOM read
  sees three ordinary articles; a later snapshot includes many more links.
  This indicates dynamic loading, not an 8 KiB snapshot capture limit.
  Cells 3 and 9 overflow, followed by successful local selection from retained
  snapshots. Cell 10 emits 7,278 bytes of links, far more than the chosen item needs,
  including repeated destinations in relative and absolute forms.
- Cell 11 navigates then snapshots; snapshot rejects with browser_document_changed.
  Cell 12 correctly checks the current page and observes again without replaying
  navigation. The runtime/memory remain intact.
- Cells 13–23 investigate comment text through repeated snapshot/DOM projections.
  These eleven cells emit 17,515 bytes. Cell 16 already shows DETAILS elements
  without open attributes. Cell 22 explicitly reports three top-level sections
  open:false and a nested reply open:true under a closed ancestor. Four of five
  body reads return empty; the open visible comment returns its body.
  No cell attempts a disclosure click or other expansion. The pattern strongly
  supports collapsed-content visibility as the immediate issue, but we did not
  replay the live page or prove every missing body would appear after expansion.
- Cells 17–19 generate oversized HTML/descendant-text observations (21,080,
  19,209 and 17,729 captured bytes). These are additional page reads rather than
  filtering the retained dhtml/dsummary values. Generic textContent extraction
  also emits repeated script source. These are agent-selected observations, not
  automatic whole-page delivery by the tool.
- Cells 24–26 create a temporary tab at the post's .json?raw_json=1 endpoint,
  retain 17,525 characters locally, then emit a 3,114-byte projection containing
  the post and five comment bodies. This succeeds. The preliminary 300-character
  JSON preview unnecessarily emits an internal modhash field; avoid reproducing
  it in review docs. Final projected data does not need that field.
- Cell 27 closes the temporary tab. Final answer follows. No click was attempted,
  so this run provides no new click/actionability acceptance evidence.

## Interpretation and next investigation

The browser execution path largely worked: persistent memory, selective emission,
whole-output overflow, exact navigation, document-change rejection and tab cleanup.
The failure to inspect some comments was not evidence that Bud needs a larger
snapshot budget or raw CDP. Snapshot and DOM innerText both lacked the same bodies,
while the observed disclosure state explains why content could be unavailable to
those reads. A larger output limit would expose more diagnostic HTML, but would
not itself expand a collapsed section. All five overflow captures were above
17 KiB; a roughly 12 KiB budget would not admit those complete emissions either.

The general gap is recognizing and acting on disclosure/loading state before
repeated extraction. Our prior fidelity spike also found that Playwright did not
report expanded state for one native details fixture. That makes a focused check
of native details/summary discovery and usable action references worthwhile;
this transcript alone does not prove a helper omission, since the agent projected
away much of its snapshots. Do not add a site-specific comment extractor or
conclude raw CDP is required.

Keep separate:

1. A deterministic collapsed-details fixture: what does the full snapshot expose,
   can the agent locate/expand the control, and does a fresh snapshot reveal text?
2. Agent extraction choices: retain relevant evidence, filter before emitting,
   and change strategy when repeated reads yield no new evidence.
3. Ordinal-task identity: distinguish pinned groups from ordinary records and
   resolve relative URLs for comparison without stripping query/fragment data.

Phase 6 prompt candidates were reverted; do not credit this run to those rejected
changes. No implementation or prompting changes were made during this review.
