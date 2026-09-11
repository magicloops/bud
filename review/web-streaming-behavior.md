# Web streaming behavior review

Status: review only; no application changes. Reviewed September 9, 2026.
Baseline: `e7fdbec` (`origin/main`), branch `review/streaming-behavior`.
Companion: [cross-client comparison and proposed contract](streaming-behavior-comparison.md).

## Scope and evidence

Static review of the web projection, work renderer, timeline, activity gate, stream
callbacks and relevant fixtures/tests. This is not a browser reproduction or a
full transport/provider audit. Findings below distinguish deterministic rendering
rules from timing risks that need an event-sequence test. Existing local changes
were preserved in the original checkout; this review uses an isolated worktree.

## Current pipeline

`use-agent-stream.ts` receives tool, reasoning, message and final SSE events.
The existing-thread route coordinates transcript mutations, runtime status,
`liveTurnId`, session-local outcomes and a separate assistant-activity gate.
`ChatTimeline` projects visible raw messages into standalone messages or work rows.
`AgentWorkGroup` renders the projection and the timeline renders a separate spinner.

| Responsibility | Source / relevant symbol |
| --- | --- |
| SSE event dispatch and recovery | [use-agent-stream.ts](../web/src/features/threads/use-agent-stream.ts), `connectAgentStream` |
| Activity gate/timers and send lifecycle | [existing-thread route](../web/src/routes/$budId/$threadId.tsx), `handleAssistantMessage*`, `scheduleAssistantActivityReturn`, `handleSubmit`, `handleFinalizeTurn` |
| Durable activity eligibility | [invocation-state.ts](../web/src/features/threads/invocation-state.ts), `invocationAllowsLiveActivity` |
| Message classification | [agent-message-metadata.ts](../web/src/lib/agent-message-metadata.ts), `getTurnId`, `getSegmentKind` |
| Work projection | [agent-work-projection.ts](../web/src/features/threads/agent-work-projection.ts), `createTimelineProjector` |
| Work presentation | [agent-work-group.tsx](../web/src/components/workbench/agent-work-group.tsx), `AgentWorkGroupComponent`, `WorkSectionRow`, `LiveHeaderLabel` |
| Expansion and final spinner gate | [chat-timeline.tsx](../web/src/components/workbench/chat-timeline.tsx), `expandedWork`, `expandedItems`, `ThinkingIndicator` call |
| Assistant text suppression | [assistant-activity-indicator-state.ts](../web/src/features/threads/assistant-activity-indicator-state.ts) |
| Actual spinner | [thinking-indicator.tsx](../web/src/components/workbench/thinking-indicator.tsx) |
| Duration | [agent-work-duration.ts](../web/src/lib/agent-work-duration.ts) |

## Current behavior

### Grouping and commentary

Work membership is reasoning, ordinary tools, and canonical assistant messages
with `metadata.segment_kind == intermediate`. Assistant drafts normally lack
that classification and render as standalone assistant messages. On canonical
reconciliation, an intermediate message becomes work and moves into the group.

Work is grouped by `metadata.turn_id` within contiguous eligible messages. User,
final assistant, question, compaction and other non-work messages flush the group.
The same turn split by a boundary receives multiple row IDs with suffixes. Legacy
messages without turn IDs use contiguity and the first member's identity.

Sections are **one message each**, classified as activity or intermediate. There
is no explicit collection of adjacent activities between commentary messages.

### Live rendering

The work disclosure starts collapsed (`expandedWork` is initially empty), even
while live. Its header shows Working, elapsed time and a current-step label.
Only the final message in the group can become `currentItem`, and only if it is
a pending tool or draft reasoning. That one item's detail is displayed outside
the collapsed disclosure. Completed items immediately disappear into the group.

Completed commentary is hidden unless the user opens the work disclosure. Live
assistant drafts are visible as standalone text, so the transition to canonical
commentary can cause text that was just visible to disappear before the final
answer. This differs directly from the requested persistent-commentary flow.

Between steps `currentItem` is null and the header says Thinking. The header has
no spinner. With parallel tools, an earlier still-running tool is not selected
if the last item is completed or is a different kind of message.

### Completion and expansion

Live state follows the matching `liveTurnId`, cleared on final event or canonical
runtime recovery. Final assistant text remains standalone. This is run-lifecycle
based, not an explicit final-text-render-completed boundary.

Opening completed work shows commentary as text and **each** activity as its own
collapsed header; current activity details are forced visible while live. There
is no segment-level disclosure for all activities between two commentary rows.
There is also no no-commentary exception: opening Worked still requires opening
individual reasoning/tool headers to see their contents.

User expansion choices persist in sets during the mounted timeline. A manually
expanded live group is not automatically closed on completion. Existing code
therefore already distinguishes default collapse from a user's override, but
that policy needs agreement for the requested behavior.

### Spinner: two independent suppression layers

1. Route-level eligibility requires normal `status == streaming`, an unsuppressed
   assistant gate, and eligible durable invocation state. Compaction overrides
   the assistant gate, but remains subject to the route's durable-state guard.
2. The timeline then hides the generic indicator whenever **any live work row
   exists**, unless the indicator has a specific label (currently compaction).

Consequences:

- Sending sets `dispatching`, which does not qualify for the normal spinner.
- After the first work row exists, the footer is suppressed during tools,
  reasoning, and gaps, even if the assistant gate correctly reopened.
- Message start suppresses the spinner before any visible text is required.
- Message done schedules a 250 ms return; a subsequent text start/delta cancels
  that return. Canonical explicit-final metadata suppresses until final.
- Suppression measures event lifecycle, not whether pixels/text are currently
  advancing. There is no idle-since-last-visible-token fallback for stalled text.
- Waiting for user or terminal is a separate status, not normal spinning work.

The second layer is a direct explanation for the missing between-step spinner;
changing only the 250 ms gate would not fix it.

### Duration and historical states

Completed duration unions valid `service_wall_clock` intervals from work messages
(excluding final text). This is not necessarily user-send-to-final elapsed time:
gaps outside intervals are excluded. Legacy pure-tool groups sum available
numeric duration metadata; incomplete metadata can produce a partial sum.
Other missing timing renders Worked without a number. Web rounds seconds.

Failure/cancellation badges use session-local final outcomes; cold history also
uses presence of a canonical final to distinguish normal work from Ended early.
Do not treat these as equivalent to durable invocation outcomes in every case.

## Gaps against the requested experience

| Priority | Finding | User-visible result |
| --- | --- | --- |
| High | Live-group existence suppresses spinner | No spinner in gaps after work starts |
| High | Live group collapsed by default | Earlier commentary disappears before final |
| High | Flat per-message sections | No grouped activities between commentary |
| High | No no-commentary expansion mode | Extra clicks after opening Worked |
| Medium | Pending send excluded; empty/stalled text suppresses | Quiet UI before first output or during a text stall |
| Medium | Last-item-only active selection | Parallel/overlapping activity can be misrepresented |
| Medium | Final event rather than visible text completion | Potential mismatch with client render-drain timing |
| Medium | Boundaries split one turn | Multiple Worked rows around questions/compaction |

## Tests and next validation

Existing [projection tests](../web/src/features/threads/agent-work-projection.test.ts)
and JSON fixtures cover basic/split/legacy turns, intermediate sections, current
steps, between-step live state, failures, no-final cases, questions and compaction.
The between-steps fixture deliberately expects live work with a null current item;
it does not assert that a spinner is visible. Activity-gate tests cover the 250 ms
return, bootstrap and stale-turn timer behavior but do not exercise the timeline's
second suppression layer. These tests were inspected, not executed in this review.

Add end-to-end presentation assertions for the shared sequence in the comparison
review, particularly draft-to-commentary persistence, empty message start,
message-done-to-next-tool gaps, no-commentary expansion, and final rendering drain.
Keep current file/web actions, pending human controls, owner-scoped recovery,
manual expansion state and bottom-follow behavior intact. Code changes await review.

## Follow-up scope

See the [proposed implementation plan](../plan/web-streaming-experience.md). The review above records
the baseline behavior; the plan defines the proposed changes and validation gates.
