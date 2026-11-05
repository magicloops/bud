# Phase 6.3: Location for agents and screens

Part of [location for agents, automations and apps](README.md). Requires 6.1
(visit identity) and benefits from 6.2 (names).

## Problem

Even with reliable, named data, nothing presents it:
- Agents can only page raw observations.
- There's no answer to "where am I now" or "where was I yesterday".
- There's no location screen, and apps get raw points.

## Design

### Visit projection (service)

- A `location_visit` table: one row per owner and `visit_key`, with:
  - arrival and departure times, coordinate and accuracy;
  - `status` (`in_progress` or `completed`);
  - the name fields from 6.2;
  - the raw event references.
- Arrival and completed reports for a visit merge into one row. The completed
  report sets the departure and replaces the coordinate when it's more
  accurate.
- v1 visit observations (no key) project as completed-only visits keyed by
  their event, so existing history still appears.
- Significant-change points stay in `location_observation`. Queries treat them
  as "passing through" points between visits.

### Queries and agent tools

- **`location_recent`:**
  - the latest known location (a visit in progress, or the newest point);
  - its age and accuracy;
  - "no recent data" when the newest record is older than 2 hours.

  It never claims to be live and doesn't wake the phone.
- **`location_visits`:** visits in a window of up to 31 days. Each visit has
  duration, address, likely place and a completed/in-progress state, with
  paging and newest-first ordering.
- **`timeline_query`:** keeps raw observations, adds names, and gains
  `kind: visits | points | all`.
- All of these sit behind `location.read`, approved history and the existing
  untrusted-data note. Responses report coverage (last received, and that
  coverage is not continuous).

### App access

- `/api/app-data/location/visits` and `/recent`, with the same policy as
  `timeline_query`. Rounded keys get localities only.

### Screens

- **Web `/data/location`** (replacing "Coming later"):
  - a day picker, with visits for the day (time range, place or address,
    duration);
  - a map with visit pins and the day's significant-change points;
  - last received and coverage notes.
- **iOS Browse location:** the same day view, with MapKit pins.
- Contact detail keeps its evidence pin, now showing the visit's name.

## Out of scope

- Places and triggers (6.4).
- Routes between visits: iOS doesn't provide them without continuous tracking.

## Tests

- **Service (PostgreSQL):**
  - arrival-then-completed merge, completed-only and v1 projection;
  - out-of-order arrival;
  - `location_recent` staleness;
  - visit paging, history bound and owner isolation;
  - app rounding.
- **Web:** a render test for the day view summary.
- **iOS:** decoding tests.
- **Device and browser:** a day of normal movement shows the right visits and
  names on both clients.

## Implementation (October 15, 2026)

On branches `feat/location-visits` (service, web) and mobile
`feature/location-visits`, stacked on 6.2:
- **Migration 0055** adds `location_visit` (unique owner + `visit_key`) and
  backfills it from stored visit observations: v2 reports merge by key, and v1
  visits are keyed `v1:<event>`.
- **`projectVisit`** merges each new visit report under the processor's owner
  lock:
  - arrival takes the earliest time and departure the latest;
  - the coordinate comes from a completed report, then the most accurate one.
- **`LocationQueries`:**
  - `visits` covers windows up to 31 days, newest first by default. Each visit
    has a state: `completed`, `in_progress` (no departure, under a day old) or
    `end_unknown`.
  - `recent` returns the in-progress visit, else the newest visit end or point,
    with `age_seconds` and `stale` after 2 hours, limited by approved history.
  - `timeline_query` gains `kind`.
- **Agent tools** `location_recent` and `location_visits`, and first-party
  routes `/api/data/location/{visits,recent}`. App routes
  `/api/app-data/location/{visits,recent}` share one precision helper
  (rounded keys: 2-decimal coordinates, city/region only, no place or visit
  key). The backend helper allows them.
- **Web `/data/location`:** a last-known line, a day picker, the visit list
  (title prefers a likely place within the visit's accuracy, else street, city
  or coordinates) and an OpenStreetMap embed of the selected visit. There's no
  multi-pin map on web, since the app has no map library.
- **iOS Browse location:** last known, a day picker, a MapKit map with a marker
  per visit, and the same list.
- **Tests:**
  - `location-visits.test.ts` (isolated PostgreSQL): merging in both orders,
    coordinate choice, v1, states, paging, owner isolation, `recent`
    staleness and history, and the `kind` filter.
  - Adapter tests for agents and apps.
  - Web `location-format.test.ts`.
  - iOS decoding and label tests.

## Rollout

- Migration 0055 adds `location_visit` and backfills it in the same migration
  (Render runs it before deploy). There's no separate backfill job.
- Service first, then web and iOS.
