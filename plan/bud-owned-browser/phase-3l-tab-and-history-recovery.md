# Phase 3l: Recover tabs and history in the Bud-owned browser

Status: **Scoped; not implemented.** Depends on [3k](phase-3k-shared-persistent-browser.md).

## Objective and explicit guarantees

Retain useful browsing continuity without confusing saved profile data with live
page state. Shared sign-ins across threads and saved profile data are required in
3k. This phase adds restart recovery; native tab/Back history recovery is a target
to validate, not a guarantee implied by saving the profile directory.

| State | Contract |
| --- | --- |
| Cookies / local storage / site databases | Keep profile on disk; website expiry, session-cookie policy and account revocation still apply |
| Browsing history database | Leave Chrome-owned history intact; no new agent history-search API or service mirror |
| Live tabs and Back/Forward stack | Preserve when the same verified Chrome process survives reconnection |
| Tabs after Chrome exits | Prefer native session restore, only bind restored tabs with proven workspace ownership |
| Back/Forward after Chrome exits | Validate native restore on supported runtime; URL reopening alone does not restore it |
| Forms, JS heap, session storage, scroll, BFCache | Best effort where Chrome restores; never promise exact restoration |
| Requests, downloads, pending actions | No replay or inferred success; reconcile and observe before continuing |
| Controller leases / references / media tickets | Never restore as live authority; issue fresh bindings after reconciliation |

## Recommended approach and decision gate

First build a small real-Chrome fixture using the intended persistent launch mode.
Create two thread workspaces, duplicate URLs, redirects, a popup, Back/Forward
entries and a private paused state. Exercise clean Chrome exit, daemon-only exit,
crash and relaunch. Establish what the pinned runtime actually restores and how
to map tabs without guessing. Record evidence before adding recovery machinery.

CDP exposes live navigation history and navigation by entry ID, not a documented
general API for importing an arbitrary saved history stack. Do not rebuild history
by visiting every URL: that can repeat side effects and does not recreate page
state. See [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/).

Preferred order:

1. **Reuse a surviving, verified owned browser** across a transient service/control
   reconnect; this preserves actual tab state without restoration.
2. **Use Chrome's native session restore** after process exit if supported by the
   configured runtime and if ownership mapping is reliable.
3. **Bounded URL recovery fallback**: offer reopening the last saved eligible
   HTTP(S) pages into the correct workspaces, clearly stating that Back history and
   unsaved edits were not restored. Do not silently navigate private/auth callback,
   POST/resubmission or otherwise uncertain pages. Require user recovery where
   safe automatic restoration cannot be established.

If reliable native restore plus tab ownership cannot be implemented narrowly,
ship profile persistence with explicit limited tab recovery and document the gap.
Do not silently drop the desired tab/history experience. A separately scoped
detached browser supervisor is the alternative if daemon-restart live continuity
is required; it is not the default addition to this phase and does not solve Chrome
crashes. Avoid reusing the PTY holder abstraction for browser control.

## Stable tab identity and minimal local state

Treat CDP target IDs as runtime identities, not durable tab IDs. Retain a small
versioned, atomically written host manifest: profile identity, browser generation,
workspace IDs, logical tab IDs, selected tab, and the minimum recovery metadata
needed by the proven strategy. Private permissions; no form values, snapshots,
screenshots, clipboard or full history serialization. URLs are sensitive even
without explicit credentials; keep any necessary URL fallback data host-local,
bounded and out of logs/service inventory. Do not embed thread IDs into site URLs
or page-readable storage as ownership markers.

The implementation gate must prove an authoritative native-restored-tab mapping.
Do not match by URL/title/order, because duplicate pages, private tabs and reordering
make those ambiguous. Unknown restored tabs stay unassigned and agent-invisible;
the user can explicitly recover/adopt them in a future or narrowly scoped recovery
UI. Persist close/delete tombstones so native restore cannot resurrect a deleted
workspace into agent access. Reconcile with authorized service state before exposing
any restored target; offline startup cannot grant access from a local manifest alone.

The service owns workspace authorization; Chrome owns site/history state; the
manifest owns only local recovery hints. No second history database or append-only
browser event ledger. Bound writes and coalesce updates rather than writing every
frame or DOM change. Corrupt manifests fail closed without deleting the profile.

## Recovery ordering

1. Verify profile lock, account/claim binding and executable/process identity.
   Never adopt an arbitrary loopback endpoint or kill an unverified process.
2. Restore persisted browser-wide private intent before accepting any observation,
   capture or input. A private browser stays paused after restart even if the
   original thread was deleted; only explicit user return/reset clears the latch.
3. Reconcile authenticated Bud, browser resource and live workspace/deletion intent.
4. Inventory verified targets and bind only proven ownership. Browser process
   replacement advances generation; transport reconnect invalidates stale command
   bindings without pretending the still-live page was recreated.
5. Refresh viewer metadata and grant fresh media/controller authority. Old recovery
   proofs must not acquire control of a new browser generation.
6. Let existing invocation recovery account for unknown actions. Never rerun a
   submission because a restored page resembles its pre-action state. Browser
   readiness does not automatically resume private waits or create a new task.

Keep the UI distinctions small and truthful: reconnecting to a live browser,
restoring pages, recovered with limited history, and unable to restore. Do not
show a reusable profile as an irrecoverably ended browser merely because daemon
boot ID changed. Conversely, saved sign-ins do not imply the old tab is alive.

## Retention, deletion and shared-account considerations

- Thread deletion removes its recovery records and tabs, not shared cookies or
  the Chrome history database. Full reset removes both profile and manifest.
- Signing in/out or switching accounts in any thread affects all threads; agents
  should freshly inspect account-sensitive state before acting, not assume that
  a previous thread's account is still selected.
- Persistent background pages may perform network work after restoration. Private
  mode fences Bud agents; it does not stop the website's own scripts.
- Browser crashes affect all workspaces. A failed snapshot/helper call should not
  destroy the shared profile; separate recoverable tool errors from process loss.
- Keep Chrome version/channel consistent. Do not automatically downgrade or
  copy a live profile. Disk-full, corrupt-profile and locked-keychain recovery
  should preserve evidence/data and offer explicit reset, not silent fresh login.
- No cross-machine portability, backup service or secure-erasure guarantee.
  Chrome profiles can contain sensitive data and encryption keys can be OS-bound.

## Acceptance and delivery

Validate clean daemon restart, clean Chrome exit, service-only restart, browser
crash, forced daemon exit with surviving Chrome, duplicate launch, reboot and
offline reconnect. Test two threads with identical URLs, popups, native tab close,
history Back/Forward, account changes, deleted threads, private takeover interrupted
at each boundary and a fresh owner attempting to reuse old profile data.

Record separately: login retained, correct tabs mapped, history retained, unsaved
state lost, no duplicate mutation, no private disclosure. Use synthetic login and
POST fixtures; do not export real profiles or private history into test artifacts.

Update daemon/service/browser/helper/web specs, restart reconciliation and
docs/proto.md as behavior changes; add owner/recovery cases to the auth checklist.
Any new DB state needs schema/migrations and owner/tenant stamps as in 3k. Keep local
manifest URLs out of browser-facing routes; existing authenticated ownership checks
apply before inventory, restoration choices and media. No compatibility scaffolding
for the unreleased browser feature; update the local stack together.

## Won't-dos

No Chrome session-file reverse engineering, URL-by-URL history replay, DOM/form
serialization, arbitrary process adoption, synthetic restoration of old target IDs,
background mutation retries, automatic resubmission, cross-Bud synchronization,
full history search, extension-based persistence or mandatory detached supervisor.
