# Phase 3k: One persistent browser per Bud

Status: **Shared persistent runtime implemented for macOS; acceptance gates below remain.**
Exact live-tab/back-forward restoration remains [Phase 3l](phase-3l-tab-and-history-recovery.md).

## Implementation checkpoint

- Production daemon uses one owner/environment/resource-bound persistent profile
  and Chrome process, with separate per-thread CDP/helper workspaces. Cookies/site
  storage are shared; observations, target references, fitting and assigned tabs
  are scoped. Verified opener popups inherit ownership; unknown native tabs stay hidden.
- Service `browser_resource` owns global private intent and authority, separate
  from per-workspace invocation ordering. Takeover fences both threads and all
  passive media. Explicit acknowledged return resumes eligible durable waits;
  canceled/deleted/retired work remains terminal. Chat and terminal remain usable.
- Graceful shutdown drains page work and confirms owned process exit. Profile lock
  and contents survive/release appropriately. Existing Chrome singleton locks are
  not removed; uncertain surviving processes require explicit recovery.
- Bud-level Stop/Reset is exposed in the viewer menu and ended state. Intent stays
  pending offline until exact daemon acknowledgement. Stop retains profile/privacy;
  Reset deletes stored data only after confirmed exit and explicit confirmation.
- Claim/owner/device-secret changes retire the resource, including same-owner
  reclaim; subsequent resource identity selects a fresh profile. Old data is quarantined.
- Migrations 0044–0046 are generated and applied locally. 0046 retires old ephemeral
  sessions and removes copied workspace privacy/control/profile fields. Unused groundwork control/binding APIs were removed; fixtures now use the
  production control repository. No import
  or backward compatibility is needed for this unreleased browser feature.
- Concrete bounds: two active workspaces, 128 identities/tombstones, 16 returned
  target entries per workspace, one shared FIFO page-operation/capture lock;
  existing bounded media groups/viewers/credit remain. Returned inventory is bounded;
  website-created popup count is not currently a hard process resource quota.

## Validation

- Service browser suite: 28 passing tests, including isolated PostgreSQL lifecycle,
  ownership, continuation and migration fixtures; schema metadata test passes.
- Real disposable Chrome fixtures pass shared cookie/tab/helper isolation,
  workspace-only close, global private fencing and acknowledged stop/reset. Existing
  live manager coverage passes cancellation/reconnect/media/renewal cases.
- Web browser render tests pass, including lifecycle reset confirmation, pending
  status versus stale polls and discarded late responses after Bud switch.
- Service TypeScript, web production build and daemon build pass. Web retains its
  existing large-chunk warning. See [validation notes](../../debug/bud-browser-phase-3k-schema.md).

## Remaining acceptance gates

These are not claimed complete by the disposable-profile tests:

- Real macOS sign-in: thread A logs in, B uses the same sign-in, graceful daemon
  restart retains it. Verify normal Chrome native credential-store behavior with
  denied/locked keychain and unattended launch before real-account rollout.
- Linux persistent runtime remains explicitly unavailable until Secret Service /
  native-store support and failure behavior are implemented and validated. There
  is no silent basic/plaintext fallback.
- Real two-account cookie-auth/Origin checks, offline reset UI and takeover during
  concurrent agent activity; synthetic ownership/privacy fixtures already pass.
- Disk-full/profile corruption/Chrome upgrade and hard-crash surviving-process
  recovery require host acceptance; no blind process attachment is implemented.

Use updated service and rebuilt daemon together. Existing local ephemeral sessions
are closed by the migration; open a new workspace and sign in to the new profile.
The running user's daemon and native Chrome were not restarted by these tests.

## Product decision

Each Bud owns one managed browser and persistent profile on its machine. A user
signing into a site from thread A should be signed in when thread B opens that
site. Threads own tab workspaces, not isolated browser profiles. Shared login,
logout, account selection, site permissions and site storage are intentional.
This does not attach to or import the user's personal Chrome profile.

This plan supersedes earlier per-thread/ephemeral profile defaults in the
[parent design](README.md). The unreleased browser feature does not need compatibility
branches; service, daemon/helper and web change together.

Related specs: [daemon](../../bud/src/browser/browser.spec.md),
[helper](../../bud/browser-helper/browser-helper.spec.md),
[service](../../service/src/browser/browser.spec.md),
[web](../../web/src/features/browser/browser.spec.md).

## Recommended architecture

| Owner | Responsibility |
| --- | --- |
| Bud browser resource | Persistent profile identity, process generation, global private-control state and recovery status |
| Thread browser workspace | Tab membership, selected tab, pending agent actions and thread-scoped viewer entry |
| Daemon | Profile directory, exclusive process ownership, target membership enforcement and execution |
| Service | Authenticated ownership, durable browser/workspace IDs, handoffs and invocation receipts |
| Viewer | Presentation and private input under a current controller lease |

Introduce one owner/Bud-scoped browser record; retain the current browser_session
as a thread workspace if that is the smallest migration. Do not make a shared
browser row pretend it has one owning thread. The thread route can continue to
resolve a workspace; its browser relationship supplies shared control state.
Persist global private intent once, not as copies on each workspace.

Use one Chrome process with one regular persistent context. Separate incognito
contexts per thread would defeat shared sign-in. Use the existing automation
helper, with observation/reference state keyed by workspace/target rather than
one global snapshot that another thread can invalidate. Filter inventory before
returning it and validate target membership before every action, observation,
capture, fit and helper call. An arbitrary supplied target ID grants no access.

A popup inherits its verified opener's workspace, including OAuth redirects.
Targets without provable ownership remain unassigned and hidden from agents;
never guess ownership from URL, title or whichever thread acted most recently.
Workers/background targets are not selectable pages. Explicit user adoption of
unassigned native tabs is later work; never close them as another thread's tabs.
Audit opener/window relationships and same-origin cross-tab interaction: tab
membership is automation routing, not a web security boundary between threads.

Keep the existing bounded page-operation serialization initially, now at the
shared browser boundary, with authority renewal independent of page work. Bound
workspaces, tabs, viewers and aggregate capture load instead of retaining the
two-process limit. Choose concrete limits from a two-thread fixture before merge;
do not introduce a new scheduler. Fit is per target/workspace, not global browser
window size. Verify operations on one target do not focus/resize another.

## Persistence and process ownership

Store the profile under Bud's persistent base directory, bound to service
environment, Bud identity and owning account/claim generation. Do not derive paths
from user input or reuse a profile after re-claim by another owner. Use private
filesystem permissions; keep cookies, history and credentials on the host.
No profile bytes travel through the service or provider context.

Hold an exclusive local lifecycle lock for the profile. Concurrent opens converge
on the same process. Duplicate daemons fail with a clear profile-in-use error;
never delete Chrome lock files or attach by an arbitrary PID/port. Startup probes
use disposable profiles, not the real user's profile.

In 3k Chrome remains daemon-owned: graceful shutdown requests browser exit and
waits a bounded interval for storage flush before escalation. The profile survives
even when the process does not. Startup checks for a surviving verified owned
process and fails safely if ownership is uncertain; no blind kill or second launch.
Durable process attachment and tab recovery are 3l, not prerequisites for saved
cookies. No guarantee that sites keep session cookies or accept every saved login.

Remove development mock/basic credential-store flags for persistent profiles.
Validate supported Chrome distribution and OS credential storage on macOS/Linux,
including locked keychains, unattended startup and denied prompts. Missing secure
storage must be explicit; do not silently downgrade to plaintext storage. This is
an acceptance gate before persistent real-account use, not a later cleanup item.
Do not promise passkeys or OS password dialogs through the viewer.

## Browser-wide private control

Takeover fences **all agent browser reads and mutations on this Bud** and revokes
all passive media, including other threads. Only the current private controller
may receive frames/input for its permitted workspace. Shared authentication makes
per-thread private fencing insufficient. The UI states that browser work on this
Bud is paused; unrelated chat and terminal remain available.

Promote existing private state, lease and media revocation to browser scope.
Keep per-invocation fences separate: a new turn in thread A must not invalidate
thread B's commands or passive media. Define one lock order (browser authority
before workspace/invocation rows) and audit existing thread-first transactions;
do not add a new parent lock after old child locks. Concurrent acquire/return and
new workspace creation must see the same durable global pause.

Fence new dispatch immediately; drain already dispatched bounded actions and
discard observations whose authority was revoked. A previously submitted site
action cannot be undone. Park only undispatched browser calls through existing
durable waits; do not stop every LLM turn or nonbrowser task preemptively.

Return to agent clears the acknowledged global pause and makes eligible waiting
invocations across threads runnable through the existing scheduler. Canceled,
deleted or completed runs stay terminal. Resume with fresh observations rather
than replaying stale actions. Stopping one waiting run does not release private
control or cancel other threads. Lease expiry, viewer loss and service/daemon
restart never silently return control; persist the private latch before enabling
input, and restore it before admitting browser operations after restart.

This is cooperative Bud-tool privacy. Already-loaded sites and service workers
can continue running, and privileged terminal/native input bypasses the broker.
Do not claim process isolation or freeze JavaScript across the profile. After
explicit return, shared signed-in account data is intentionally agent-accessible.

## Lifecycle and user controls

| Action | Effect |
| --- | --- |
| browser_open | Ensure shared browser and this thread's workspace/tab |
| browser_close | Close this thread's owned tabs/workspace; keep profile and other threads |
| Viewer dismiss / end of turn | Keep tabs/profile; existing private pause semantics remain |
| Thread deletion | Revoke workspace access and close only its tabs, including after offline reconnect |
| Stop browser (Bud-level human action) | Stop all browser work/processes, retain profile; clearly identify affected threads |
| Reset browser data (separate human action) | Revoke access, stop process, delete profile and recovery records with explicit confirmation |
| App sign-out | Revoke viewer access; does not silently erase host website sign-ins |
| Bud unclaim / ownership change | Revoke automation, quarantine old-owner profile; never expose it to the new owner |

Closing/deleting a thread cannot selectively undo its cookies or site history in
the shared profile. Explain that separately from deleting its chat. Reset must
handle an offline Bud as pending, not report deletion before daemon acknowledgement.
Website logout remains the site's operation; no automatic account switching.
Downloads, notifications, permissions, disk usage, browser updates and profile
corruption now affect the whole Bud. Keep existing download restrictions; add no
automatic permission grants, extension installation or Chrome Sync.

## Implementation and debt removal

1. Add browser-level resource/authority and migrate workspace relationships; keep
   owner/tenant stamps and SQL-scoped lists. No globally visible inventory.
2. Replace per-thread process/TempDir ownership with a single manager/profile.
   Refactor target and snapshot ownership before enabling shared-profile traffic.
3. Move handoff admission, private media fencing and recovery to browser scope;
   retain existing receipts, wait continuations and media credit.
4. Update tool semantics, viewer status and close/reset controls together.
5. Remove superseded per-thread launcher, ephemeral cleanup and copied control
   state. Keep ephemeral profiles for tests only. Update specs/protocol, not just
   add adapters around both lifecycle models.

Existing local ephemeral sessions are explicitly retired during cutover. Do not
merge profiles/cookies or infer old tab ownership. Users sign in once to the new
profile. Add checked-in migrations plus local push; validate migration on a
pre-change database. Browser rows inherit Bud owner/tenant; workspace rows inherit
matching thread/Bud ownership. Routes resolve the signed-in viewer and owned Bud
before resource access, and all media/dispatch rechecks authority.

## Acceptance

- Sign in with A, access the same site with B, restart daemon and verify retained
  persistent test cookie/storage and site login where supported.
- Two threads open concurrently: one process/profile, separate tabs, correct
  popups, no foreign target observations, no cross-thread snapshot invalidation.
- Close/delete A; B and sign-ins survive. Global reset and ownership changes
  cannot restore old data. Offline deletion reconciles before workspace access.
- Takeover during A/B activity, delayed capture, new thread admission, concurrent
  return, controller loss and restart: no new private evidence reaches either
  agent. Return wakes eligible waits once; Stop affects only the requested run.
- Service-only reconnect preserves live tabs, while browser restart invalidates
  all stale references/input/tickets. Real two-account authorization checks pass.
- Verify secure storage, duplicate-daemon rejection, disk-full/permission errors,
  Chrome upgrade behavior and aggregate capture/terminal latency under two threads.

Specs to update on implementation: root/daemon/browser/helper, service browser/
agent/DB/migration specs, web browser, docs/proto.md and auth validation checklist.
The implementation and outstanding host acceptance are recorded above.

## Won't-dos

No personal-browser attachment, multiple named profiles per Bud, cross-Bud cookie
sync, cookie copying between contexts, cross-thread automatic tab reuse, new
tool family, generic scheduler, WebRTC, OS automation or backward-compatibility
branches for this unreleased feature. Exact tab/history restoration is 3l.

## Primary references

Chromium documents exclusive user-data-directory ownership and profile contents:
[user data directories](https://github.com/chromium/chromium/blob/main/docs/user_data_dir.md).
Its Linux credential-store documentation identifies basic storage as plaintext:
[password storage](https://chromium.googlesource.com/chromium/src/+/master/docs/linux/password_storage.md).
Target ownership can use CDP opener metadata/events, subject to pinned-runtime
validation: [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/).
