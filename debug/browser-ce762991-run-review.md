# Review: Reddit run ce762991

Reviewed 2026-09-23. Thread `ce762991-33b7-4cf2-89cb-1a8e9d54cad4`,
07:41:03–07:42:38 UTC. Owner-scoped local transcript, provider usage ledger and
invocation action receipts; no page interactions or runtime changes performed.

Related: [click design](../design/browser-click-targeting-and-link-urls.md),
[previous interception investigation](browser-patchy-click-interception.md).

Follow-up: [context thinning evidence review](browser-ce762991-context-thinning.md)
examines the useful lifetime of observations and general repetition without
selecting an implementation or removing ad URLs.

## Outcome

The requested tenth non-ad post was reached and its comments summarized. The
recorded sequence supports the count: five regular posts in the initial snapshot,
then Random Contributors, the Apple hardware interview, Well this is scary, the
handwriting submission, and the AIDiscussion post. Feed virtualization removed
older entries from later snapshots, so this is reconstruction across observations,
not proof from one frozen full-feed snapshot.

The resulting post document explicitly contains the selected title, body, displayed
score 14 and comment count 27. The final comment themes are supported by the two
comment snapshot pages. No adjacent image/post conflation or unrelated web-search
fallback was found. The score is a displayed score, not necessarily 14 total votes.

Twenty browser tool calls: seventeen completed, two stale-reference rejections,
and one blocked-click rejection. No unknown-outcome result or handoff/reopen loop
appears in the transcript. All twenty durable action receipts completed.

## Findings

### 1. Full repeated ad URLs consume substantial context

Ten successful content observations total 239,388 serialized tool-result bytes
(233.8 KiB). Embedded URL values alone account for 115,063 bytes; 98,204 bytes
(95.9 KiB, about 41% of all observation-result bytes) are alb.reddit.com ad URLs.
These totals include repeated observations and repeated links within a page.
Individual ad destinations are roughly 1.0–1.4 KiB and recur on multiple controls.
URL-value byte counts exclude the additional serialization syntax/escaping.

Provider-reported input grows from 13,202 tokens at the start of the post-finding
turn to 101,285 at its final response, then 130,083 at the comment-summary response.
These are per-request accumulated input counts, not summed billing or a claim that
all growth comes from URLs. Many subsequent requests benefit from caching, but
cached content still occupies context. The 32/36 KiB per-result budgets held.

Preserved URLs enabled recovery and should remain exact. A follow-up should
consider emitting identical long destinations once per observation/page, with an
unambiguous reference from each distinct link, or another explicit bounded URL
representation. Do not strip query strings, merge interactive identities, or add
Reddit-only selectors. This review identifies a concrete cost that the short-URL
news fixtures understated; no representation change is made here.

### 2. Two stale continuations caused avoidable work

At 07:41:54, the agent requested `V7-n6xxGzvA1:244` after four visible_dom reads
had replaced snapshot A1 with A5. Rejection is correct. It should have consumed
the document continuation before replacing it, then scrolled only if more feed
content needed loading. All four scroll gestures did move the viewport; there
was no stuck-scroll retry loop.

At 07:42:25, the follow-up turn tried `V7-n6xxGzvA7:184`, about sixteen seconds
after capture, and received another stale-reference result. This was within the
60-second TTL; new invocation epochs invalidate references in the daemon. The
current code explains that boundary, although raw daemon logs for the run were
not captured here to rule out other invalidation triggers. The next full snapshot
has the same document and identical text after normalizing observation IDs.
It repeated a 33,047-byte result before continuing successfully.

Improve stale-reference recovery guidance and make the new-turn reference boundary
explicit. Do not weaken authority fences or silently replay stale actions merely
to avoid these rejected reads. Scoping a fresh observation to the comment region
when a current reference is available can also reduce unrelated content.

### 3. Recovery worked; the click itself did not succeed

At 07:42:03 the agent clicked heading-link reference `V7-n6xxGzvA6:e1465`.
Request `01M36KDTS5A9SK4S1FQ2VCP0VW` returned `browser_click_blocked` with a clear
no-click-sent explanation. The transcript includes a separate full-card reference
`e1430` to the same destination, but the helper correctly did not substitute it.
The agent navigated once to the exact observed HTTPS URL at 07:42:06, then obtained
a snapshot confirming the post document/body at 07:42:09.

This validates canonical blocking, preserved URLs and deliberate recovery. It is
not acceptance evidence that randomized exposed-point clicking succeeded: the
run contains only that one click attempt. No raw diagnostic was available to
establish its precise geometric blocker; same-card layering is a hypothesis,
consistent with the earlier reproduction.

## Limits and next priorities

1. Address repeated destination/context cost without losing exact URL evidence.
2. Clarify continuation lifetime across new observations and new turns.
3. Separately validate a successful exposed full-card click with the real agent.

The current service and daemon write to terminal/pipe descriptors; the available
service log file did not contain this thread. Consequently the saved transcript
cannot establish absence of transient viewer disconnects or show candidate-point
counts. No screenshots were requested in this run, so visual correctness is not
independently verified. No production code changed during this review.
