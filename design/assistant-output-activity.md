# Design: Assistant output activity and the commentary spinner gap

Status: implemented in the service, web and mobile working trees. Automated validation
is recorded below; physical-device and browser interaction validation remains.

## Problem and decision

The [device capture](../debug/commentary-spinner-gap.md) records 5.8 seconds
between the last commentary delta and `agent.message_done`. The draft remains
streaming while the provider can be generating tool arguments. Both clients
currently infer spinner suppression from message lifecycle rather than current
generation activity.

Add one small, service-owned **output activity** value to the existing runtime
snapshot and publish its transitions on the existing authenticated agent stream.
Keep message completion, final classification, persistence and rendering separate.
Clients consume the activity fact; they do not reconstruct provider transitions.

This narrowly replaces the suppression rules in
[assistant activity visibility](assistant-activity-indicator-visibility.md) and
extends the [client-only streaming scope](../plan/streaming-experience-contract.md)
for the demonstrated backend gap. All unrelated simplification boundaries remain.

## Three values, one purpose

During a model call, `output_activity` is:

| State | Meaning | Generic spinner, if the turn is otherwise eligible |
| --- | --- | --- |
| `working` | Waiting for first text, generating reasoning/tools, or known continuation | Eligible after the existing short grace delay |
| `text` | Non-empty assistant text has arrived and has not transitioned to another activity | Hidden |
| `awaiting_completion` | Text ended; continuation versus final is still unknown, or final classification is awaiting persistence | Hidden |

`null` means no current model-output activity; existing invocation/phase/wait
and final-message facts decide eligibility. This is not a fourth generation state.

The third value is necessary: text ending is not proof the turn continues.
Treating every text end as working would reintroduce the final-answer spinner
flash. Treating every text end as final would prematurely collapse commentary.

A provider pause with no new boundary remains unknown. We deliberately cannot
promise a spinner during every silent interval while also guaranteeing no final
flash. In particular, unknown text → silence → final remains quiet. Explicit
commentary completion or subsequent tool/reasoning activity resumes progress.
Existing stream failure/timeout/recovery handles lost streams; no new watchdog.

## Contract and ownership

Runtime snapshot addition (snake_case):

```ts
output_activity: {
  llm_call_id: string;
  state: "working" | "text" | "awaiting_completion";
} | null;
```

The enclosing snapshot already supplies `turn_id` and `stream_cursor`.
SSE event `agent.output_activity`:

```json
{
  "turn_id": "<existing turn id>",
  "llm_call_id": "<existing model call id>",
  "state": "working"
}
```

Use the existing model-call ID, not a new ID family. A nullable `state` clears
activity for that call. Clear events and later events for old calls must not
overwrite a newer call. An explicit initial `working` transition begins each call.
Emit only on value/call changes, never once per argument token.

The resource is the thread's active turn/model call. The existing authenticated
viewer and authorized-thread helpers protect snapshot reads and SSE attachment
before any state/replay is delivered. No endpoint, global read, DB table or row
stamping is added. Do not include generated arguments or reasoning payloads.

The runtime manager owns the sole authoritative value. Updating it and publishing
its event/cursor must be synchronous and ordered, with the snapshot updated before
listeners can observe that cursor. Reuse existing cursor/replay machinery. Preserve
draft text when activity changes; presence of a draft does not imply `text`.

## Backend transitions

Use a small helper within the model-runner flow, driven by canonical events. It
needs the current productive text index/phase and existing tool-call knowledge,
not another registry of transcript rows. Reset it for every model call/retry.

| Input | Activity decision |
| --- | --- |
| Model invocation starts, before awaiting provider output | `working` |
| Empty message/content start or empty delta | No suppression change |
| First non-empty `text_delta`, including a later text block | `text`; retain the same existing aggregate draft identity |
| `content_done` for the current productive text block, explicitly commentary | `working` |
| Same boundary with a tool call already established in this response | `working`; continuation is already known |
| Same boundary with unknown or final-answer phase and no known tool | `awaiting_completion` |
| Tool start or non-empty argument delta | `working`, even if the provider omitted text-end |
| Reasoning start or non-empty reasoning delta | `working`, including redacted reasoning with no visible text |
| Later non-empty text delta | `text` again |
| Completion for an older block / duplicate boundary | No change to the newer activity |
| Validated model response continues | `working` alongside intermediate classified completion |
| Validated model response is final | `awaiting_completion` alongside final classified completion |
| Tool execution, explicit wait, compaction, retry handoff, terminal success/failure/cancellation | Clear the call's output activity; existing lifecycle takes over |

Do not equate argument generation with tool execution: `pending_tool`, approval
forms, tool rows and side effects begin only at their current validated boundaries.
An activity transition never emits `agent.message_done` or marks a row final.
Provider phase is a progress hint; the agent loop still validates the final result.

Delayed reasoning/tool completion events can flush old blocks after newer text.
They must not switch activity merely because they contain accumulated content.
For a provider that supplies only a completed tool, publish known continuation at
the validated response boundary. Do not invent an earlier tool-start time.

The latest productive stream event determines activity if text/reasoning/tool
deltas interleave; metadata-only events do not. A late text-end only affects the
currently productive text block. Avoid retaining an open-text set that would keep
local Chat Completions drafts suppressing progress throughout argument assembly.

## Provider coverage from current adapters

| Provider path | Existing signals | Required handling |
| --- | --- | --- |
| OpenAI Responses (`openai.ts`) | Text end → `content_done`; assistant phase on text; tool start/deltas; reasoning start/deltas | Consume these signals in the runner. No new OpenAI request options. |
| Claude (`anthropic.ts`) | Text block stop → `content_done`; tool/thinking block starts; no assistant phase | Unknown text end waits quietly; next tool/thinking start resumes progress. Signature-only completion must not steal activity from later text. |
| DeepSeek Responses, direct or Bud transport (`ds4.ts`) | Text end when supplied; fallback ends at response completion; tool/reasoning signals; streaming text currently has no phase | Treat phase as unknown. Both transports share the parser; no daemon protocol change. Late fallback boundaries must not override newer work. |
| Generic Bud-local Chat Completions (`bud-local-chat.ts`) | Text deltas; tool start once name is known; argument deltas; structured or inline-tag reasoning; text end emitted at stream tail | Tool/reasoning transitions must work without an early text-end. Text can resume on the same index. Preserve current tag buffering and trailing usage handling. |

These are observations of repository adapters, not promises that every server
emits every optional boundary. Do not add provider-specific client logic. Missing
boundaries use later concrete transitions/completion; missing all progress signals
cannot be repaired by the indicator alone.

## Web and mobile

Both clients keep their existing active/pending/wait/failure logic and short
anti-flicker delay. The output activity replaces only text suppression:

1. Explicit waits, terminal outcomes and a completed final answer for the current
   turn keep their current precedence. Older-turn finals must not suppress a new run.
2. `text` and `awaiting_completion` suppress the generic spinner.
3. `working` permits it, even with an incomplete commentary draft still on screen.
4. With no active output value, use existing execution eligibility, without
   reintroducing a blanket “any draft exists” suppression rule.

Keep compaction's dedicated presentation and avoid a second generic spinner.
Text transitions cancel pending spinner timers immediately. Repeated working
events do not restart the grace period. No per-token UI activity publication.

Web: replace the message-done suppression timer/state in
`assistant-activity-indicator-state.ts`; do not layer a second gate over it.
Mobile: replace the response-row streaming scan used for spinner suppression in
`ChatAssistantActivityRowView`; keep `ChatAssistantActivityPolicy`, pending-send
bookkeeping and the existing delayed progress view. Text rows can remain open
for subsequent deltas; their renderer lifecycle is not the activity source.

`agent.message_done.segment_kind`, canonical messages and `final` retain their
current rendering/grouping roles. Do not remount Markdown, force completion,
change scroll logic or add renderer acknowledgements to this contract.

## Recovery and cleanup

- Snapshot and live events must produce the same suppression result, including
  a draft plus `working` during tool assembly and `awaiting_completion` before final.
- Feed the new event through each client's existing cursor/deduplication path.
  Reject stale turn/call updates using current active identity; don't start a new
  run from an orphaned late activity event.
- Apply snapshot state at its cursor, then newer replay. An older in-flight
  snapshot fetch must not overwrite more recent live activity.
- Clear on new turn, retry/next call, cancellation, failure, approval/terminal wait,
  finished run, thread switch and logout. New model calls explicitly start working.
- A service restart/resync restores existing durable run/error state; runtime-only
  output activity is not reconstructed from old transcript rows.
- Network loss retains the existing connection/recovery UX; activity is not proof
  that a disconnected provider or Bud remains productive.

## Validation and implementation sequence

Implement as one bounded service/web/mobile change after review:

1. Add runtime state/event and the canonical-transition helper; leave provider
   adapters unchanged unless a targeted fixture proves a missing required mapping.
2. Wire web and mobile decoding/recovery and replace superseded suppression paths.
3. Update protocol/spec docs, run native tests and validate on web and the phone.

Required tests use native fixtures, not a new shared testing framework:

- A held-open provider generator yields commentary, text end, tool start and then
  pauses: assert working SSE/snapshot **before** arguments or the response finish.
- Text → text; text → reasoning → text; unknown text end → delayed tool; explicit
  commentary → delay; tool → text → completion; final hint contradicted by a tool.
- Empty starts, whitespace-only text, duplicate/stale ends, late reasoning flush,
  missing text-end and resumed same-index text. Whitespace-only output must not
  hide the spinner until visible non-whitespace text exists.
- All four provider adapters' boundary ordering, including ds4 tail completion
  and local Chat Completions usage tail. No live API keys required for fixtures.
- Final text → delayed persistence produces no spinner flash. Intermediate done
  resumes progress; max-token/error/cancel is not rendered as successful final.
- Replay/resync in each state, overlapping snapshot/live receipt, new call and
  new turn, automation without a local send, waits/retries and stale timer cleanup.
- Mounted web/mobile: commentary stays visible during spinner, tools remain
  unexecuted until validation, text resumes without duplication, final grouping
  is unchanged. Recheck scrolling/selection, approvals and thread switches.

Update `docs/proto.md`, agent/runtime/provider specs as affected, web thread/route
specs, and mobile `design/mobile-presentation-flow.md` plus completion/diagnostic
plans. Link this design from those older suppression descriptions during implementation.

## Rollout and explicit won't-dos

Coordinated pre-launch update: service and web together, then rebuilt mobile.
No feature flag, migration or daemon upgrade. An old client ignores the new event
and retains the old visual gap during this short rollout; upgrade is the remedy.
New clients target the updated service. Do not maintain parallel old/new activity
algorithms or a permanent compatibility gate.

No inactivity heuristic, arbitrary completion delay, provider-specific UI,
argument-preview cards, transcript identity rewrite, new persistence, general
state-machine framework, per-token telemetry or render-ack dependency. Reuse the
runtime and native client stores. Do not overload runtime `phase`: existing draft
and reasoning setters mutate it for reasons other than productive output, and
tool/wait phases describe execution rather than generation. One narrowly scoped
activity value avoids making those meanings more ambiguous.

Optional diagnostics are transition-only metadata (turn/call, old/new activity,
boundary type, elapsed time), within existing debug controls. This work does not
address first-token model latency or promise progress before any provider signal.

## Implementation validation (2026-09-10)

- Service TypeScript check and 40 focused runtime/model-runner/completion tests pass.
- Provider fixture run passes (36 tests, including the output-activity cases).
- Web: 202 unit tests, 12 static render tests, targeted ESLint and production build pass.
- Mobile: 64 focused simulator tests pass in Bud Production Debug, covering
  activity decoding/mapping, store restoration, reducer behavior, final completion
  and activity eligibility.
- Both working trees pass whitespace checks.

The web render tests exercise server-rendered structure, not browser timers.
Phone/browser interaction validation remains: reproduce commentary followed by
slow tool arguments, approvals, final persistence, reconnect, automation starts
and switching threads. Deploy/restart the service and rebuild mobile before
testing against that environment. Nothing has been deployed or installed here.
