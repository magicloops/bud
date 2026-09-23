# Review: Context thinning opportunities in ce762991

Reviewed 2026-09-23. Thread `ce762991-33b7-4cf2-89cb-1a8e9d54cad4`.
Companion to the [run review](browser-ce762991-run-review.md).

## Scope and evidence

This is a transcript evidence review, not an implementation design. No domain
blocklist, ad removal rule, context mutation, or browser interaction was applied.
The source is the 36-message export captured during the preceding owner-scoped
local database review. Message indexes below are zero-based export indexes.
The three requests were: open Reddit; find and inspect the tenth non-ad post;
summarize its comments.

Sizes are UTF-8 bytes of serialized tool-result content, converted to KiB using
1,024 bytes. They are not tokenizer measurements or exact provider request sizes.
The prior review measured provider input increasing from 13,202 to 130,083 tokens;
we cannot attribute that whole increase to any single class of transcript bytes.
No model replay was run to validate a reduced context or estimate token savings.

## Where the observation volume went

| Evidence group | Messages | Size | Share of content-observation output |
| --- | --- | ---: | ---: |
| Feed discovery: initial snapshot, four viewport reads, two fresh snapshot pages | 6, 9, 12, 15, 18, 20, 21 | 146.5 KiB | 62.7% |
| First post-page snapshot | 25 | 32.3 KiB | 13.8% |
| Fresh post/comments snapshot and continuation on the follow-up | 32, 33 | 55.0 KiB | 23.5% |
| Total | Ten results | 233.8 KiB | 100% |

The other ten browser tool results together occupy only 4.9 KiB. They include
open/page-info, scroll acknowledgements, navigation and rejected operations.
Removing small receipts would have much less effect than thinning observation
bodies. Some receipts also carry essential outcome information.

## Evidence lifecycle through the run

### 1. Open Reddit (messages 0–3)

Open and page-info establish the tab and homepage. Their combined size is about
1.1 KiB. The useful continuing facts are browser/target identity, observed URL,
and successful page identification. This is not the main volume problem.

### 2. Count the feed (messages 4–21)

The initial document snapshot A1 contains the first five regular posts. The agent
explicitly records that count in message 7. Four scroll/visible-DOM pairs follow:

| Viewport observation | Scroll Y | Content relevant to counting |
| --- | ---: | --- |
| A2 / message 9 | 559 | Previously seen second post and first ad |
| A3 / message 12 | 1,559 | Previously seen posts three, four and five |
| A4 / message 15 | 2,651 | Second ad and new sixth post, “Random Contributors?” |
| A5 / message 18 | 3,651 | New seventh Apple post and eighth “Well this is scary” post |

These four reads occupy 50.1 KiB. They provide viewport progress and fresh handles,
but the first two introduce no new regular post identities. A4 and A5 do introduce
new identities, so these reads are not all interchangeable or safely deletable
while counting remains unresolved. All repeat the fixed header and controls.

After a stale continuation rejection, A6's two document pages provide posts six
through ten and beyond. The tenth post appears near the start of the second page
(message 21); most of the rest is later posts, their bodies and controls, plus
another sponsored block. That later material contributes no evidence to selecting
or describing the tenth post in this run.

Once A6 is available, the four viewport bodies have little remaining value for
this task: their newly discovered post identities are represented there. Their
old coordinates and handles are no longer useful for subsequent interaction.
However, A6 no longer includes the first five posts because of virtualization.
Replacing all prior observations with A6 alone would lose the basis for the
ordinal count. What must survive is the ordered identity/count evidence, the
excluded-card classification, and any uncertainty about continuity of the feed.
The feed is a changing observation, not an immutable global ranking.

### 3. Open and confirm the selected post (messages 22–27)

The agent identifies the title, tries its heading link, receives
`browser_click_blocked`, navigates to its exact observed URL, and confirms the
post body in a new document snapshot A7.

During recovery, preserve the exact destination and the fact that the click was
**not sent**. A successful navigation request alone is not proof of arrival;
A7 supplies that proof. Distinct heading/card/image controls must not be treated
as the same action merely because they share text or a destination.

After confirmation, feed geometry, unrelated post bodies, expired handles and
most feed UI details no longer contribute to this task. The continuing evidence
is the selection/count provenance, exact selected URL, title/community, verified
post body and displayed metadata. Message 27 already carries much of the result,
but its prose alone is not a complete substitute for the counting provenance.

### 4. Follow-up: summarize comments (messages 28–35)

At this boundary, retaining all 146.5 KiB of feed observations contributes little
to the new request. Conversely, A7 already contains comment evidence the user now
needs: indiscriminately dropping all previous-turn observations would discard
useful material and potentially cause more reads.

The agent tries A7's stale continuation, then obtains A8. **A8's first-page text
is identical to A7's after substituting the observation-ID prefix.** The two
serialized results are each 33,047 bytes. The newer result provides fresh
interaction/continuation metadata, not new substantive page text. Once it exists,
the older body is a particularly strong thinning candidate.

A8's second page is genuinely new comment evidence. It must remain associated
with page one: keeping only the most recent tool result would lose the earlier
comments. The continuation repeats the ancestor/comment header at the page break,
which is structural context rather than an additional comment.

At the final answer, 178.8 KiB (76.5%) of the accumulated observation bytes belong
to the completed feed-discovery work or the superseded A7 snapshot. This is the
size of candidate bodies, **not a claim that 76.5% of tokens can be safely removed**:
selection provenance and relevant facts still need representation. This also
does not imply that all those bodies were unnecessary when originally received.

## Redundancy inside observations

These measurements describe overlapping opportunities; do not add them to the
lifecycle figures above or to one another as independent savings.

- **Exact repeated URL values, across all domains:** 368 occurrences contain 140
  distinct strings. Of 115,063 URL-value bytes, 88,693 (86.6 KiB) repeat a string
  already present within the same result. Across the whole set of observations,
  repeated occurrences account for 98,237 bytes. This counts exact equality,
  preserves query strings/fragments, and does not conflate relative and absolute
  forms. It excludes replacement-reference overhead and serialization syntax;
  these are redundancy measurements, not a proposed encoding's net savings.
- **Accessible names repeat descendant text.** The long Luna post body appears
  as a link name and again in child paragraphs in A1/A3. The same pattern occurs
  for “Random Contributors?” in A4/A6 and several later posts. Titles recur as
  card-link names, heading-link names and image labels. Text repetition is real,
  but the underlying interaction targets are not necessarily duplicates.
- **Repeated navigation and controls:** search, inbox, avatar, voting, sharing,
  video settings and recommendation sections recur. They are useful for some
  tasks but mostly unrelated to this run's selection and reading tasks.
- **Old geometry:** the four viewport results carry approximately 11.6 KiB of
  bounding-box fields, measured using compact JSON for each box plus its field
  key. These are historical coordinates after scrolling, not lasting evidence
  about post meaning. This is a subset of the 50.1 KiB viewport-read total.
- **Comment structure outweighs comment text:** A8's two results occupy 55 KiB,
  but the 30 paragraph lines under comment articles total 4,257 bytes (4.2 KiB,
  including indentation/role labels). There are 26 distinct comment article
  references; 27 header occurrences include one repeated at the page boundary.
  Author/profile/avatar/time/link wrappers, page controls, other page material
  and repeated destinations make up most of the remaining volume. This does
  not mean paragraphs alone are a sufficient representation: authorship,
  comment boundaries, links, reply relationships and coverage still matter.

The page displays a count of 27 comments, while these results contain 26 distinct
comment articles. A final continuation of null establishes the end of the
available snapshot, not proof that every server-side comment was exposed.
Any thinning should preserve that coverage limitation rather than promote the
result into a claim of exhaustive reading.

## Information that must survive thinning

| Stage | Evidence still needed | Detail with declining value |
| --- | --- | --- |
| Counting | Ordered post identities, exclusions, progress/coverage, current actionable references | Superseded viewport geometry, repeated shell UI, unrelated bodies |
| Blocked click recovery | Exact observed destination, blocked/no-click-sent outcome, current target | Old feed controls not involved in recovery |
| Confirmed post | Selected identity and count provenance, URL, body, observed metadata | Most completed feed-discovery bodies |
| Reading comments | Both snapshot pages' comment evidence, boundaries/relationships, source and coverage | Superseded identical A7 body, expired interaction handles |
| After summary | User request, answer, source identity, caveats and supporting evidence available for follow-up | Full navigation/scroll history as continuously repeated model input |

Historical content and actionable references have different lifetimes. A stale
handle does not make its observed text worthless; a still-useful quote does not
make its old click reference valid. The failed continuations in this run show why
keeping those two concepts distinguishable matters for correctness as well as size.

## Conclusions to carry into a later design

The strongest evidence is for thinning completed navigation history, superseded
identical observations, and repeated presentation details while retaining task
evidence. No ad-specific rule is required to identify any of those categories.

This review does not choose a key/value representation, summarizer, retention
window, snapshot transform or retrieval mechanism. A design still needs to decide
how retained evidence is identified without hindsight, how omitted details remain
recoverable, and how tool-call/result pairing and provider context behavior are
preserved. The durable transcript should remain available for audit; reducing
what is replayed to the model is a separate concern from deleting history.
