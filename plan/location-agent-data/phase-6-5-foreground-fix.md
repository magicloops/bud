# Phase 6.5: A fresh location when Bud opens

Part of [location for agents, automations and apps](README.md). Requires 6.3
(recent location). It's the first step towards on-demand location
([phase 8](phase-8-on-demand-location.md)), which reuses its fix code.

## Problem

Location is only as fresh as the last visit or significant-change point. On a
walk (October 2026), "where am I?" returned a point from 5 minutes earlier, even
though the user was asking from the phone with Bud open. The app never asks
Core Location for its current position.

## Design

### One fix per foreground (TimelineCore)

- **`LocationFixer`:**
  - owns its own `CLLocationManager`, so its results never mix with the
    producer's significant-change updates;
  - gets one fix with `requestLocation()` at `kCLLocationAccuracyNearestTenMeters`;
  - takes the first result within 10 seconds, or the best one received by then;
  - gives up quietly on error or timeout.
- **When:**
  - on launch into the foreground and on every `willEnterForeground`;
  - skipped when the newest stored fix or point is under 2 minutes old;
  - skipped when location is off;
  - works with When In Use as well as Always (the app is in the foreground).
- **Envelope:** `location.fix.v1` with:
  - `coordinate`, `horizontal_accuracy_m`, `altitude_m`, `speed_mps`,
    `course_deg`;
  - `reason: foreground` (phase 8 adds `request`, with a `request_id`).

  It's committed through the producer's `CollectionGate` with a background
  assertion, like other location events, and sync is kicked straight away.
- **Naming:** fixes join the `VisitNamer` queue so "where am I?" can return an
  address. The queue key becomes a subject key: a visit key, or `fix:<event
  id>`. The ~50 m cache means repeat places cost no lookup. A
  `location.fix_named.v1` event carries the name.

### Service

- **Storage:** `location_observation` gains kind `fix` (with `reason`). Names
  join through the subject key, as visits do.
- **`recent`:** considers fixes alongside visits and points, and reports
  `kind: fix` with its name when there is one.
- **`timeline_query`:** `kind: points` includes fixes. Each row says which kind
  it is.
- **Apps:** fixes appear under the same precision rules.

### Screens

- Last known (web and iOS) shows a fix as "Here" with its address and age.
- Fixes aren't drawn as visits on the day map.

## Out of scope

- Fixes while Bud is in the background (phase 8).
- Continuous tracking.

## Tests

- **TimelineCore:** with a fake location manager:
  - one fix per foreground;
  - the 2-minute skip;
  - timeout and error;
  - a closed gate commits nothing;
  - the fix is queued for naming.
- **Service:**
  - parsing `location.fix.v1`;
  - `recent` preferring a newer fix over an older visit;
  - names joined to fixes;
  - app precision.
- **Device:**
  - open Bud after walking a few hundred metres; "where am I?" answers with
    the new spot, under a minute old;
  - with When In Use only, opening Bud still records a fix.

## Implementation (October 19, 2026)

On branches `feat/location-fixes` (service, web) and mobile
`feature/location-fixes`, stacked on 6.4.
- **iOS:**
  - `CoreLocationFixer` streams updates until one is within 20 m, or returns
    the best after 10 seconds, ignoring locations cached over 15 seconds before
    the request;
  - `LocationFixPolicy` decides whether a fix is due;
  - the producer takes a fix on `didBecomeActive`, and at start when Bud is
    already active;
  - the fix is committed with the producer's gate and fence, and queued for
    naming.
- **Service:** `location.fix.v1` is stored as kind `fix`. `recent`,
  `timeline_query` (`points`), status and apps include fixes.
- **Clients:** the Last known line shows "Here: <address>" for a fix.
- **Changes from the design:**
  - **Freshness:** the 2-minute check uses the newest point or fix this run of
    the app has committed, not the store; after a relaunch it always fixes.
  - **Naming:** fixes reuse `location.visit_named.v1`, with the `fix:<uuid>`
    key in `visit_key`, instead of a new `location.fix_named.v1`. The
    service's naming join works unchanged.
  - **Reason:** `reason` stays in the raw event and has no column; phase 8 adds
    what it needs.
  - **Added:** a fix taken after an in-progress visit started, and away from
    it, is the latest location. iOS reports departures late; this was the walk
    test's symptom.
- **Tests:**
  - TimelineCore: fix payload, policy, naming by fix key;
  - service: near and far fixes, names, invalid keys, the points filter, app
    rounding;
  - iOS: the last-known label.

## Rollout

- Service first, so the new events are stored as fixes rather than as unknown
  events.
- iOS next. No new permission, entitlement or background mode is needed.
