# Phase 9: Data sources and sync feedback

Status: implementation in progress; mobile capture receipts and simple source entry implemented, acceptance checks open. Dependencies: phases 2–4. Parent: [implementation spec](implementation-spec.md).

## Outcome

Users connect Contacts, understand what is shared, and can tell whether a manual
refresh finished. This completes the phase-3 status requirement and replaces the
development settings layout. Health product features remain deferred.

## Navigation and controls

Provide a Data sources destination on mobile and web. Contacts shows connection
and OS-access status, collected field coverage, last completed sync, contact
count, browse/search, and agent access. Collection and agent/model access remain
separate permissions, explained in plain language. Keep immediate permission
saves with version/conflict handling from [the implemented change](immediate-permissions.md).

Mobile owns OS access and local collection. Web shows last server-known source
state and instructions for phone-only actions; it must not pretend to request
an iOS permission or start an unreachable phone scan. Put environment values,
source IDs, scan generations, queue diagnostics, quarantine and explicit repair
under Troubleshooting. Show a recovery action when needed rather than exposing
all recovery controls permanently. Turning collection off must accurately state
its queue/history effect; it does not imply server data deletion.

## Manual sync contract

Current Sync now only kicks the uploader; foreground notification separately
starts a Contacts scan. Replace that ambiguity with one observable operation:
request an ordinary incremental scan, persist it, schedule upload, then observe
its server publication. Do not call forced resync/reconciliation for ordinary
refresh: that suppresses additions and can invalidate this use case.

Use Checking for changes, Uploading, Processing, Up to date, and actionable
waiting/error states. Scope completion to this account/environment/source and
the scan captured for the operation. Later concurrent changes can remain pending;
never imply global instantaneous freshness. Local checkpoint success, raw ACK,
and published/queryable completion are separate facts. No-change scans can
complete without reporting a fictitious upload count. A successful prior sync
must not mask a failed current operation.

Serialize/coalesce repeated taps, retain durable queue identity on retry, and
withhold results after account/environment switches. Show waiting for network,
upload policy, sign-in or iOS opportunity when known. If a phase has no exact
progress denominator, show a stage rather than an invented percentage. Foreground
UI may poll bounded owner-scoped status; it must not own the only completion state.
Background execution timing remains best effort and requires device measurement.

## Ownership, contracts and rollout

Reuse authenticated source/status APIs and owner-stamped records. Any added
operation/status endpoint resolves the viewer before SQL reads or streams;
clients cannot select an arbitrary owner. Decide whether existing scan IDs and
status fields suffice before adding a persisted operation table. If needed,
define its ownership, migration and retention in the implementation patch.
Additive status fields must tolerate old clients; new clients show unavailable
status against old services rather than claiming completion. No daemon release.

## Acceptance and documentation

- [ ] Empty/no-change, multi-batch, slow publication and failed processing show truthful completion.
- [ ] Manual refresh of one new contact emits one eligible addition; repeated taps/retries do not repeat it.
- [ ] Offline/policy wait, partial ACK, missing manifest and reload retain accurate state.
- [ ] Account switch with an in-flight refresh cannot show another account's progress.
- [ ] Normal settings are usable without inspecting debug identifiers; recovery remains reachable.
- [ ] Web distinguishes last received information from current phone connectivity.

Update mobile TimelineCore/UI plans, web routes spec, personal-data spec and
protocol/auth checklists for any new status contract. Related checks: C7, M2–M7,
and UX1–UX3 in [validation](validation-checklist.md).

## Implementation evidence

Manual mobile sync now requests an ordinary incremental scan, saves its scan ID,
observation time and contact count in the existing atomic checkpoint, then checks
owner-authenticated publication status for that exact scan. Old checkpoints remain
readable. Local scan failures take precedence over previously published receipts.
Repeated concurrent capture requests share producer work. No wire or DB schema
change is required. Existing bounded status may omit old scans; the UI reports
unknown/waiting rather than claiming completion in that case.

Settings now exposes Data sources and Automations independently in both clients.
Mobile Data sources separates collection/sync from diagnostic repair controls.
The full web source layout, location-source presentation, receipt recovery/error
matrix and device interaction checks remain unfinished.

TimelineCore simulator suite: 22 tests passed (`/tmp/bud-sync-receipt-tests.log`).
This does not establish background timing or publication UI acceptance.

Validation: physical-device Debug build and web production build passed
(`/tmp/bud-sync-settings-build.log`, `/tmp/bud-settings-navigation-web-build.log`).
Updated `chat.bud.app.local` installed successfully on the connected iPhone;
installation alone does not prove interaction or background behavior.

Source-layout follow-up: web Data sources explains server receipts versus phone
connectivity, collapses troubleshooting and permission panels, and explicitly
labels refresh as received-data refresh. Mobile Contacts browsing no longer owns
automation or permission setup; agent/app access is reachable from Data sources.
Both builds passed (`/tmp/bud-source-layout-web-build.log`,
`/tmp/bud-source-layout-mobile-build.log`). Visual/device acceptance remains open.
