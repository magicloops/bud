# Phase 7: Timely place triggers with geofences

Part of [location for agents, automations and apps](README.md). Requires 6.4
(places and triggers) and reuses 6.5's fix code.

## Problem

Visit-based triggers lag. iOS reports a visit several minutes after arrival or
departure, then the upload follows. A walk test in October 2026 confirmed that
arrive and leave automations feel slow. "When I get home, turn on …" wants under
a minute.

## Design

### Monitoring (iOS)

- **Places on the phone:**
  - the app fetches `/api/data/places` at start, on foreground and after
    editing a place on the phone;
  - it keeps the list in the event-store snapshot, so monitoring survives
    relaunch without the network.
- **`CLMonitor` (iOS 17+):**
  - a `CircularGeographicCondition` per place;
  - radius: at least 100 m, since geofences are unreliable below that;
  - identifier: the place ID.
- **Region limit:** iOS allows about 20 monitored regions per app. Monitor the
  20 places nearest the latest location, and re-pick them on significant
  changes and fixes.
- **Baseline:** adding a condition reports its current state. That initial
  state is recorded with `initial: true` and never triggers, so saving a place
  while inside it doesn't fire (the same rule as 6.4).
- **Events:** `location.region_transition.v1` carries:
  - `place_id`, `transition` (`entered` or `exited`), `occurred_at`, `initial`;
  - a 6.5-style fix taken within the wake, when one arrives in a few seconds.

  Each is committed with a background assertion, and then sync is kicked.
  Uploads should use the non-discretionary session. Measure the upload delay on
  device, since it is most of the remaining delay.
- **Permission:** monitoring needs Always. With When In Use, place triggers stay
  visit-based, and the Location section says so.

### Presence (service)

- **Single source of truth.** Both region transitions and visits feed one
  presence state per owner and place: `place_presence`, which is inside or
  outside, since when, and from which source.
- **Arrival and departure events:**
  - `place.arrived` and `place.departed` are published only when that state
    changes, so a rule runs once per arrival whichever signal comes first;
  - a region entry at 9:00 publishes the arrival, and the visit arriving at 9:05
    finds the owner already inside and publishes nothing;
  - departures work the same way.
- **Subjects:** each change is a `place_presence_event` row (place, transition,
  time, source, plus the region event or visit). The domain events for
  `place.*` point at that row instead of at (visit, place) as in 6.4.
  `visit.ended` stays visit-based.
- **Flapping:** an exit followed by re-entry within 3 minutes is treated as
  staying. The departure publishes only once the 3 minutes pass without
  re-entry.

  This adds up to 3 minutes to departures. It's tunable; measure it on device.
- **Places removed from monitoring:** when rotation removes a place, its
  presence becomes unknown. The next visit or region event sets it again
  without publishing.
- **Evidence:**
  - the run includes the transition (and fix, if any) and the matching visit
    when one exists;
  - delay is measured from the transition time.
- **Matcher:** maximum age and history rules are unchanged, but measured from
  the presence change.

### Clients

- Trigger copy changes from "a few minutes late" to "usually within a minute
  with Allow all the time; otherwise a few minutes".
- The Location section shows how many places are monitored, and the nearest-20
  limit when there are more.

## Out of scope

- On-demand reads (phase 8).
- Wi-Fi or Bluetooth presence signals.

## Tests

- **TimelineCore:** with fakes for `CLMonitor`:
  - initial state never triggers;
  - nearest-20 selection and rotation;
  - the snapshot survives relaunch;
  - a closed gate commits nothing.
- **Service (PostgreSQL):**
  - region-then-visit and visit-then-region publish once;
  - a 3-minute flap doesn't publish;
  - rotation to unknown;
  - initial events;
  - migration of the 6.4 place subjects.
- **Device acceptance:**
  - arrive and leave with the app killed, the phone locked and in Low Power
    Mode;
  - more than 20 places;
  - measure the time from crossing the boundary to the run starting.

## Rollout

- A migration adds `place_presence` and `place_presence_event`, and moves
  `place.*` domain events to them. A breaking change to 6.4's subjects is
  acceptable before launch.
- Service first, then iOS. Older iOS builds keep visit-based triggers.
