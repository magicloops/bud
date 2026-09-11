# Web and mobile streaming reconciliation

Status: review for discussion; no implementation authorized by this document.
Reviewed September 9, 2026. Main baseline `e7fdbec`; mobile baseline `d653710`.
Both reviews use fresh `review/streaming-behavior` branches from fetched `origin/main`.

Detailed reviews: [web](web-streaming-behavior.md); mobile repo
`review/mobile-streaming-behavior.md` (local worktree: `/tmp/bud-mobile-streaming-review`).
This comparison is based on source inspection, not a reproduced visual test.

## Requested shared behavior

Treat a response as a lifecycle with text boundaries, rather than independent
messages whose appearance alone determines whether work is active.

1. On user send, show progress while waiting for the agent.
2. Show the current reasoning/tool activity as it arrives. A commentary/text
   output ends the preceding activity segment and collapses that segment.
3. Keep every commentary output visible while subsequent activity arrives.
4. Keep progress visible while work remains pending, except while assistant
   commentary or final-answer text is actively streaming to the UI.
5. When the final response is complete, collapse preceding work under Worked for
   {time}; leave the final response as the normal assistant message.
6. Opening Worked reveals commentary with collapsed activity segments between it.
   When there is no commentary, reveal tool/reasoning content directly without
   requiring another activity-disclosure click.

Interpretation for review: “final response” means finished visible final text,
not its first token. “Text actively streaming” means assistant commentary/final
text, not hidden reasoning or the mere presence of a draft row. Whether tools'
large raw payloads should auto-open is separate from showing their useful output.

## Example acceptance sequence

| Event/state | Expected presentation |
| --- | --- |
| User sends; no response yet | User message + spinner |
| Reasoning/tool segment A | Current activity visible + spinner while no assistant text streams |
| Commentary C1 streams | A collapsed, C1 visible, no spinner during text emission |
| C1 finishes; next step delayed | A collapsed, C1 retained, spinner returns |
| Segment B arrives | A collapsed, C1 retained, current B visible + spinner |
| Commentary C2 | A/C1 retained, B collapsed, C2 visible; spinner suppressed only during text emission |
| Final answer streams | Commentary retained until agreed completion boundary; final streams without competing spinner |
| Final rendering completes | User / Worked for … / Final |
| Open Worked | A disclosure / C1 / B disclosure / C2 in chronological order |
| Same turn with no commentary | Opening Worked directly reveals activity content |

This is a review fixture specification, not a new test implementation.

## Differences in current implementations

| Area | Web | Mobile | Reconciliation needed |
| --- | --- | --- | --- |
| Live work container | Collapsed Working header plus one current detail | Headerless live rows, commentary and compact activity cards | Shared live presentation contract |
| Earlier commentary | Folded into default-collapsed work after canonical classification | Retained visibly while group is live | Web must retain it |
| Earlier activity at commentary boundary | Already hidden, per-message model | Explicit groups in model, but live renderer flattens them | Render collapsed segments on both |
| Current reasoning | Full current draft detail | First-line reasoning title; full text hidden and live toggle disabled | Agree visible reasoning detail |
| Between-step progress | Gate can reopen, but any live group suppresses footer | Initial pending-response spinner clears once and never rearms | Shared lifecycle-driven progress |
| Send-to-first-output | dispatching excluded from normal spinner | 150 ms grace before pending spinner | Agree delay and queued-state behavior |
| Assistant-text suppression | Start/delta suppress; done returns after 250 ms | First visible assistant response clears pending permanently | Use text visibility + response lifecycle |
| Finished expanded work | Commentary + individual collapsed tool/reasoning headers | Commentary + segment disclosure + individual detail toggles | Shared section hierarchy |
| No-commentary expansion | Still individual detail clicks | Still segment and individual detail clicks | Both need direct reveal |
| Work identity | Server turn ID; contiguity fallback; suffix on hard boundaries | Chronological grouping and source-message overlap | Normalize turn/invocation ownership |
| Completion | Matching live turn/runtime final | Following assistant row completed vs streaming | Coordinate semantic completion and renderer drain |
| History failure attribution | Session outcome map plus final-presence heuristic | Failure/cancel badges from contained tool status | Preserve durable outcome without equating a failed tool with failed response |
| Duration | Interval union; partial legacy tool sum; rounded seconds | Interval union plus standalone durations; complete legacy tool sum/local observed fallback; floor seconds | One duration policy and formatter contract |
| Questions/compaction | Standalone, split groups | Standalone, split groups | Decide how a single response resumes across interruptions |
| Approval tools | Pending standalone; completed becomes ordinary work | Rows with proposal/permission IDs excluded from work | Reconcile settled approvals separately from actionable ones |
| Rendering updates | React projection memoization; synthetic draft messages | Live Markdown store bypasses root projection for text-only deltas | Completion must account for visible rendering, not just SSE receipt |

## Why the spinner disappears

These are different implementation rules, not just different styling.

Web `ChatTimeline` suppresses its footer when any live work row exists because
its header already says Working. That header is not a spinner. The route's 250 ms
return logic therefore cannot restore a between-step spinner for those rows.

Mobile `currentPendingAssistantResponse` is tied to a locally sent user message.
It is cleared after the first tool or visible assistant surface. Its purpose is
first-response latency, not all gaps in the response lifecycle. Live activity
cards show Running labels, not a replacement spinner. Cold opens and automated
responses need progress even without a locally created pending-send object.

Neither implementation checks whether assistant text is actually advancing on
screen. An empty start event and a stopped token stream need explicit treatment.

## Recommended direction to review

Define one presentation-state contract, with language-specific reducers and
shared event/expected-output fixtures. No need to share React/SwiftUI code.
Separate four concerns:

- Response ownership/status: invocation/turn, pending/running/blocked/terminal.
- Message classification: provisional assistant text, commentary, final,
  reasoning and tool activity. Do not interpret an unclassified draft as a
  confirmed final boundary.
- Sections: consecutive activity runs separated by commentary; current segment
  independent of disclosure defaults and user overrides.
- Progress: eligible outstanding work minus visible assistant-text emission;
  terminal/blocked states and stale connections get explicit handling.

Prefer existing canonical metadata where adequate. Audit service event payloads
and renderer completion signals before proposing additive fields. This review
does not establish that the service currently sends every needed classification
at message start or that provider “final” and invocation terminal are identical.

Retain owner-scoped thread/invocation reads and SSE authorization. This is a
presentation change: it must not alter model-visible history, message persistence,
agent execution, tool permissions, or final-only read/notification semantics.

## Decisions to settle before implementation

| Decision | Suggested starting point |
| --- | --- |
| Collapse at first final token vs finish | Finish visible final rendering, with terminal outcome reconciled |
| Current segment contents | Keep the active segment visible until commentary/final; collapse earlier segments |
| No-commentary “expand all” | Reveal useful reasoning/tool contents in one click; retain optional raw JSON/large-output controls |
| Parallel tools | Show all active items or an accurate active-count summary; never imply the last item is the only work |
| Text stalls | Define a short inactivity threshold; empty message_start must not hide progress indefinitely |
| Waiting for human | Keep actionable question/approval inline; show waiting label rather than an endless busy spinner |
| Waiting for Bud/model, retry, terminal | Explicit status; decide when spinner conveys real progress |
| Questions/approvals/compaction within one invocation | Preserve actionable surfaces and chronology; decide whether completed work reunifies under one top-level disclosure |
| Manual expansion | Preserve deliberate inspection overrides; automatic collapse applies to untouched defaults |
| Duration | Keep trustworthy service work intervals initially; explicitly decide whether pauses/gaps/final text belong in the displayed total |

## Validation required after agreement

Use the same sequences on both platforms: send, empty-start, first reasoning,
multiple tools, delayed next action, two commentaries, final, and no-commentary
turn. Include tool error followed by recovery, canceled/failed/no-final responses,
parallel completion out of order, questions and approvals with continuation,
automation-triggered work, terminal waits, offline/retry, and mid-turn compaction.

Replay each live and via cold bootstrap, reconnect, app foreground, older-history
prepend and thread switch. Exercise final-before/after-persistence timing, delayed
canonical classification, interrupted text, stale events/timers from a prior
turn, and rendering that drains after stream completion. Assert exact visible
rows, spinner visibility, disclosure defaults and preserved user overrides at
each step. Check bottom-follow without yanking users reading older work, selection,
accessibility, and lack of duplicate rows after canonical reconciliation.

No application code, runtime settings, database rows, or deployment changed in
this review. Tests were inspected; no visual parity or runtime test pass is claimed.

## Follow-up scope

See the [proposed implementation plan](../plan/streaming-experience-contract.md). The review above records
the baseline behavior; the plan defines the proposed changes and validation gates.
