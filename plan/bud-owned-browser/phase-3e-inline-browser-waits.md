# Phase 3e: durable browser waits with inline return

Status: implemented locally; automated checks passed. User testing confirmed the
actual-agent flow and compact inline controls. Signed-in restart and broader
acceptance cases remain pending. See [validation](../../debug/browser-inline-waits.md).

## Objective

When an agent reaches a browser operation while the user has private control,
pause that invocation durably and show an inline **Return to agent** action.
After acknowledged return, continue automatically in the same conversation.
Do not make the model consume a private-control error, explain it, and finish
the turn. Ordinary follow-up chat must remain available throughout.

This supersedes the rejection-as-normal-result decision in
[private-control-chat.md](private-control-chat.md), but preserves its separation
between conversation availability and browser authority.

## Scope boundary

Deliver one vertical slice: persist the blocked browser call's wait, show its
inline return action, and resume through the existing continuation machinery.
Multiple waiting turns, cancellation, restart reconstruction and original tool
pairing are correctness requirements for that slice, not separate projects.

The debt inventory below is context, not a refactoring checklist. Change an
existing path only when required to admit, display, resolve or cancel these
waits correctly. Extract a small helper only when this flow would otherwise
duplicate logic; extraction, renaming and file reorganization are not deliverables.
Unrelated findings go into follow-up notes rather than expanding this phase.

## Current implementation and concrete debt

Review covers the executor/broker, control coordinator and repository, invocation
claim/park/continuation code, pane discovery and handoff renderer. It is a focused
lifecycle review, not a complete audit of the browser subsystem.

| Current behavior / source | Consequence | Scoped correction |
| --- | --- | --- |
| `browser-tool-executor.ts` turns private rejection into a completed tool result telling the model to ask for return | The agent finishes instead of waiting | Add a typed internal wait disposition before any daemon dispatch; retain normal errors for unsupported/unavailable/invalid requests |
| `broker.ts` can also return `browser_private_or_paused` with an **unknown** outcome after dispatch/evidence checks | Matching only the error string could accidentally retry an executed action | Carry explicit admission provenance; only proven undispatched work qualifies for this wait |
| `BrowserControl.park` only starts an agent-requested handoff from agent control; `parkUserBrowserHandoff` handles takeover of an already-running invocation | Neither represents a new invocation arriving during existing private control | Reuse durable invocation waiting, with explicit browser-wait reasons rather than another takeover path |
| `browser_handoff_pending_session_idx` permits one pending row per session | A second invocation cannot independently wait for the same browser | Permit per-invocation waits while keeping one controller per session |
| `pendingBrowserHandoffForThread` returns one row and labels it `browser_request_handoff`; continuation treats other kinds as user takeover | Real tool identity and multiple pending turns get obscured | Preserve original tool/call identity and expose pending waits as a collection independent of the currently active turn |
| Browser logic is embedded in `prepareQuestionContinuation`, alongside several other permission types | Another inline branch could increase coupling and complicate exact tool pairing | Extend only the browser case; share a small helper if needed to avoid duplication. Defer general continuation extraction or renaming |
| `requestAgent`, daemon pause, and invocation parking are separate steps; return cancels rows whose invocation is not yet waiting | Return/park races or crashes can strand intent | Make new pre-dispatch wait creation and invocation parking atomic; coordinate with acknowledged return using a documented lock order |
| Chat return callback belongs to the mounted viewer; handoff renderer only offers Open browser | Action location depends on pane lifecycle and can disappear | Share one viewer-action context between inline card and viewer menu; do not build a second controller |
| Pane discovery infers a pause from any non-agent control state | Disconnected, returning, and user-controlled can look equivalent | Render inline wait state from durable wait metadata plus runtime/controller availability, not just `pausedSessionId` |
| `defer` retains the thread reservation for any waiting continuation | A resumed browser wait deferred for an offline Bud/model can block follow-up chat again | Cover the new browser-wait path through claim/defer/recovery/cancellation and make targeted corrections; do not redesign scheduling or other wait types |

Preserve the useful complexity: ownership checks, invocation fences, control
epochs, explicit acknowledged return, unknown-outcome handling, independent
media transport and the single-controller lease. None is replaced by a boolean
`isPaused`. Viewer recovery is not permission to resume an agent.

## Recommended user experience

1. User controls the browser and sends “click the sixth link.”
2. Agent may stream commentary and use other tools before reaching the browser.
3. At the browser boundary, show an inline card at that call's position:
   “Browser work is waiting for you to return control.”
   Actions: **Return to agent**, Open browser, and the existing Stop action
   targeting this invocation. No active-work spinner while waiting.
4. Return uses the same authenticated viewer/controller action as the menu.
   Show “Returning…” while acknowledgement is pending; failure remains on the
   same card with an actionable explanation. Do not collapse it as completed.
5. Once return is committed, the existing worker claims the continuation. Show
   queued/running state accurately if another chat invocation currently owns the
   thread. The agent observes the page again and continues without another user
   message.
6. Historical resolved cards remain inert and group with their original work.
   An unresolved card remains visible even if a newer chat turn finishes or the
   user reloads; it must not be hidden inside collapsed Worked for content.

If this client does not own the controller, show Open browser / return from the
controlling viewer instead of a button that will inevitably fail. Opening a pane
does not itself acquire or return control. A closed pane or expired lease uses
the existing explicit acquisition/recovery flow before return. Direct return
without viewer authority is not part of this phase.

## Resume semantics: wait, then reconsider

Options considered:

| Option | Benefit | Cost / risk |
| --- | --- | --- |
| Keep rejection, improve the button | Small UI change | Does not continue the original invocation automatically |
| Suspend and execute the exact old call on return | Literal delayed execution | Page, target, reference, focus and intent may have changed; needs new safe replay semantics |
| Durable wait, then paired deferred result and fresh observation **(recommended)** | Reuses existing continuation rules and does not act on stale page state | One additional model step; exact old operation is not automatically executed |

The tool stays pending from the user's perspective until return. On continuation,
resolve its original provider call ID with an honest “not executed; control was
returned; observe the current page before acting” result. The model then issues
a fresh operation. This is automatic task continuation, **not** a success receipt
for the blocked click. Use the same rule for reads and writes initially to avoid
separate retry engines. Explicit `browser_request_handoff` continues to resolve
as a completed handoff, not a deferred browser action.

Preserve already-completed results. Remaining calls in the same provider batch
receive the existing explicit not-executed disposition after return; do not run
trailing terminal or browser actions while this invocation waits. New chat turns
can still execute non-browser work. Unknown in-flight outcomes never enter this
safe deferred path or automatically repeat.

## State and persistence contract

Use `agent_invocation`, `agent_invocation_action`, and `browser_handoff` rather
than a new queue or workflow service. Keep one pending browser wait per invocation;
allow several invocations to wait on one session. Add an explicit wait kind such
as `return_control` alongside existing agent/user handoff kinds, with original
tool/call/client/turn IDs preserved. Session generation binds the wait to the
actual browser; an unrelated future browser cannot satisfy it.

Replace the unique pending-session constraint with a pending-invocation
constraint and a nonunique session/status index. Audit the existing manual
takeover path, which currently uses the session-wide pending row to avoid
duplicates: deduplication must become invocation-specific, not arbitrarily pick
another turn's wait. Do not repurpose or overwrite an existing handoff's caller.

The admission transaction must validate owner, thread, session identity, live
invocation fence and cancellation, then either authorize normal preparation or
atomically create the wait, mark its action waiting and release the invocation
lease/thread reservation. A preflight read alone is insufficient. Return racing
with admission must either include that committed wait or let admission observe
agent authority and proceed; it must never lose a wake-up. No network request or
long-held lock inside this transaction. Follow the existing lock order and check
the touched admission, claim, takeover, return and cancellation paths for conflicts.
Correct conflicts required by this flow without a general transaction-layer rewrite.

Waits have no timer that grants permission automatically. Explicit return resolves
all eligible waits for that browser session; existing worker ordering serializes
them, with fresh context and observations between invocations. Each remains
independently cancelable. Return is session-wide authority, so the UI should make
multiple waiting turns discoverable rather than imply only one will resume.

Session close, confirmed daemon restart, thread deletion and revocation must
resolve/cancel affected waits explicitly. They must not leave waits whose claim
predicate requires a live session forever. A transient disconnect preserves the
wait; a destroyed browser never produces a fake “control returned” result.

## Ownership, API and rendering

Resources are owned by the thread's user, inherited through Bud, browser session,
invocation, action and handoff. Resolve the authenticated viewer before returning
metadata; use owner-scoped SQL and existing control endpoint checks. Stamp new
handoff rows with inherited `created_by_user_id` and `tenant_id`; retain composite
ownership foreign keys. Foreign resources return 404, unauthenticated requests 401.

Expose bounded pending-wait metadata through the existing authorized thread
bootstrap/recovery contract, with stable wait/call/turn IDs and explicit status.
Use existing chat events for updates; reconnect reconstructs from the database.
Do not overload the single active `pending_tool` to represent every waiting turn.
No page text, screenshots, credentials, viewer tokens or recovery proofs in wait
metadata. Update SSE/API documentation for additive fields.

Extend the existing handoff renderer for the inline return-control wait; share
presentation where needed without migrating other approval UIs.
Reuse the viewer's return handler through a typed context with session
identity and availability; clear stale handlers on unmount, owner/thread switch
and control loss. Remove the redundant top-of-chat return prompt when an inline
wait is present; keep passive browser status in the pane. Do not add per-card
polling, media subscriptions or another renewal timer. Frame updates remain
outside transcript state.

## Implementation sequence and cleanup boundaries

1. **Persistence/admission:** migration, atomic undispatched admission/parking,
   multiple waits, race/cancellation tests. Retain existing repository and worker
   boundaries; do not introduce a general wait abstraction.
2. **Agent continuation:** typed wait outcome, truthful original-call pairing,
   deferred remaining calls, restart reconstruction and reservation rules.
   Replace the current private-rejection instruction for eligible calls; keep
   unknown outcome reporting separate.
3. **Web:** shared viewer action context, inline pending card, bootstrap/reconnect
   collection and stable grouping. Remove duplicate top-level wait CTA logic.
4. **Validation/docs:** actual-agent private-control test, service restart,
   multiple chat turns, cancellation, and regression coverage below. Update
   older plan statements that imply rejection or a single handoff is the target.

Explicit won't-dos: no in-memory promise held across human input; no model retry
loop while private; no global conversation lock; no automatic authority return
on message send or pane close; no exact stale-call replay; no new scheduler;
no generic permission framework; no viewer/media rewrite, WebRTC or browser REPL;
no repository-wide refactor or new mobile viewer in this phase. Native inline
action parity follows the mobile viewer phase; existing clients retain a useful
first-party viewer link and readable waiting summary.

Further deferred cleanup: generalizing or renaming `prepareQuestionContinuation`,
unifying questions/data permissions/automation approvals, redesigning existing
agent-requested takeover, controller leases, recovery tickets or media recovery,
and reorganizing the browser viewer. Touch those paths only for a demonstrated
interaction with the new wait contract. No new direct-return endpoint, controller
independent of the mounted viewer, wait dashboard or configurable wait policy.

Stop when the acceptance cases below pass and the inline flow works with the
actual agent. Do not use this phase to address unrelated debt in the inventory.

## Validation and rollout

- Real chat: private control → browser request → visible pending card → return →
  automatic fresh observation and continued task, without an intervening final
  refusal. Plain chat and non-browser work still run during the wait.
- Two waiting invocations plus an active third turn; deterministic serialized
  continuation, correct original call/turn IDs, cancellation of only one wait.
- Batched calls for OpenAI, Claude and local providers: exactly one result per
  original tool call, no invented handoff call, no replay of completed work.
- Return before/during/after park; repeated clicks; takeover during dispatch;
  unknown mutation; cancellation and return racing; crash after persistence
  before UI publication. Exercise real PostgreSQL constraints and transactions.
- Service restart, offline Bud/model, daemon restart, browser close, expired
  viewer lease, missing pane, second viewer, deleted thread and foreign owner.
- Reload and newer-turn completion preserve old pending cards; resolved cards
  stay inert. No spinner while waiting, duplicate notices, per-frame transcript
  renders or extra poll loops.

Expected implementation is service/web only using existing daemon pause/return
capabilities. Older capable daemons need no new command; unsupported daemons keep
explicit unsupported behavior. Old service/new web needs an additive metadata
fallback to existing viewer links; new service/old web must still present a
readable wait and existing browser return route. Do not advertise a new daemon
capability for a service-only change.

Schema changes require local `db:push`, generated checked-in migration, and
upgrade validation against pending agent/user handoffs. Preserve existing waits;
do not delete them to make the migration pass. Mixed service versions sharing the
changed multi-wait database are outside the current single-instance deployment
contract; document rollout/rollback constraints before shipping.

Relevant specs to update during implementation: service browser, agent, DB and
migrations; web browser, message renderers, affected route/runtime/API specs;
`docs/proto.md` for additive chat metadata; ownership validation checklist.
Source references: `service/src/agent/{browser-tool-executor,invocation-repository,
continuation-results}.ts`, `service/src/browser/{broker,control,control-repository}.ts`,
`web/src/features/browser/pane.tsx`, and
`web/src/components/message-renderers/tools/browser-handoff.tsx`.

Migration: `0042_foamy_invisible_woman.sql`; service/web only, no daemon upgrade.
Apply migration before service deployment. Rollback requires resolving multiple
pending session waits before restoring the old unique index.
