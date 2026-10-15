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

## Rollout

- A migration adds `location_visit`, then a backfill job projects existing
  observations, running in the processor's recovery pass.
- Service first, then web and iOS.
