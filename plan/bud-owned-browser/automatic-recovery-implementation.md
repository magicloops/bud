# Automatic browser recovery implementation

Implements [the approved design](../../design/browser-automatic-recovery.md).

## Ownership and scope
The Bud owns the process/profile, the thread owns its workspace, and the acting
viewer/invocation is resolved through existing owner-scoped repositories. Ensure
is an Origin-protected workspace write, including scoped mobile visits. Inventory
reads never launch Chrome. Existing owner/tenant stamping remains unchanged.

## Implementation
- [x] Version checkpoints, preserve complete URLs, separate autoload eligibility.
- [x] Fence all checkpoint writes during private control; flush before acquire/return.
- [x] Save committed URL changes through bounded CDP events.
- [x] Share lazy ensure between agent admission and visible viewers.
- [x] Reconcile confirmed runtime loss and pending continuations truthfully.
- [x] Remove explicit reopen and acquire/return restart repair.
- [x] Update protocol, specs, mobile contract and authorization checklist.

## Validation and rollout
Test URL round trips, migration/error preservation, privacy fences, restart/partial
recovery, stale actions, owner isolation and hidden viewer behavior. Run targeted
Rust/service/web tests and builds. Real iPhone/ngrok acceptance remains a device
check. Coordinate daemon, service and shared web upgrades; rebuild the matching
browser add-on. Version 1 recovery hints are backed up without importing them;
cookies/profile data are retained. No new service URL storage.

## Verified locally

- Rust browser suite with disposable real Chrome: 56 passed, including ignored
  live capture/workspace tests. Subsequent focused live tests pass for atomic
  Return disclosure and native-final-tab fallback/partial checkpoint preservation.
- Service browser suite: 37 passed, 4 opt-in DB tests skipped in that invocation.
  Separate isolated PostgreSQL repository/resource/continuation tests: 3 passed;
  final broker/resource/mobile-auth regression run: 4 passed, including visit DB.
- Shared web/mobile mounted viewer suite: 12 passed. Service `tsc --noEmit` and web
  `tsc -b` passed. `git diff --check` passed.
- Tested full query/fragment persistence, SPA event capture, private write freeze,
  invalid Return non-disclosure, batch-write rollback, old-target/owner rejection,
  concurrent ensure, lost acknowledgement, honest restart continuation, cancellation,
  no stale action dispatch and hidden mobile no-ensure behavior.

## Remaining acceptance (not implementation blockers)

- [ ] Restart matching daemon/service with two real signed-in workspaces; open the
  pane without sending a message, verify public URLs/selection and shared sign-ins.
- [ ] Restart during private input: obsolete Return resolves as interrupted,
  public checkpoint restores, no private URL replay; surviving Chrome/network-only
  reconnect preserves protection.
- [ ] Physical iPhone and desktop over local HTTPS/ngrok: foreground/background,
  fitting, scrolling and control; two-account Origin/ownership/revoke races.

## Delivery

No service schema migration. Deploy service/shared web and daemon from this change
together and prepare the matching browser add-on; do not mix old recovery contracts.
The current native hosted-viewer bridge is unchanged. Version 1 `bud-pages.json`
is preserved as `bud-pages.v1.backup.json` without import; new public checkpoints
start with verified agent-visible pages. Existing sign-ins survive. No existing
service or daemon was restarted for this implementation.
