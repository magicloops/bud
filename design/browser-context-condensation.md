# Design options: Browser context condensation

Status: Proposed — options and recommended sequencing, not implementation approval

Follow-up direction: evaluate [persistent browser REPL access](browser-repl.md)
before implementing the sequencing below. Selective local extraction may reduce
the need for custom representation and replay transformations; these options
remain available after the REPL comparison is measured.

Date: 2026-09-23

## Objective

Keep browser context useful over long tasks by reducing repetition and retiring
obsolete interaction detail without losing evidence, exact destinations, or the
ability to act on the current page.

The durable transcript remains intact. Model input can be a smaller representation
of it. No site-specific ad filtering, query-string stripping, or automatic
deletion of past observations is proposed.

Related:

- [Transcript evidence review](../debug/browser-ce762991-context-thinning.md)
- [Run correctness review](../debug/browser-ce762991-run-review.md)
- [Existing context checkpoint design](context-compaction.md)
- [Runtime prompt/cache design](runtime-context-append-only-prompts.md)
- [Click targeting and exact URLs](browser-click-targeting-and-link-urls.md)
- [Agent spec](../service/src/agent/agent.spec.md)
- [Browser helper spec](../bud/browser-helper/browser-helper.spec.md)

The related designs contain historical proposals. Before implementation, inspect
the current loader, active tool loop, checkpoint and provider-ledger paths in full;
this document does not assume every older proposal describes today's code.

## Evidence driving the options

In thread `ce762991-33b7-4cf2-89cb-1a8e9d54cad4`:

| Finding | Implication |
| --- | --- |
| 146.5 KiB of feed observations remain after selecting and opening one post | Completed discovery can dominate subsequent reading context |
| A 32.3 KiB post snapshot is repeated with identical text and new observation IDs | Content freshness and action-reference freshness are separate concerns |
| Comment results total 55 KiB; comment paragraph lines total 4.2 KiB | Presentation/interaction structure can dwarf the reading material |
| 86.6 KiB repeats exact URL values within individual results | Lossless value sharing has value across sites and link types |
| The later feed snapshot omits the first five posts | Latest-snapshot-only retention breaks counting on virtualized pages |
| Two comment pages jointly support the answer | Latest-tool-result-only retention loses relevant evidence |
| Two stale continuation attempts | Old interaction metadata can actively mislead future steps |

These are serialized output byte counts, not token savings. Categories overlap;
do not sum their percentages. A smaller representation must be evaluated by
provider usage and task outcomes, not bytes alone.

## Required distinctions

1. **Observed content:** text, structure, exact links, source and capture time.
   It can remain useful after navigation or a new turn.
2. **Interaction state:** current document/observation identity, element handles,
   geometry and continuation validity. Historical evidence does not confer current
   permission or make an old handle actionable.
3. **Task state:** what the user requested, discoveries, completed actions,
   unresolved questions and evidence supporting conclusions.

These are conceptual distinctions, not a requirement for three new databases or
services. Prefer existing transcript, observation and checkpoint machinery.

## Options at a glance

| Approach | Main benefit | Main risk/cost | Position |
| --- | --- | --- | --- |
| Exact-value sharing within an output | Smaller new observations, lossless values | Reference indirection and format changes | First candidate |
| Conservative structural simplification | Less duplicated text/UI structure | Removing distinctions needed for actions | Pair with first candidate |
| Scoped observations / reading view | Less irrelevant material enters context | Missing surrounding context or controls | Next bounded experiment |
| Superseded-observation thinning | Stops carrying identical/obsolete bodies | Incorrect equivalence, cache invalidation | After replay rules are verified |
| Task checkpoints / evidence summaries | Retires completed exploration | Lossy summaries, inference cost and evidence loss | Reuse existing compaction |
| Archived observation recall | Makes omission reversible | Retrieval API, ownership, storage lifecycle | Only if thinning needs it |
| Cross-observation deltas | Avoids repeatedly emitting unchanged content | Baselines, missing patches, virtualized content | Defer initially |
| Smaller budgets / last-N retention | Simple size controls | More calls or silent evidence loss | Guardrails, not the main solution |

## A. Exact-value sharing within each result

Emit repeated long values once and refer to them locally. For example:

```text
values:
  u1 = "https://example.test/post?id=123&view=full#comments"
elements:
  link "Example post" [e12] url=@u1
  link "Comments" [e27] url=@u1
```

Both elements remain distinct. The URL stays exact. The key is a content alias,
not an element handle or authorization token. Key names and placement should be
deterministic within the result; do not make every short value indirect when its
dictionary entry would cost more than repetition.

The smallest variant expands the exact URL in the model's existing navigate
argument; it requires no new URL-lookup API. A later variant could accept a URL
reference for navigation, but that adds validation/lifetime semantics and should
be scoped separately. Existing click-by-element reference remains unchanged.

Each paginated output must include the values it uses. Depending on a dictionary
in an earlier, possibly omitted output defeats independent replay. Budget the
dictionary and body together and never truncate one without the other.

Long accessible names could also be shared, but URL sharing is easier to validate
first. This reduces initial output and repeated replay without rewriting history.
It does not prevent accumulation of genuinely different observations.

## B. Conservative structural simplification

Reduce representational duplication while preserving semantic relationships:

- Avoid repeating an accessible name verbatim as descendant text when the same
  information and actionable identity remain explicit.
- Collapse empty wrappers and repeated decorative labels.
- Represent author/time metadata once per content item rather than through each
  avatar, profile link and wrapper, in a reading-oriented representation.
- Keep document, article/comment and reply boundaries, order, headings, link
  destinations, and meaningful states such as disabled/selected/expanded.

Do not merge card links, title links and image links simply because their names
or URLs match. Do not flatten adjacent posts or nested replies into one paragraph.
Keep enough structure to tell who said what and which image belongs to which post.

Deterministic local transformations are preferable to an LLM rewriting every
snapshot. Ambiguous structures should retain detail rather than guess. This must
work on generic page semantics; no Reddit-specific selectors or ad taxonomy.

## C. Request less, with scoped observations or a reading view

Use the existing observation surface where possible to request a region or
subtree, or a compact outline before full detail. Possible use cases:

- Counting a feed: item boundaries, ordered titles, classification labels and
  destinations before requesting individual bodies.
- Reading a post: heading, body, relevant metadata and source.
- Summarizing comments: comment bodies, attribution, reply structure and coverage.

These are examples of intent, not proposals for site-specific tool modes. A
generic subtree scope and a clear reading-vs-interaction representation may be
enough; inspect existing capabilities before adding parameters or tools.

A reading view should say which regions/details were omitted and retain a path
to a fuller observation. Navigation and consent controls can matter unexpectedly.
For visual questions, keep optional screenshots; images should not silently
replace all text observations or be assumed cheaper in provider context.

This prevents unnecessary context from being produced. It can also reduce calls
by making relevant content fit in fewer pages. Measure the risk that an outline
introduces an extra read for every task or hides evidence needed for counting.

## D. Thin superseded observations in model replay

Preserve the original result in the transcript, but replace eligible historical
bodies with a concise record of their source, coverage and supersession. Keep
tool-call/result pairing and truthful outcome information.

Start with demonstrable equivalence, not a rule that every newer snapshot replaces
older ones. A7 and A8 in this run contain identical page text after reference-ID
normalization, but A8 has fresh actionable metadata. Historical IDs must not be
silently promoted into current handles.

Equivalence needs explicit source/document/scope and coverage checks. Do not
normalize away URLs, content changes, control state or meaningful structure.
Partial observations and pagination require comparing matching portions; a new
viewport is not proof that unseen old content ceased to matter.

At a later stage, stale geometry could be omitted while preserving historical
content. Failed clicks and uncertain side effects need their outcome retained:
shortening history must never turn “not sent” into “completed” or cause an unsafe
replay of an action.

Apply the same policy to fresh turn reconstruction and subsequent calls within
an active turn. Implementing only one path creates inconsistent behavior. Persist
or deterministically reconstruct the replay decision through existing checkpoint
facilities where possible; avoid another independent context-state store.

**Cache tradeoff:** changing earlier input can invalidate provider prompt caches
and local KV reuse. An append-only “ignore the old output” note does not remove
its tokens. Prefer stable replay between deliberate reduction boundaries and
measure whether reduced input offsets reconstruction/prefill cost. Do not assume
the lowest context size yields the lowest latency or cost.

## E. Task checkpoints that preserve evidence

Summarize completed exploration using the existing compaction/checkpoint system,
rather than add a browser-only summary engine. A useful checkpoint for this run
would retain:

- The user's tenth-non-ad constraint and ordered identities supporting the count.
- The exact selected URL, title and verified post body.
- The blocked-click/no-click-sent outcome and subsequent confirmed navigation.
- Relevant comments already read, their source/coverage, and work remaining.
- A distinction between remembered facts and references requiring a fresh read.

Turning a page or ending a user turn can be a candidate checkpoint boundary, but
neither proves older evidence is irrelevant. Cross-page comparison and counting
need accumulated evidence; the comment follow-up benefits from the prior turn's
reading. “Keep the final answer only” would lose both detail and provenance.

Model-assisted summaries can preserve task meaning but introduce latency, cost,
omissions and unsupported conclusions. An extractive approach preserves wording
but still needs a policy for selecting evidence. Either should preserve caveats,
source references and exact strings required for future actions, and avoid
promoting untrusted page instructions into service-authored guidance.

Prefer budget-triggered or substantial task-boundary reductions over summarizing
after each tool call. Compare with existing general compaction before introducing
new triggers. Repeated summaries can compound losses.

## F. Recall omitted observations on demand

Allow the agent to retrieve bounded historical evidence by a transcript or
observation identity when a summary is insufficient. The existing durable tool
result may be enough storage; a new artifact database, vector index and embedding
pipeline are not prerequisites.

Recall must return historical content as historical content. It must not revive
expired action references, fabricate current page state, or require navigating
back to a page that may have changed. Return source/time/coverage and bound the
retrieved size. A source pointer is useful only if retrieval actually exists.

Ownership is inherited from the thread/message, not merely the shared Bud profile.
Resolve the acting invocation owner; authorize the requested source against that
thread before reading. Any future viewer route must resolve its authenticated
viewer and authorize before reads/streams. New rows, if unavoidable, inherit
`created_by_user_id` and applicable `tenant_id`. No cross-thread global cache reads.

Only agent-authorized observations can enter this store/replay path. Private viewer
screenshots, private input and other viewer-only content remain outside model
context. Exact URLs may contain sensitive values; do not put raw dictionaries
into diagnostics or share them across users.

This makes stronger thinning reversible, but adds a tool contract and can cause
retrieval loops. Defer until experiments show what the existing transcript and
checkpoint paths cannot support adequately.

## G. Cross-observation deltas

Emit changed/added/removed content against a prior baseline. This can help repeated
reads of nearly static pages, but it requires stable content identity, reliable
baseline availability, handling pagination and virtualized removals, and a reset
when documents or authority change.

Model-visible patch chains can become harder to understand than a snapshot and
still accumulate tokens. A service-materialized current view avoids model patch
assembly but moves complexity into runtime state. Neither should be introduced
until simpler approaches are measured. A full-snapshot fallback and explicit
baseline dependency would be required; this is not a first implementation choice.

## Recommended sequence

1. **Measure a conservative format change:** local exact-URL sharing plus only
   unambiguous structural deduplication. Keep exact destinations and distinct
   targets, use existing budgets, and preserve full durable evidence.
2. **Evaluate observation scope:** exercise existing subtree/reading capabilities
   before expanding tools. Test whether less irrelevant material enters context
   without increasing navigation errors or call count.
3. **Evaluate replay thinning:** begin with verified identical old observations
   at stable reduction boundaries. Validate both in-turn and cross-turn replay,
   checkpoints, provider-native history and cache effects before shipping.
4. **Use existing checkpoints for completed exploration.** Add bounded historical
   recall only if preserving utility requires it. Defer generic delta protocols
   and elaborate relevance scoring until demonstrated necessary.

This sequence is a recommendation, not a commitment to implement every option.
Stop expanding scope when measured quality and context cost are acceptable.

## Evaluation and acceptance

Use the saved transcript for deterministic representation/retention comparisons;
use controlled browser fixtures and actual agent runs to test behavior. Replaying
recorded tool results alone cannot establish that a model would make the same
choices after its context changes.

Required scenarios:

- Virtualized feed counting with exclusions and repeated cards; preserve the
  first-five evidence when only later items remain mounted.
- Multi-page comments, a reply spanning pagination, and follow-up questions about
  previously read details; preserve attribution and coverage limitations.
- Distinct card/title/image controls sharing names or URLs; correct interaction
  targets and exact URL fallback after a blocked click.
- Changed page at the same URL, same text with new action handles, expired
  continuations, multiple tabs and service restart.
- Private takeover/return and attempts to recall another thread/user's evidence.
- Compaction, provider switching and supported native replay paths; no orphaned
  tool calls/results or reintroduction of removed bodies from a parallel ledger.

Record correctness, unsupported claims, repeat reads, stale-reference errors,
total tool/model calls, peak input tokens, cumulative input/output usage, cached
tokens, reduction overhead and end-to-end latency. Include any summary/retrieval
calls in cost. Report provider actuals where available and label estimates.

Historical provider token usage remains an accurate record of its old request;
it is not the size of a newly thinned request. Rebase the context estimator/meter
after a replay transformation instead of subtracting an assumed chars-to-token
ratio from an old actual. Re-anchor when new provider usage arrives.

Do not select an arbitrary savings percentage as proof of success. Approve a
bounded implementation only when it preserves the tested evidence/action
contracts and provides a measured improvement with acceptable overhead.

## Implementation boundaries and open decisions

Likely affected components are helper serialization/budgeting, browser tool
guidance/format contracts, service conversation reconstruction and active replay,
checkpoint integration, and context accounting. UI transcript/media behavior
should remain unchanged. No schema or protocol changes are authorized by this doc.

A scoped implementation must identify relevant specs, protocol changes and tests.
Helper changes require rebuilding/preparing the installed browser add-on and
restarting its runtime; service/tool guidance must upgrade in coordination. Use
one agreed format, not permanent legacy modes. Any new persistent schema requires
the repository's local push and checked-in migration workflow.

Decisions before implementation:

- Which low-risk format changes fit one small, independently measurable tranche?
- Can existing observation scoping meet the reading need without another mode?
- At which boundaries can replay change without excessive cache churn?
- What evidence does the existing compactor preserve, and when is recall needed?
- Can one canonical replay transformation cover all provider and restart paths?

Avoid a parallel browser memory subsystem, site-specific relevance rules, and
unbounded key tables. Those would replace excess context with excess lifecycle
complexity before the simpler options have been tested.
