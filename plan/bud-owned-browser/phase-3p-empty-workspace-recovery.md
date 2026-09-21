# Phase 3p: Recover empty browser workspaces

Status: implemented locally; automated validation and reported-thread recovery accepted; broader manual matrix remains. Updated 2026-09-21.

## Context

[Incident and evidence](../../debug/browser-empty-workspace-recovery.md).
Related plans: [persistent browser](phase-3k-shared-persistent-browser.md),
[URL recovery](phase-3l-tab-and-history-recovery.md),
[background browser](phase-3m-background-headed-browser.md).
Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
[service browser](../../service/src/browser/browser.spec.md).

Closing the last thread-owned tab is ordinary browser use. Today, opening a page
requires an existing target, restart admission requires recovery, and missing
saved-page hints can leave private authority paused without a usable controller.
These constraints conflate page availability, history recovery and control.

## Objective

A user can ask the agent to open a known URL after a tab closes or the daemon
restarts, without restoring history or manually taking control. Preserve sign-ins,
thread ownership, private authority and truthful uncertain-action results.

This narrowly supersedes Phase 3l's requirement for human recovery before **every**
post-restart agent operation. Explicit fresh open is allowed under agent authority;
saved URL restoration remains an explicit human operation.

## Options and recommendation

1. Only improve the error text and ask the user to start blank. Smallest patch,
   but preserves unnecessary user intervention and the broken empty-open path.
2. **Recommended: make existing open ensure a usable page, and treat saved pages
   as optional.** Repair lifecycle checks at their existing owners; keep five tools
   and existing control/generation machinery.
3. Automatic history/session restoration on every read or failure. Rejected: adds
   privacy, mutation replay and page-selection ambiguity beyond this problem.

## Behavior contract

| Situation | Requested operation | Result |
| --- | --- | --- |
| Healthy owned page | Open with URL | Navigate it, as today. |
| Healthy owned page | Open without URL | Return existing targets. |
| No owned page | Open with URL | Create a thread-owned page and navigate to that URL. |
| No owned page | Open without URL | Create a blank thread-owned page. |
| Daemon restarted, agent authority | Explicit open | Establish fresh workspace authority/generation and ensure a page. Do not replay saved URLs. |
| Private authority, including an empty workspace | Agent browser call | Existing durable wait and inline Return to agent; no implicit takeover. |
| No eligible saved hints | Human Reopen saved pages | Successfully provide a blank private workspace; say no saved pages were available. |
| Empty private workspace | Human Return to agent | Complete return after authority validation without requiring page DOM. |
| Stale target on act/observe | Act/observe | Report missing/stale target; never redirect the action to another page. |

An explicitly closed logical workspace can be replaced through normal open. A
missing tab in a still-open workspace does not require close/open bookkeeping.
Neither path changes another thread's pages or deletes the shared profile.

## Design and implementation boundaries

### 1. Ensure on explicit open

Move empty-target handling into the existing daemon open path, before mandatory
selection. Create at most one replacement per admitted request, serialized through
existing locks. Preserve existing session limits and request receipt deduplication.
Do not make observe, media attachment or status polling create pages.

Allow the service to admit a fresh open across a boot mismatch under agent
authority. Reuse generation/boot fencing and invalidate old targets, references and
media grants. Do not weaken fences for other operations. A caller-provided old
target must never be reinterpreted as the newly created page.

Update the existing agent tool descriptions to describe a persistent browser and
open-as-ensure. Remove the blanket ephemeral close/open recovery advice. No new
agent tool, recovery planner or prompt-vocabulary tests.

### 2. Check process and channel health at the daemon owner

A stored shared root is not proof that Chrome is alive. Before explicit open:

- For an exited Bud-owned process, discard handles tied to that process and launch
  a replacement using the same profile under the existing profile lock. Invalidate
  old workspace targets/capture state; preserve private intent and saved hints.
- For a live owned process with a broken command channel, allow one bounded
  reconnect and read-only inventory check against its verified endpoint. Preserve
  healthy tabs. Do not kill a shared live process just to repair one workspace.
- If health cannot be established, return a specific failure. Do not loop or adopt
  arbitrary Chrome processes/endpoints.

First reproduce the original failure with a disposable profile to determine where
fresh open stalls. Keep connection/creation work within the outer request budget
and record its stage. Do not infer that native tab close always means process exit.

A timeout after a create/navigate/click may have taken effect. Keep that receipt
unknown; do not retry its mutation automatically. A later explicit open is a new
request and must inspect current inventory before creating another page. Preserve
known ownership; do not claim a foreign tab merely because its URL matches.

### 3. Make optional recovery and empty private control usable

Missing or fully filtered hints are a normal zero-page recovery result. Under the
existing explicit acquire/reopen operation, keep a usable blank page, install the
controller and renew normally. Show a concise informational result rather than a
failed takeover. Do not ask the user to take control twice.

Do not equate every recovery error with zero pages: corrupt/unreadable checkpoints
need a distinct warning and must not be overwritten as valid empty data; partial
creation or timeout remains uncertain and requires inventory reconciliation before
another restore. Do not consume recovery hints before validating prerequisites.
Return an accurate restored count/status without exposing saved private URLs.

Return to agent must work when inventory confirms there are no thread-owned pages.
Keep authority/drain validation and reference invalidation; skip the impossible DOM
observation in that case. For a nonempty workspace retain the current return checks.
A genuinely failed private transition stays paused, but the existing control UI
must offer a usable reacquire/return path even with no frame.

Keep empty, reconnecting and failed states distinct in existing viewer copy. Never
reuse private frames across authority changes to hide an empty or failed state.

## Ownership and impacted contracts

The persistent profile/process belongs to the Bud; pages belong to a thread's
workspace; private authority remains browser-wide. Resolve the authenticated
viewer and authorized Bud/thread/workspace before status, control or media access.
Agent admission retains invocation ownership/fences. Existing rows retain owner
stamping. No global lookup, new table or schema migration is expected.

- Existing browser command/result behavior changes; document in `docs/proto.md`.
- Prefer existing envelopes with a small explicit optional recovery result; avoid
  a new state machine, endpoint family, event stream or recovery database.
- Existing waiting/continuation and media paths remain the integration points.
- No personal-browser attachment, session-history restoration, WebRTC, profile
  reset, automatic last-URL guessing or broader terminal/SSE work.

## Implementation sequence and validation

1. Reproduce closed-tab, dead-process and channel failures with disposable Chrome;
   add targeted lifecycle tests, then repair ensure-open and service admission.
2. Fix zero-page restore/return and viewer presentation using existing authority.
3. Run actual-agent acceptance and update the affected specs/roadmap.

Required checks:

- Close only the thread tab, then open a URL with the actual agent; repeat without
  a URL. Check both with another thread's tab still open.
- Separately close a native window, quit Chrome, and restart the daemon. Record
  process/channel state rather than treating these as equivalent events.
- Break only the command channel while the process stays alive; verify bounded
  recovery, profile preservation and unaffected other-thread tabs.
- Two concurrent opens and repeated request IDs produce no duplicate owned page.
  Unknown create/navigation is not silently replayed.
- Restart with agent authority: explicit open succeeds; old references fail.
- Restart/private control/empty pages: agent waits; authorized return works; neither
  missing hints nor process replacement releases privacy automatically.
- Valid empty/filtered hints produce usable blank control. Corrupt hints are
  preserved and reported. Partial restore is not blindly repeated.
- Viewer attachment/status never launches pages; minimized capture still works
  after creating a replacement; authority changes revoke old media grants.
- Unauthorized viewer/foreign thread/foreign target cannot inspect, restore or
  replace pages. Add the validation item to the auth checklist if routes change.
- Repeat the reported thread sequence in a fresh test thread: observe interruption,
  fresh open, restart, empty recovery and resume. Verify tool pairing and sign-ins.

Diagnostics should identify request/session, operation stage, channel failure
category and owned-process exit status. Do not log URLs, cookies, profile content,
page text or input. No per-frame logging expansion.

## Spec files to update during implementation

- [x] `bud/src/browser/browser.spec.md`: explicit-open and process/channel recovery.
- [x] `service/src/browser/browser.spec.md`: restart admission, zero-page recovery and return.
- [x] Relevant agent and web browser folder specs for changed contracts/copy.
- [x] `docs/proto.md`: request/result and freshness semantics.
- [x] Phase 3l and roadmap: superseded mandatory recovery behavior and acceptance.

## Rollout

Full behavior requires updated daemon and service/web. No new request variant or
migration. New service/old daemon retains known failure handling without mutation
replay. Old service/new daemon retains restrictive restart admission and ignores
additive recovery fields; its media relay rejects empty markers and ends that
stream as it previously did for empty workspaces, without breaking control.
Do not reset profiles or clear private state during rollout.

## Validation results

- Real Chrome: manager lifecycle/private return/process replacement, request receipt
  deduplication, channel repair, workspace isolation, optional/corrupt hints and
  minimized static-idle capture fixtures passed. Closing a native target requires
  awaiting its disappearance in the fixture, not replaying the close.
- Service: control/media tests and isolated database repository/continuation tests
  passed, including restart generation fencing and usable zero-page private control.
- Web: media and mounted viewer tests passed, including empty-frame clearing and
  retaining inline Return to agent with no page.
- Service/web production builds passed; Rust formatting passed. The web build
  still reports its existing large-chunk warning.
- Actual-agent/native-window/restart matrix and two-user browser acceptance above
  remain manual gates. The original 30-second open stall is not reproduced; the
  confirmed empty-target/recovery defects are fixed without claiming its cause.

## Failed-takeover acceptance follow-up

The existing real thread retained private intent from a failed pre-fix acquire, but
its viewer never owned a controller. Its retry parked correctly while the inline
Return button was disabled. The viewer now offers explicit acquire-then-return for
recoverable paused/private workspaces, including after restart, using existing
endpoints and the fresh acquired revision. Competing viewers remain protected;
failed transitions stay private. Successful status reads clear transient status
errors. Mounted regression coverage passes. The user confirmed the real thread worked after the follow-up below.
This follow-up only requires updated web assets.

## Return receipt and recovery presentation follow-up

The service acknowledged Return, but resumed model calls misread the deferred
action error as continued private control. Deferred results now distinguish
`executed:false` from a returned handoff receipt and explain fresh target discovery
and explicit URL opening for a blank workspace. Historical results remain intact;
new calls retain live authority checks. The user confirmed the subsequent retry
worked. Durable continuation/replay tests and service build pass.

Recovery UI presents one primary action (Return when needed, otherwise Reopen
saved pages or Take control) and Dismiss/Conversation. More options holds alternate
recovery, restoration details, thread close and confirmed Bud-wide Stop/Reset.
All nine mounted viewer tests and TypeScript checks pass. No additional protocol
or migration changes for these follow-ups.
