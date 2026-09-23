# Design: Automatic browser recovery and complete URL checkpoints

Status: scoped, not implemented. Updated 2026-09-23.

## Objective

When the managed browser is lost, Bud restores the thread's pages automatically
on the next browser use. The user does not need to repair control, choose Reopen
saved pages, or send an extra message merely to make the viewer work. Website
sign-ins continue to use the existing persistent profile.

This proposal replaces the explicit recovery and restart-private-intent rules in
[Phase 3l](../plan/bud-owned-browser/phase-3l-tab-and-history-recovery.md) and
[Phase 3p](../plan/bud-owned-browser/phase-3p-empty-workspace-recovery.md).
Those documents describe current behavior until this design is implemented.
It retains the shared profile and thread workspace model from
[Phase 3k](../plan/bud-owned-browser/phase-3k-shared-persistent-browser.md).

Related implementation: [daemon spec](../bud/src/browser/browser.spec.md),
[service spec](../service/src/browser/browser.spec.md),
[web viewer spec](../web/src/features/browser/browser.spec.md),
[mobile contract](../plan/bud-owned-browser/mobile-viewer-contract.md).

## Current problem

The service persists Bud-wide private intent independently of live controller
leases. After a daemon restart, an old private latch can block the agent even
though the browser and controller are gone. The viewer's Return path acquires a
new workspace and returns it, but does not restore saved pages. Restoration is a
separate private `reopen_pages` operation.

The daemon's `recovery.rs` also excludes every URL with a query or fragment.
Consequently ordinary search pages, article identifiers and SPA routes can be
missing from `bud-pages.json`. Current checkpoints follow successful operations
and graceful shutdown; they are not a guarantee of the latest committed URL after
a crash or client-side navigation.

These are separate concerns that should have one normal recovery path: process
health, page reconstruction, and current control authority.

## Product contract

| Situation | Behavior |
| --- | --- |
| Service restart or temporary network loss, browser still alive | Reconcile existing runtime; preserve tabs and private protection. Do not restore URLs or infer a return. |
| Confirmed managed-browser loss, including normal daemon restart | Invalidate old controller leases, proofs, media and references. Old private control ends; reconcile fresh authority before admitting work. |
| Agent next uses an agent-visible workspace | Ensure it exists, restore saved pages and selection once, then require fresh observation before page actions. |
| User opens an agent-visible viewer after restart | The viewer automatically ensures the workspace and displays its restored page. No recovery menu. |
| Agent explicitly opens a new URL | The supplied URL wins; do not first load an obsolete saved page merely to navigate away again. |
| No usable saved URL | Open the explicitly requested URL, otherwise provide an empty workspace. Create a blank target only when needed by open/input. |
| Restored URL redirects, expires or requires login | Show the actual resulting page; let the agent inspect it and request help normally. |
| User explicitly closed the logical workspace, deleted its thread, or stopped/reset the browser | Respect that intent; background recovery must not reopen it. A later explicit authorized open follows normal lifecycle rules. |

Recovery is lazy per workspace, not a launch of every saved tab at daemon startup.
An already visible pane counts as demand. Inventory GETs, background polling and
hidden mobile viewers do not launch Chrome. The active viewer makes an authorized,
idempotent ensure request; this is an internal API operation, not a user button or
new agent tool. Existing agent admission calls the same recovery coordinator.

A daemon boot change alone is not proof Chrome died: a crashed daemon can leave
Chrome running. Verify and close the old owned process before replacing it using
existing process/profile safeguards. If ownership or exit is uncertain, report a
specific runtime error and keep private access fenced. No arbitrary process
adoption or automatic profile reset.

## What private control means

Keep one human-control mode: **while the user controls the browser, the agent
cannot observe or operate it**. Do not add a separate ordinary-control mode in
this phase. All threads share the Bud-wide fence and only the authorized
controlling viewer receives private frames and sends input.

Private control combines several responsibilities that must remain distinguishable
in code and recovery decisions:

| Responsibility | Contract |
| --- | --- |
| Exclusive input | One human controller; agent browser actions wait. |
| Observation privacy | Agent snapshots/screenshots and other viewers' private frames are blocked. |
| Transition fencing | Old commands, input queues, observations and media cannot cross authority changes. |
| Continuation | Browser-dependent work parks durably; other chat and non-browser work can continue. |
| Disconnect protection | Loss of a lease or connection does not expose a still-live private browser. |
| Explicit return | Acknowledged Return allows the agent to see the resulting page and reconsider pending work. |

This is not incognito, account isolation, or a host security sandbox. Cookies,
sign-ins and Chrome history persist and are shared across threads. Return can
expose authenticated page contents. Bud's browser interface enforces the boundary;
it does not isolate Chrome from unrestricted terminal access or prevent physical
interaction with the native window.

## Private pages and restart semantics

Separate live controller authority from the data eligible for automatic recovery.
A destroyed browser has no human controller to return from. A still-live browser
keeps its private protection across connection loss, even when its input lease
has expired. Confirm runtime loss before releasing the old private fence.

**Initial scope: retain one agent-visible recovery checkpoint per workspace.**
Separate persistence/restoration of unfinished private browsing is deferred.

- While the browser is agent-controlled, checkpoint its observed URLs and selection.
- Before private input is acknowledged, drain prior page work and flush the last
  agent-visible checkpoint. Freeze checkpoint updates across all workspaces while
  private or paused-private control is active. Tag/fence queued navigation events
  and writes so private data cannot enter a delayed public checkpoint.
- Do not add private URLs, private selection changes or private target closures to
  Bud's recovery manifest. Chrome may still retain them in its own profile/history;
  Bud neither imports that history nor promises its erasure.
- Successful explicit Return checkpoints the now-disclosed page state before
  normal agent work resumes. A checkpoint write failure must not falsely report
  persistence; retain the previous valid checkpoint and surface recovery degradation.
- After confirmed runtime loss, discard extinct leases/proofs and resolve stale
  Return prompts. Automatically restore the last agent-visible checkpoint, if one
  exists, or use the normal explicit-URL/empty-workspace fallback.

There is no pending private checkpoint, parallel private restore flow, or
acquire-then-return recovery step. The user can Take control of the recovered
browser normally, but this does not restore an unfinished private page. If the
browser died during private work, show a concise notice that the last shared page
was restored (or that no shared page was available) and private page progress was
not recovered. An agent receives an
honest restart result, never a claim that the human completed the requested task.

The recovered address can be older than the last page the user visited. This is
an explicit scope tradeoff, not a guarantee to restore the latest private URL.
Website state is not rolled back: loading a previously shared URL may reflect
sign-ins or other changes made during private control. This design prevents direct
replay/disclosure of private URLs and captured content; it does not promise that
all consequences of private website activity remain invisible after browser loss.

Revisit private-page persistence only if preserving unfinished private work across
browser loss becomes a concrete requirement. That would require a separate
retention/disclosure decision, not another durable controller lease.

## URL saving

Store complete agent-visible observed HTTP(S) addresses, including query strings
and fragments. Private browsing follows the checkpoint freeze above.
Keep parameter order, repeated parameters, encoding and fragment routes; do not
strip tracking parameters, sort queries or substitute the origin. Record the last
committed top-level address, including redirects and same-document navigation,
rather than assuming the requested navigation URL is the final location.

Separate **saving an address** from **automatically loading it**:

- Accept bounded HTTP(S) URLs without embedded username/password. Keep internal
  Bud tabs, `about:`, `file:`, `data:`, `javascript:` and other schemes out.
- Query/fragment presence alone is never a reason to reject a checkpoint.
- Keep a narrow automatic-load exclusion for known callback/authorization and
  logout routes already excluded by the implementation. Save the complete address
  but mark it ineligible for automatic navigation. Do not invent broad parameter
  heuristics or claim to recognize every token or side-effecting GET.
- An ineligible or oversized selected address yields an explicit unavailable-page
  result; do not silently truncate it or show another tab as if it were restored.
  Other eligible saved tabs can still recover. An explicitly supplied URL remains
  subject to the normal browser navigation policy.

Full URLs can contain credentials or sensitive search terms. Keep checkpoints in
our existing owner/resource/environment-bound host profile with private file
permissions, atomic replacement and symlink protections. No URL mirror in service
rows, metrics, error strings or recovery receipts. Normal authorized observations
can reveal the current URL under existing privacy rules.

Retain the existing 32-workspace, 16-page and 256 KiB aggregate bounds. Raise the
per-URL bound from 2 KiB to 8 KiB to accommodate ordinary query/fragment routes;
validate the complete candidate before replacing the last durable checkpoint.
Oversize/corruption/disk errors preserve existing data and produce bounded status,
not a silent success or destructive profile repair.

## Capture and persistence

Reuse the existing checkpoint writer and workspace ownership mapping. Feed it
committed top-level navigation, same-document URL changes, owned target closure
and explicit selection changes from the existing CDP event plumbing. Coalesce
writes with a short bounded debounce (initially 250 ms), skip identical records,
and flush on successful agent-visible operation/control boundaries and graceful
shutdown. During private control, shutdown must not overwrite the frozen checkpoint
with current private inventory.
Do not poll DOM, capture screenshots, or write a record per media frame.

Checkpoint persistence is best effort against abrupt process/machine failure; the
last unflushed navigation may be lost. The private-transition flush/fence is the
exception: it completes before private input is acknowledged. Preserve the last
agent-visible address of a natively closed final tab as a fallback for the next explicit open; a native tab
close must not immediately recreate it. Explicit logical workspace close removes
recovery data. An unsupported current URL must not silently reuse an older URL
as though it were the current page.

## One recovery coordinator

1. Resolve authorized Bud/thread/workspace, desired state and current runtime.
2. Serialize recovery per workspace under existing browser locks. Recheck private
   authority, deletion and generation after any wait.
3. Reuse healthy owned targets. If the old process is gone, establish a fresh
   runtime generation and invalidate all old references and grants.
4. Restore eligible, authorized checkpoint URLs into newly owned targets once.
   Bind targets directly at creation; never infer ownership by URL/title/order.
5. Return bounded recovery status and fresh target inventory. Media attaches under
   newly validated authority. The agent takes a fresh observation before acting.

Do not delete the durable checkpoint before successful reconstruction. Track
created targets during a recovery attempt using existing workspace ownership and
request receipts. On timeout, reconcile known inventory before another attempt;
never blindly repeat uncertain create/navigation calls. Concurrent agent and
viewer ensures join or observe the same attempt, rather than create duplicate tabs.
If the process is subsequently confirmed dead, a new generation may load the saved
URLs again. No replay of clicks, form submissions, POST bodies or input queues.

Keep recovery results small: restored/empty/partial/unavailable, restored count,
and a canonical reason when needed. Do not introduce a browser event ledger,
recovery scheduler, separate history database or multiple recovery backends.

## Agent continuation and UI cleanup

Use existing invocation/action receipts and continuation machinery. After confirmed
runtime replacement, resolve waits caused solely by the extinct private controller
once, with an honest restart result—not “the user returned control.” Undispatched
work stays recorded as not executed; dispatched unknown work remains unknown.
The resumed agent must observe and reconsider rather than replay the parked action.
An explicit request for human assistance receives an interrupted-handoff result,
not fabricated task completion; the model can inspect and ask again if necessary.
Never resume completed/canceled runs or invent a new run merely because a viewer
opened. Cancellation and deletion win over late recovery completion.

Remove Reopen saved pages, Start blank workspace, and acquire-then-return restart
repair from the shared viewer. Remove the corresponding obsolete control operation,
wire command, tests and explanatory copy once ensure replaces them. Retain Take
control/Return for real live private work, Retry for genuine runtime failures,
and existing explicit Stop/Reset outside the normal recovery flow. Failed image
capture remains a media failure, not grounds to recreate Chrome or clear privacy.

Web and iOS use the same shared viewer lifecycle. Native visit credentials remain
workspace-scoped; old runtime media/control credentials are invalidated, while a
still-authorized mobile visit may obtain fresh runtime metadata. Hidden/background
visits do not restore pages or resume private input.

## Ownership, delivery and validation

The Bud owns profile/process; its thread owns the workspace; the authenticated
viewer or invocation supplies authority. Authorize before ensure, checkpoint use,
media attachment and result delivery. Browser writes retain Origin checks; native
uses the scoped visit principal. Lists remain owner-filtered in SQL. No new service
URL table is needed; retain owner/tenant stamping on existing rows and extend the
auth checklist for the new ensure path.

Implement in three coherent slices:

1. Version the local checkpoint format for full URLs and the agent-visible-only
   contract; add event-fed saving and private-transition write fencing. Existing v1
   hints lack trustworthy disclosure provenance: preserve the old file as a private
   migration backup, but do not auto-import its URLs. Start new checkpoints from
   verified agent-visible live pages. Document this one-time recovery-history loss;
   preserve unreadable files and never reset profiles.
2. Add the shared ensure/reconciliation flow and confirmed-runtime-loss authority
   reset, with existing continuation integration and unknown-action protection.
3. Switch web/mobile recovery to ensure; remove superseded reopen/control branches,
   update protocol, specs, mobile handoff and roadmap together.

Use a coordinated daemon/service/shared-web/mobile upgrade. Old/new runtime
pairings for the changed recovery contract are unsupported; no compatibility flags
or parallel reopen path. Document the one-time manifest migration. If implementation
needs a durable DB field, include its schema migration explicitly rather than hiding
it in a runtime fallback. Rebuild/prepare the matching browser add-on and restart
the development stack; upgrading alone cannot recover URLs never saved previously.

Required validation:

- Two threads retain distinct query/fragment URLs, duplicate addresses and selected
  tabs across graceful restart; shared sign-ins survive.
- Redirects, SPA pushState/replaceState, hash changes and native tab closure update
  checkpoints without frame polling. Abrupt exit uses the last durable checkpoint.
- Active viewer and agent recover concurrently without duplicate pages; inventory
  polls and hidden iOS visits never launch Chrome.
- Restart during private input ends the extinct lease without exposing private URLs
  or frames; restore only the frozen agent-visible checkpoint, or proceed fresh.
  Verify private navigation events, shutdown and delayed writes cannot overwrite it.
  Successful Return makes the resulting page eligible for later recovery.
- Network/service reconnect with live Chrome does not release private protection.
  A surviving orphan Chrome cannot be adopted or cleared solely by a new boot ID.
- Lost recovery acknowledgements, partial restore, dead process, corrupt manifest,
  disk failure, oversized URL and unavailable add-on produce truthful bounded errors.
- Pending waits resume at most once; canceled/completed runs stay stopped; unknown
  clicks/submissions never replay. Old target/controller/media proofs fail.
- Foreign owner/workspace requests are 404; close/delete/reset defeats racing ensure
  and removes retained hints; ensure cannot displace a live private controller.
- Local HTTPS and ngrok, web and real iPhone: open pane after restart without sending
  a message, correct fit, navigation and control, no Reopen action or reconnect loop.

Out of scope: exact Back/Forward or scroll restoration, forms/DOM/sessionStorage
serialization, separate private-page checkpoints/restoration, a second human-control
mode, detached Chrome supervision, WebRTC, personal-browser attachment,
and fixing unrelated terminal/network reconnect behavior.
