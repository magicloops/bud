# Phase 7 (optional): Timely place triggers with geofences

Part of [location for agents, automations and apps](README.md). Only if 6.4's
visit-based triggers prove too slow in practice.

## Problem

Visit-based triggers lag: iOS reports visits several minutes after arrival or
departure, then the upload follows. "When I get home, turn on …" wants under a
minute.

## Design

- **Monitoring:** the phone monitors the user's places with Core Location
  circular conditions (`CLMonitor`, iOS 17+). Apps can monitor about 20
  regions, so monitor the nearest places to the latest location, and rotate
  them on significant changes.
- **Events:** entry and exit become `location.region_transition.v1` events
  (place ID, transition, time, accuracy). They are uploaded immediately,
  without waiting for the usual batch.
- **Service:**
  - Turns transitions into the same `place.arrived` / `place.departed` events
    as 6.4.
  - De-duplicates against visit-based events for the same place within a
    window, so a rule runs once per arrival.
  - Region and visit evidence are combined on the run.
- **Permission:** requires Always. The Location section (6.1) explains why
  timely place triggers need it.

## Tests

Device-only acceptance:
- app killed;
- locked phone;
- low power mode;
- more places than the region limit (rotation);
- duplicates against visit events.

## Decision point

Decide after 6.4 has been used for a while: measure the delay from arrival to
run start, and only build this if visit-based triggers aren't good enough.
