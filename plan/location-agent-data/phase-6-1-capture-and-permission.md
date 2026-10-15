# Phase 6.1: Reliable location capture and permission

Part of [location for agents, automations and apps](README.md).

## Problem

- **Writes can be lost.** `LocationProducer` handles `didVisit` and
  `didUpdateLocations` by starting an unawaited `Task` that appends to SQLite and
  kicks sync. When iOS wakes the app for a location event, it gives only a few
  seconds. The delegate returns immediately, so nothing tells iOS the app is
  still working, and a suspension can drop the event.
- **Visits are reported twice.** iOS delivers each visit once on arrival
  (departure = distant future) and again when completed. Today these are two
  unrelated rows.
- **Permission handling is debug-grade.** There are only two raw request
  buttons. Users can't see:
  - whether collection is running;
  - that "When In Use" means visits only while the app is open;
  - that Precise Location is off (reduced accuracy fuzzes points by kilometres);
  - when the service last received a location.

## Design

### Durable capture (TimelineCore)

- **Background time.** Each delegate callback calls
  `UIApplication.beginBackgroundTask` before starting its append, and ends it
  after the SQLite commit and the sync kick, or when the expiration handler
  runs. Several updates in one callback commit in a single `store.append`
  batch, so they all succeed or fail together.
- **Visit identity.** New `location.visit.v2` envelopes carry a stable
  `visit_key`: a hash of the arrival time (to the second) and the coordinate
  rounded to 4 decimals. Each also carries `phase`: `arrived` (no departure yet)
  or `completed`. The arrival and the completed report share the key, so the
  service can merge them (6.3).
- **Significant change:** unchanged (`location.significant_change.v1`). The
  envelope's `consent` already carries the authorization snapshot, so a new
  version would add nothing.
- **Lifecycle.** Use the same `CollectionGate` pattern as health:
  - `stop()` closes the gate;
  - appends are gated, so nothing commits after sign-out or an account switch.
- **Relaunch.** iOS relaunches a terminated app for visits and significant
  changes. The producer is created at launch from the Keychain-bound owner
  (`AppSessionStore`), so pending events reach the delegate. Verify on device
  (launch with `UIApplication.LaunchOptionsKey.location`).

### Permission and status (iOS)

- **Data sources → Location** section, like Health:
  - **State:** Off / While using the app (visits only while open) / Always.
    Shows Precise Location on or off.
  - **Actions:**
    - "Turn on location": When In Use, then the system's Always upgrade
      prompt.
    - "Allow all the time": when only When In Use is granted.
    - "Open Settings": when denied or reduced accuracy.
  - **Explanation:** what's collected (visits and large moves, not a
    continuous track), battery impact, and who can read it (agents and apps
    only with permission).
- Retire the debug buttons in onboarding and settings in favour of this
  section.

### Status (service)

- `/api/data/status` adds `location: { last_received_at, latest_visit_at,
  latest_point_at }` from `location_observation`, scoped to the owner, like the
  health status.

## Out of scope

- Names (6.2), merging and queries (6.3), places and triggers (6.4).
- Continuous tracking.

## Tests

- **TimelineCore:**
  - pure tests for `visit_key` stability (an arrival and its completed visit
    match; a different place or arrival doesn't);
  - v2 payload mapping;
  - a gated append refused after close.
- **Service:** status fields and owner isolation (PostgreSQL fixture); v2 events
  stored and processed as observations (the parser accepts the new types).
- **Device (MANUAL_TESTING.md):**
  - force-quit the app, travel, and check visits arrive after relaunch;
  - locked phone overnight;
  - permission flows from Off to Always, including the reduced-accuracy
    warning.

## Implementation (October 15, 2026)

Implemented as designed, on branches `feat/location-capture` (service, web) and
mobile `feature/location-capture`:
- **Capture:**
  - `LocationProducer` holds a `BackgroundAssertion` per callback and commits
    each callback's envelopes with `SQLiteEventStore.append(_:gate:fence:)` (one
    gated transaction).
  - Visits use `location.visit.v2` with `visit_key` and `phase` (pure mapping in
    `LocationEnvelopes`).
- **App:**
  - `LocationAccess` and `LocationAccessState` drive Data sources → Location:
    state, the reduced-accuracy warning, "Turn on location" → "Allow all the
    time" (offered once) → "Open Settings", and the service's last received and
    latest visit.
  - Onboarding uses the same flow; the debug location buttons are gone.
- **Service:** accepts `location.visit.v2` (projected as visits; key and phase
  are kept in the raw event for 6.3). `/api/data/status` adds
  `location { last_received_at, latest_visit_at, latest_point_at }`. Web Data
  sources shows it.
- **Tests:**
  - TimelineCore: visit-key stability, payload mapping, atomic and gated batch
    append.
  - App: state mapping.
  - Service: an isolated PostgreSQL status fixture.
- Also fixed the flaky `QueueRecoveryTests` date comparisons (millisecond
  tolerance).

## Rollout

The service accepts the v2 types before the iOS build ships. Older builds keep
sending v1, which still processes. No migration expected (status reads the
existing table).
