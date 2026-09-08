# Phase 3: Contacts capture and scan lifecycle

Status: implemented in part; acceptance remains open. Dependencies: phase 2 and frozen phase-0 contact contract. Parent: [implementation spec](implementation-spec.md).

Current implementation includes durable snapshot/manifest capture, incremental
diffs, explicit reconciliation, pause/relink and observed-denial suppression,
local scan status and server import status. Limited-access membership changes
suppress live events because the snapshot diff cannot distinguish sharing an old
contact from creating one; queries and explicit bootstrap remain available.
Full-access incremental additions retain live eligibility. Complete-snapshot [source repair](contact-source-repair.md) is implemented for
retained source identity. Fully lost local store identity and physical-device
acceptance remain open; see
[remaining evidence](remaining-work-audit.md). Existing health/location producers
remain in place and Apple Contacts write-back remains out of scope.

## Outcome

An opt-in mobile producer uploads the permitted contact set and subsequent diffs without generating false baseline actions. No Apple Contacts write-back or separate editor is included.

## Producer and local transaction

Add a Contacts producer to TimelineCore and the app permission/collection controls. Initial approved fields: source identifier, display/name components, organization, phone numbers and email addresses with labels; omit photos and notes. Access only fields declared in the current consent contract. Preserve original values plus bounded normalization for search, not identity merges.

Listen for `CNContactStoreDidChange`; coalesce notifications and serialize refetches. Also reconcile on foreground and available background opportunities. A dirty flag during a scan schedules another scan. Treat notifications as invalidation signals, not individual create events or guaranteed wakeups while suspended.

Stage a scan of the full permitted set. Compare against the last committed snapshot for this source context. Persist approved-field fingerprints, stable event IDs, all deltas, manifest and new checkpoint atomically in SQLite. Partial/failed reads do not advance the checkpoint or tombstone unseen records. If staging is needed for a large address book, checkpoint publication remains a single transaction over the staged scan.

| Case | Payload / result |
|---|---|
| First successful scan | `baseline`; all accessible contacts, no live additions |
| Incremental scan | Added, revised and no-longer-visible source objects; new identifiers eligible for `contact.added` |
| Known permission-set expansion/reduction | `access_change`; suppress live actions and accurately reflect accessible state |
| Account/store reset or explicit reconciliation | `resync` / new epoch baseline; no automatic bootstrap rerun |
| Interrupted scan | Discard/retry staged scan; committed checkpoint remains authoritative |

Store previous observation time and current detection time. Actual creation and meeting times remain unknown. Cloud arrival/link changes can appear as additions; expose this uncertainty. Treat disappearance as no longer visible unless deletion is established. Contact identifiers are installation/store-scoped, not global across devices; do not automatically merge matching names/email addresses.

## Server handoff and UI

Phase 4 consumes the scan records. Server status distinguishes received records from a completed/public scan and reports missing predecessors/manifests. Source resets have an explicit repair path; a later generation must not overwrite state simply because it uploaded first. Bound missing-scan retries and surface reconciliation required rather than silently converting a resync to incremental.

Mobile shows OS permission and collection controls, import progress, last successful local scan/upload and actionable failures. Web reads the same reported collection/import state and explains mobile-only permission steps. Revoking upload consent stops collection/upload according to the shared account lifecycle. This is not the future comprehensive server-history deletion UI.

## Acceptance

- [ ] C-series fixtures/device cases pass: baseline, empty set, interrupted scan, concurrent notification, permission change, link/unlink and source reset.
- [ ] Upload retry reuses event/scan identity; reverse batch arrival cannot publish an incomplete baseline.
- [ ] Two devices preserve independent source identities; no claim of verified creation or encounter appears in either client.
- [ ] Existing HealthKit/location code remains; no new all-address-book background timing promise or Apple write-back.

Update TimelineCore producer/event/storage docs, app permissions/configuration and mobile settings spec. Complete phase-4 integration tests before enabling live rules against this source.

## Product refinement follow-ups

[Phase 9](phase-9-data-source-and-sync-experience.md) completes normal-user source
settings and observable manual sync. [Phase 12](phase-12-expanded-contact-fields.md)
extends the initial approved field set to addresses/websites with versioning and
consent migration; photos/notes remain excluded. Existing source identity, baseline
suppression and background timing constraints still apply.
