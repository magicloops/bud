# Debug: Closed tabs and empty browser recovery

Date: 2026-09-21. Status: implemented locally; user confirmed subsequent recovery; broader matrix pending.
Proposed fix: [Phase 3p](../plan/bud-owned-browser/phase-3p-empty-workspace-recovery.md).

## Environment and reproduction

Local macOS daemon, persistent headed Chrome, localhost HTTPS service/web viewer,
real agent. Thread: `07ac86c6-e63e-4daa-ade4-a4da220f7d6b`.
Evidence: supplied daemon logs, owner-scoped read-only local database queries of
this thread's messages/actions/browser state, and current browser source.

1. User closes a native browser tab.
2. Ask which page is open; agent attempts observation, close and fresh open.
3. Restart daemon and attempt viewer recovery, then ask the agent to reopen.
4. Viewer reports no eligible saved pages and requests takeover; agent waits.

## Recorded timeline

Times below are UTC on 2026-09-21.

| Time | Evidence |
| --- | --- |
| 21:58:03 | User asks which page is open. |
| 21:58:08 | `browser_observe(page_info)` returns `browser_outcome_unknown`. Daemon reports immediate `Target.getTargets` transport/decode failure, with zero received frames. |
| 21:58:11 | Subsequent snapshot returns `browser_interrupted`. |
| 21:58:14 | Agent `browser_close` completes successfully for `browser_01M2SRZBTFE2KD33FQQGT0F4ZM`. |
| 21:58:16–46 | Agent calls `browser_open` with `https://www.reddit.com/r/singularity/hot/`; it returns unknown after 30,015 ms. New workspace: `browser_01M32ZM619Y7SHEJ2NN4RP7Y0X`. |
| 21:59:09 | At daemon shutdown, target enumeration and browser close fail; recovery checkpoint is unavailable. |
| 21:59:19 | New workspace record is ready on the new boot/generation, but shared authority is paused with `private_content=true` and control operation `acquire`. |
| 21:59:35 | User asks to try reopening. |
| 21:59:40 | Agent's `browser_close` is parked as `waiting_for_user`, with `browser_dispatched=false` and a pending return-control handoff. |

The agent knew the URL and attempted a fresh open. The latest call was parked
before dispatch, rather than failing to reconstruct the URL. The quoted
`browser_recovery_unavailable; reopen` message is web viewer error copy, not the
recorded `browser_open` result.

## Confirmed pre-fix code behavior

- `bud/src/browser/manager.rs::perform` resolves an existing target before its
  `Open` branch. An empty workspace therefore cannot open a replacement page.
- Shared-root initialization tests whether the root is absent. Closing a workspace
  leaves that root present; this is not a health check for its process or channel.
- `service/src/browser/repository.ts::prepare` rejects commands other than close
  across a daemon boot mismatch, including an explicit fresh open with a URL.
- `service/src/browser/control.ts::acquireSession` acquires private control before
  attempting saved-page recovery. Missing hints cause failure/pause before the
  controller is installed. The UI loses control/media and asks for takeover again.
- Private authority is checked before boot recovery in agent admission. The
  resulting private latch parks subsequent agent browser calls, as in this thread.
- Adapter recovery hints are optional, filtered URL checkpoints. Workspace close
  removes them; a newly created workspace need not have any. `reopen_pages` treats
  missing hints as an error and consumes its in-memory hints before validating the
  blank workspace. A checkpoint is not a prerequisite for opening a supplied URL.
- Preparing return to the agent requires an existing target and observation, which
  also makes an empty workspace harder to release.
- Agent tool guidance still calls the browser ephemeral and recommends close/open
  after interruption, despite the persistent shared-browser architecture.

## Limits of the diagnosis

The initial browser-level transport failure does **not** prove that closing one tab
terminated Chrome. The supplied diagnostic combines transport and decode errors;
it does not identify child exit, socket closure or the underlying failure.
Likewise, the exact stage responsible for the 30-second fresh-open timeout is not
recorded. A retained unhealthy shared root is a candidate, not a proven cause of
that timeout.

The viewer message, authority state and acquire/reopen implementation support the
failed-recovery/private-latch sequence; a corresponding HTTP audit trace was not
available in the inspected evidence. Live profile files were not inspected or
modified, so absence of that workspace's saved hints is inferred from the reported
error and lifecycle, not independently verified on disk.

## Expected behavior and proposed fix

An explicit open should ensure a usable thread-owned page: reuse a healthy page,
or create one if absent, then navigate to the supplied URL. Optional saved-page
restoration must not block that operation. Preserve shared sign-ins and other
threads' tabs. Empty workspaces must remain returnable from private control.

Distinguish empty targets, failed transport, dead process and unavailable history
at their existing owning layers. Never auto-release real private authority or
replay a mutation whose result is unknown. See Phase 3p for the bounded design,
reproduction matrix and implementation/spec touchpoints.


## Implementation validation notes (Phase 3p)

- `cargo fmt --check` initially failed with rustfmt diffs in the new Rust blocks;
  applied `cargo fmt` before rerunning checks.
- `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --lib browser::adapter::workspace_tests -- --ignored --test-threads=1`
  initially failed at `assert!(a.targets().await.unwrap().is_empty())` immediately
  after `Target.closeTarget`. Chrome acknowledges close before inventory removes
  the target. The fixture now waits for observed removal (bounded to two seconds)
  before testing a missing-page open; production mutations are not retried.

Implemented explicit ensure-open, bounded owned-process/channel recovery, restart
generation admission, optional zero-page saved recovery and empty private return.
Empty media no longer masquerades as a disconnected browser. Tool guidance now
matches the shared persistent browser. See Phase 3p for test results and remaining
acceptance gates. All live fixtures used disposable Chrome profiles; the user's
service/daemon were not restarted and their persistent profile was not reset.

## Follow-up: return disabled after failed takeover (2026-09-21)

The 22:30:54 retry invocation was parked at 22:31:02, before browser dispatch.
The shared resource still had `paused/private_content=true`, operation `acquire`,
from the failed 21:59 takeover. No usable viewer controller was installed. This
explains the quiet daemon logs: its new ensure-open path was never reached.
The viewer's Return callback required local controller ownership, creating a dead
end for that retained private intent. Status GETs currently return 200; the quoted
“Browser unavailable” is viewer polling failure copy which was never cleared on
subsequent successful polls, not an agent tool result.

Fix: expose explicit Return for a recoverable paused/private workspace even without
local ownership. On that click only, acquire through the existing authorized
endpoint, then return with the acquired revision and the same viewer identity.
Never bypass acquisition, another viewer's controller, or daemon acknowledgements;
never resume automatically on mount/poll. Keep transient status failure separately
from control errors so successful polling clears only the former. No protocol or
service authority changes are needed.

Validation: all nine mounted viewer tests passed, including explicit orphaned-lease
return, competing controller refusal, duplicate click fencing, stale callback
rejection and status error clearing. Initial command `pnpm exec tsx --test
src/features/browser/viewer.test.tsx` failed with `React is not defined` because it
omitted the app JSX configuration; reran the package's render-test form with
`--tsconfig tsconfig.app.json`. No runtime JSX change was needed.

## Follow-up: resumed agent repeats private-control warning

At 22:40:35 UTC the service acknowledged finish_return with agent authority and
private_content=false. Two waiting invocations resumed serially and produced
refusals without new browser calls. Read-only conversation reconstruction confirms
both deferred results reached provider-native replay. The payload's only typed
status was ok=false/not_executed_due_to_browser_handoff; returned authority was
mentioned only in prose. This is an ambiguous model-facing result, not evidence
that the return failed. Blank workspace recovery does not itself navigate.

Make the deferred result explicitly report the acknowledged handoff outcome and
non-execution separately. Tell the agent to discover current targets without old
IDs and use explicit open for an empty/blank workspace. Preserve no automatic
mutation replay and live admission checks; the receipt describes the return event,
not a permanent grant. Validate durable pairing and transcript replay.

Validation: isolated PostgreSQL continuation test passes across all seven cases,
including exact returned-receipt replay with and without provider-native tool
calls. Service TypeScript build and git diff --check pass. Development service
auto-reloaded. Existing historical results were not rewritten and no agent run
was triggered; actual-model continuation acceptance remains to retest.

## Recovery screen simplification

The ended/restarted/interrupted screen exposed saved-page recovery, takeover,
return, thread close and Bud-wide stop/reset at once. Present one primary action
(Return when private authority needs release, otherwise Reopen saved pages after
restart or Take control for an interrupted recoverable workspace), plus Dismiss
or Conversation. Move alternate recovery, restoration details and destructive
controls behind More options. Missing sessions offer only dismissal/navigation.
This is presentation only: the resource remains the owner/thread-bound browser
session; the existing authenticated viewer and service authorization resolve all
operations. No new routes, data reads, owner stamps or authority transitions.

User acceptance: the subsequent real-thread retry worked. Recovery-screen simplification passed all nine mounted viewer tests, TypeScript and whitespace checks.
