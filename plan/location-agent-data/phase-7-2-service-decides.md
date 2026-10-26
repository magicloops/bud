# Phase 7.2: The phone collects, the service decides

Part of [location for agents, automations and apps](README.md). Follows
[7.1](phase-7-1-precise-confirmation.md) (precise readings and follow-ups) and
replaces its phone-side placement check.

## Problem

In 7.1 the phone decides, from its own copy of the service's rule, whether a
reading puts you at a place: to start a follow-up and to stop one. The copy was
incomplete (it lacked "the nearest place wins"). A walk on October 24 that
passed the Office without stopping, then went home, showed what that costs:
- **8:39:** the phone thought the reading (67 m from the Office, ±19) was inside
  the Office, so it started no follow-up. The service counted it for the nearer
  Home.
- **8:54:** a ±27 m reading 76 m from Home and 44 m from the Office stopped the
  Home follow-up as "arrived". The service rejected it. With the follow-up
  stopped, nothing confirmed Home when the walker got there, and Home stayed
  "outside".

The same walk showed two service gaps:
- **Walking past counts as arriving:** a reading 52 m from the Office (±5) passed
  "within radius + accuracy".
- **Only geofence readings count:** a significant-change point at 9:40, 5 m from
  Home and 112 m from the Office, corrected neither place.

## Principle

The phone collects and the service decides. The phone decides only what needs
the device:
- which places to monitor;
- when to sample;
- when to stop sampling to save power. It stops when the service says the
  question is settled, the geofence fires again, or the window ends.

Where you are is the service's call, from every reading it gets.

## Design

### Readings decide presence (service)

**One classification** (`classifyReading`) for every precise reading: the
geofence wake reading, follow-up readings, the fix when Bud opens, and
significant-change points at 65 m or better. Take `d` (distance from the
place's centre), `r` (its radius) and `a` (accuracy):

| Class | Rule |
|---|---|
| Definitely inside | `d + a ≤ r`, and no other saved place that contains the reading is nearer |
| Definitely outside | `d − a > r` |
| Uncertain | otherwise |
| Unknown | `a` > 100 m |

**Rules** (`applyReading`, under the owner lock), for each place within 1 km of
the reading, plus every place currently inside or approaching:

| State | Reading | Effect |
|---|---|---|
| Approaching | definitely inside | arrival at the reading's time |
| Inside, leaving pending | definitely inside | re-entry: the pending departure is cancelled |
| Inside | definitely outside | departure wait starts at the reading's time (published after 3 minutes, as now) |
| Inside | definitely inside another place | departure wait starts (7.1's `departOthers`) |
| Anything | uncertain or unknown | no change |

**Geofence reports with their wake reading:**

| Report | Reading | Effect |
|---|---|---|
| Entered | definitely inside | arrival |
| Entered | any other reading | approaching; follow-up readings (or the visit) bring the arrival |
| Exited | definitely outside | departure wait |
| Exited | uncertain or definitely inside | ignored; the follow-up or the visit settles it |
| Initial | definitely inside | state inside |
| Initial | any other reading | state outside |

Without a reading, the geofence is trusted, as in 7.1.

Arriving is now harder than staying: an arrival needs the whole error circle
inside, and a departure needs it wholly outside. Walking past the Office at 52
m (±5) no longer arrives.

**Duplicate reports move here.** A region report with the same place, geometry
revision and `occurred_at` as an earlier one is ignored, whatever its `initial`
flag. A point with the same time and coordinate as a stored observation isn't
stored again. The phone's `lastReportAt` and `SignificantPoints` filters go.
The phone keeps one check, skipping the reading for an exact re-delivery, only
to save GPS.

### Follow-ups the service settles (iOS, service)

- **Start:** every non-initial geofence report starts a follow-up for that
  place: entries and exits, with no placement check on the phone.
- **Readings:** the stream runs in the 7.1 modes (standard or live, compared on
  device).
  - Every 10 s, the most accurate reading since the last one is committed as
    `location.fix.v1`, with `reason: follow_up` and
    `follow_up: { place_id, geometry_revision, transition }`, and uploaded straight away
    (the direct path).
  - Readings coarser than 65 m are skipped.
- **Settling, in the upload response:** the batch ACK gains
  `follow_ups: { "<place_id>": "settled" | "open" }` for each place whose
  follow-up readings (or region reports) were in the batch.
  - To answer, the upload handler processes that owner's pending location jobs
    inline after persisting the batch, for at most 2 s, as the background
    processor would.
  - **Settled** means presence for the place no longer needs readings: an entry
    follow-up has arrived, and an exit follow-up's departure wait has started,
    or the walker is back inside.
  - **Open** means keep sampling, as does a place missing from the response.
- **Stop:** when settled, the same place's geofence fires again, the window (3
  minutes) ends, or sign-out happens. Offline, it runs to the window and the
  readings upload later. Late readings still decide presence at their own
  times, and the matcher's maximum age guards automations.
- **Diagnostics:** `location.follow_up.v1` stays. Its reasons become
  `settled`, `geofence`, `timeout` and `offline`.
- **Removed from the phone:** `MonitoredPlace.contains`, the "short of the
  place" start check, and the confirming region entry. Follow-up readings now
  go to the service.

### Run text (service)

- Durations read naturally: "after 25 minutes", "after about 3 hours", "after
  about 2 days".
- A reading-based arrival or departure says so: "Detected by the phone's
  geofence, then confirmed by a precise reading 12 m from its centre (±8 m)".

## Out of scope (later)

- **A minimum stay** before an arrival counts, to stop walking past the centre
  counting as arriving. It needs follow-ups that outlast the geofence wake (about
  30 s), and the mode comparison still has to show whether either mode does.
- **Wi-Fi and Shortcuts** (see 7.1).

## Tests

- **Service (PostgreSQL):**
  - `classifyReading` bands, nearest-place included;
  - each rule in the tables above, reproducing the October 24 walk: passing the
    Office doesn't arrive, the Home approach confirms on a later reading, and
    the 9:40 point ends a stale Office stay;
  - duplicate region reports and points;
  - the upload response's `follow_ups` (settled, open, and processing that
    doesn't finish within 2 s);
  - duration wording.
- **TimelineCore:**
  - a follow-up starts on every non-initial report;
  - readings are throttled to the most accurate in each 10 s;
  - stopping when settled, on a repeated geofence report or at the window;
  - the ACK's `follow_ups` is parsed, and its absence is tolerated.
- **Device:** repeat the October 24 walk (past the Office, home):
  - no Office arrival;
  - a Home arrival within about a minute;
  - the follow-up stops when settled;
  - `location.follow_up.v1` reasons.

## Order

1. **Service:** `classifyReading` and `applyReading` for every reading type,
   duplicate handling, and durations. This works with 7.1 phones, whose
   follow-ups still send confirming region entries.
2. **Contract:** `follow_ups` in the upload ACK, with inline processing.
   Update the ingestion spec in bud-mobile.
3. **iOS:** follow-ups on every report; throttled readings as `location.fix.v1`;
   stopping on the ACK; the phone-side checks and filters removed.

Each step is its own pair of PRs on top of bud#168 and bud-mobile#78. The
service deploys first. A 7.1 phone ignores `follow_ups`, and a 7.2 phone on an
older service runs every follow-up to its window.

## Implementation

**Step 1 (October 24, 2026), on `feat/presence-readings`:**
- `classifyReading` (definitely inside, definitely outside, uncertain,
  unknown) replaces 7.1's `classifyFix`. Region reports follow the table above.
- `applyReading` covers the wake reading's other places (replacing
  `departOthers`), plus `location.fix.v1` and points at 65 m or better (in the
  location branch of the processor).
- Re-delivered region reports and replayed points are ignored on the service.
- Migration 0059 allows `place_presence_event.source = 'reading'`. Settled
  departures take their source from the exit event. The run text says
  "Detected from a precise reading N m from its centre (±A m)."
- Durations read "about 26 hours". Readings in evidence also come from fixes
  and points.
- **7.1 phones** still send confirming region entries from their own looser
  check. Those now arrive only when definitely inside, and otherwise the place
  stays approaching until a fix, a point or the visit.

**Step 2 (October 24, 2026), on `feat/follow-up-settling` and bud-mobile
`feature/follow-up-settling`:**
- **Service:**
  - `followUpRequests` reads the places a batch asks about: non-initial
    region reports, and `location.fix.v1` with `follow_up`.
  - `settleFollowUps` answers from presence:
    - entry: open while approaching;
    - exit: open while inside with no departure wait;
    - unknown places: settled.
  - The upload handler drains the owner's jobs inline for up to 2 s, then
    adds `follow_ups` to the ACK.
- **Shared fixture:** `wire-contract-v1.json` gains a `follow_ups` ACK case,
  with the hash updated in both repos.
- **iOS:**
  - `UploadResponse.followUps` is optional and tolerant: a malformed answer
    never fails the ACK.
  - It's carried on `UploadResult`, and `SyncEngine.setFollowUpHandler`
    receives it after an acknowledged upload. Nothing uses it until step 3.
- **Follow-up reading payload:** `follow_up` carries `transition` (`entered`
  or `exited`) as well as `place_id`, so the service knows which question
  each follow-up is asking.

**Step 3 (October 25, 2026), on bud-mobile `feature/follow-up-phone`:**
- **Follow-ups start on every non-initial geofence report,** at once (before
  the 8 s wake reading), in the Device & Debug mode.
- **Readings:** the most accurate one at 65 m or better goes as
  `location.fix.v1` (`reason: follow_up`,
  `follow_up { place_id, geometry_revision, transition }`). The first goes at
  once, then at most one every 10 s, with a scheduled flush for a reading held
  back while standing still.
- **Stopping:** on a `settled` answer, the same geofence firing again, or the
  window.
- **Diagnostics:** `location.follow_up.v1` reasons are `settled`, `geofence`
  and `timeout`. Instead of a separate `offline` reason, it records `answers`
  (none means the service wasn't reached) as well as `readings` and `sent`.
- **Removed from the phone:**
  - `MonitoredPlace.contains`;
  - the confirming region entry;
  - the significant-change point filter (`SignificantPoints`).
- **Re-deliveries are sent bare** (no reading, no follow-up), and the service
  ignores them.

**Fixes from the October 25 walks:**
- **A reading before its report:** a follow-up's first reading reached the
  service 3 s before its geofence report (the report waits for its wake
  reading), so the follow-up was "settled" after one reading. An entry
  follow-up now stays open while approaching or until its report has been
  processed.
- **Approaches ending:** Home was confirmed at 2:28 PM, but the Office stayed
  approaching. A reading definitely inside one place now ends the approach for
  any place it puts the owner definitely outside, and that follow-up settles.
- **Confirmed departures publish at once:** "Left the office" came 3 minutes
  late because a confirmed arrival elsewhere still waited the settle window.
  It now publishes immediately, at a pending exit's earlier time if there is
  one, with that exit as evidence. A lone outside reading or a geofence exit
  still waits. Departures are applied before arrivals.

