# Phase 7.1: Confirm geofence reports with a precise reading

Part of [location for agents, automations and apps](README.md). Requires
[phase 7](phase-7-geofences.md) (geofences and presence). It finishes two items
phase 7 planned but didn't ship: a fix taken within the geofence wake, and
prompt uploads.

## Problem

Walk tests on October 22 and 23, 2026 showed the following.

- **Geofences are too coarse for nearby places.** iOS geofences are accurate to
  about 100–200 m, because they mostly use Wi-Fi and cell positioning. Home and
  Office are 117 m apart, each with a 50 m radius, and each is monitored at
  100 m.
  - Office was "entered" on the walk home and stayed inside all night while the
    phone was 3 m from Home.
  - The next morning, leaving Home fired a false "Left Office".
- **Uploads from a background wake are deferred.**
  - Bud uploads only through a background `URLSession`. iOS schedules transfers
    started in the background at its own discretion, whatever `isDiscretionary`
    says.
  - Geofence reports were recorded on time, but uploaded anywhere from a second
    to 13 hours later. Opening Bud flushed the queue.
  - Low Power Mode was off throughout.
- **Every geofence report is recorded twice.** The copies come 5–10 ms apart
  with identical event times. The service dedupes them through presence state,
  so nothing fired twice, but the phone shouldn't record them.
- **Departure time.** When a visit completion confirms a pending geofence exit,
  the departure is timed from the visit (8:45:20 PM) instead of the earlier exit
  (8:44:45 PM).

## Design

### Precise reading on each geofence wake (iOS)

- **Taking the reading:**
  - on every geofence report, including the initial one, take one fix with the
    6.5 `LocationFixer` (`kCLLocationAccuracyNearestTenMeters`);
  - wait up to 8 seconds, under the existing background assertion;
  - reuse a fix from the last 30 seconds whose accuracy is 65 m or better
    (one wake often reports two places, e.g. leaving Home and Office together);
  - if no fix arrives, send the report without one.
- **Payload:** `location.region_transition.v1` gains an optional `fix`:
  `latitude`, `longitude`, `horizontal_accuracy_m`, `occurred_at`. Phase 7
  hasn't been deployed, so v1 changes in place, with no new version.
- **Duplicates:** `PlaceMonitorState` remembers the last report per condition
  (inside or outside, plus its date). A report matching it is dropped inside the
  same snapshot commit, so it's safe across relaunches and interleaved handlers.
  The field is optional so existing snapshots still decode. The second
  delivery's source is still to be found; the dedupe holds either way.

### Following up an early entry (iOS)

A geofence entry usually fires 100–150 m out, before the person is within the
place's radius. A rejected early entry must not fall back to visit latency.

- If an entry's fix is outside the place (see the rules below), follow up with
  `CLLocationUpdate.liveUpdates()` until one of these happens:
  - a fix lands inside → send a confirming `entered` report with that fix;
  - the geofence exits;
  - 3 minutes pass → stop and leave it to the visit report.

  `liveUpdates` is the modern stream: it detects when the phone is stationary,
  and an Apple engineer says it keeps working after force-quit in this setup.
  Visits and significant changes stay on `CLLocationManager` delegates; Apple
  confirmed that combination in June 2026.
- **Needs** the Location updates background mode, with the Always
  `CLServiceSession` already held for geofences. `CLBackgroundActivitySession`
  (and its visible indicator) is only for When In Use, so it isn't used.
- **Spike first:** confirm on device (iOS 26) that `liveUpdates` can start from a
  background geofence wake. If it can't, ship without the follow-up: early
  entries then wait for the visit arrival, and only false entries are fixed.
- This is a bounded exception to "no continuous tracking" (README, decision 2):
  at most 3 minutes, only after a geofence entry.

### Confirmation rules (service)

For a report with a fix, take `d` (distance from the place's centre), `r` (the
place radius, not the 100 m monitored radius) and `a` (the fix accuracy).

| Fix | Classified as |
|---|---|
| None, or `a` > 100 m | **Unknown:** today's behaviour (trust the geofence) |
| `d ≤ r + a` | **Inside** |
| `d > r + a` | **Outside** |

- **Entered + inside:** arrival, as today.
- **Entered + outside:** presence becomes **approaching** (a new
  `approaching_at` on `place_presence`, with no published event). The
  follow-up's confirming report, or the visit, brings the arrival. A geofence
  exit or a fix outside clears it. This gives the four states outside,
  approaching, inside and leaving (`leaving_at`). Agents can say "near Home", and
  a later approach trigger ("near Sightglass?") can build on it.
- **Exited + outside:** departure, after the usual 3-minute settle.
- **Exited + inside:** ignored. The visit completion brings the departure.
- **Initial reports:** the state comes from the fix when there is one (saving
  Office while at Home sets Office to outside).
- **Overlapping places:** if one fix is inside more than one place, it counts
  only for the nearest. For Home and Office this matters only for indoor fixes
  with accuracy over about 60 m.
- **Evidence:** the run and the agent text include the fix distance and
  accuracy ("detected by geofence, confirmed 12 m from Home, ±8 m").
- **The departure wait is silence used as evidence.** After a geofence exit,
  3 minutes without a re-entry publish the departure. A timer alone proves
  nothing; it works only because a re-entry would wake Bud and be reported. That
  holds only if the re-entry arrives promptly, so prompt uploads (below) are a
  prerequisite. Out-of-order reports are still handled through
  `last_entered_at`.

### Presence for agents (service)

`location_recent` returns each place's presence alongside observations, so
"where am I?" can answer "at Home since 9:12" without inferring it from points:

- `state`: outside, approaching, inside or leaving;
- `since`;
- `source`: geofence or visit, and the confirming fix's distance and accuracy;
- `freshness`: **confirmed** (a confirming fix or a visit), **inferred** (a
  geofence without a fix) or **stale** (the newest evidence is older than 12
  hours).

### Precise Location off (iOS)

iOS delivers geofence events only with Precise Location. The Location section's
reduced-accuracy warning also says that place triggers fall back to visits, and
the monitored-places count shows none.

### Prompt uploads (TimelineCore)

- **While Bud is running** (foreground, or awake after a geofence, visit or
  fix), `SyncEngine` uploads each batch with a regular `URLSession` upload task
  under a background assertion.
- **Fallback:** if that fails, or the assertion is about to expire, the batch
  goes to the background session as today.
- **ACKs:**
  - the ACK and delete path is shared, so events are deleted only after an ACK;
  - a batch must be in flight on only one session at a time;
  - a batch sent twice is safe, since ingestion is idempotent on `event_id`.
- **Device & Debug** shows which path the last upload used. The service's
  `received_at` against `recorded_at` gives the wait.

### Departure time (service)

A visit completion that confirms a pending geofence exit publishes the departure
at `min(leaving_at, visit departure)`.

## Out of scope (optional, later)

- **Wi-Fi confirmation.** Link a place to the network it's on, and have the
  phone send a hash of the current network name (`NEHotspotNetwork.fetchCurrent()`,
  with the Access Wi-Fi Information capability) in geofence reports and fixes.
  A match settles presence. It mostly helps indoors, where fixes can be 30–65 m
  off. It costs about a day of work. Revisit if 7.1's indoor readings at Home and
  Office are regularly worse than 30 m.
- **Shortcuts automations.** Provide App Intents, "Arrived at place" and "Left
  place", plus a guided setup screen. Users then create "when I join/leave this
  Wi-Fi" automations themselves; iOS doesn't let apps create automations. This
  is event-driven and accurate to the building. It's an opt-in upgrade for power
  users, costing 1–2 days, and it would make Wi-Fi confirmation unnecessary.

- **Notification rules.** Recheck presence before sending if the agent took a
  while (don't send "Welcome home" after the person has left again), and add a
  per-place cooldown.

## Tests

- **TimelineCore:**
  - duplicate reports are dropped, including across a relaunch;
  - a recent fix is reused, and an expired one isn't;
  - a report is sent without a fix after the timeout;
  - the follow-up stops on inside, exit or timeout;
  - a batch uploads on the foreground path, falls back to the background path,
    and is never in flight on both.
- **Service (PostgreSQL):**
  - the confirmation table, both transitions;
  - initial reports with fixes;
  - overlapping places use the nearest;
  - an early entry sets approaching; its confirming report publishes once, and
    an exit clears it;
  - `location_recent` presence states and freshness;
  - departure uses the earlier time.
- **Device acceptance (Home and Office, 117 m apart):**
  - a night at Home leaves Office outside, and leaving Home doesn't fire "Left
    Office";
  - walking to the Office arrives within about a minute of reaching it;
  - with the phone locked and Bud unopened, the time from crossing the boundary
    to the run starting stays under about a minute (uploads included);
  - note indoor fix accuracy at both places (the Wi-Fi decision).

## Order

1. Duplicate reports, the departure time, and the uncommitted `CLServiceSession`
   change, all in the phase 7 PRs (#165, #74).
2. Prompt uploads (TimelineCore only), in their own PR.
3. Spike: background follow-up updates on device.
4. The fix in the payload, the confirmation rules, approaching, and the
   follow-up (iOS and service).
5. Presence in `location_recent`, and the Precise Location copy.
