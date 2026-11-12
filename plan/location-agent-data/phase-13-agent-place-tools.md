# Phase 13: Agent place tools — infer the place from the question

Status: built (2026-11-06), service only, on `feat/place-pins`; live check on a walk pending. Design:
[`design/agent-place-awareness.md`](../../design/agent-place-awareness.md).

## Goal

The agent answers place-dependent questions ("what should I order?", "is the pharmacy near me
open?") by inferring the likely place from the question and the location data, using tools at
question time, and saying what it assumed. No user-verified data.

## Decisions (2026-11-06)

- **Categories:** the agent passes Geoapify categories (listed in the tool description) and
  optional name text. No mapping from plain words.
- **"Latest" location:** every recent reading counts when they're close in time: the readings
  (precise fixes, and points accurate enough for presence) and the open visit from the
  `RECENT_WINDOW_MS` (15 minutes) before the newest one. The search starts from the most precise
  of them; the tool reports them all, so the agent can weigh them.
- **Hours:** `opening_hours` (the OpenStreetMap ecosystem's parser, LGPL-3.0, unmodified
  dependency), evaluated in the place's time zone; `open_now: null` when it can't decide.
- **Later:** caching details, calendar.

## Service

**Geoapify client** (`geoapify.ts`)
- `searchNearby({ lat, lon, radiusM, categories?, text? })`: the Places API around a point. Given
  categories are split into the two groups that mix (`PLACE_CATEGORY_GROUPS`'s rule: `tourism`,
  `accommodation`, `airport` and `sport.*` other than `sport.fitness` in the second), one request
  per group present; none means both default groups. `text` is Geoapify's `name` filter.
  `conditions=named`, bus stops skipped, merged by distance, up to 10. Each place: name,
  `place_id`, distance, `categories` (all), the most specific one, label, cuisine and
  `opening_hours` when the Places response has them.
- `placeDetails(placeId)`: Place Details (`/v2/place-details`, one credit): name, address,
  categories, cuisine, `opening_hours`, website, phone, brand, takeaway, delivery, time zone.
- Stored candidates (visit naming) keep the most specific category and cuisine.

**Hours** (`opening-hours.ts`): `openNow(hours, timeZone, now)`: parse with `opening_hours`,
evaluate at the place's local wall time, and return `true`, `false` or `null`, plus the next change
when the parser gives one.

**Agent tools** (`personal-data-tools.ts`, `agent-queries.ts`, tool lists), under `location.read`:
- `places_nearby`: `near` (`latest`, a `visit_id`, or `{ lat, lon }`), `categories`, `text`,
  `radius_m` (default the location's accuracy, at least 30 m, at most 1 km). `latest` and visits
  resolve within approved history. Returns `from` (the point searched, its source, age and
  accuracy), `recent` (the recent readings, for `latest`), and `places` with `open_now` computed in
  the phone's time zone.
- `place_details`: `place_id`. Returns the details with `open_now` and the next change.

**Freshness** (`location.ts`, `location_recent`): `recent_readings` (as above), `since` (the open
visit's arrival, or the first of the recent readings within their accuracy of the newest),
`moving` (any recent reading's speed over 1 m/s, or readings more than their accuracy apart), and
`now_note`.

**Guidance**: the tool descriptions and a line in the system prompt: infer from the question,
the candidates, distances against accuracy, time and hours; state the assumption in a clause and
name close alternatives; ask only when the answer depends on which place it is; say when the
location is stale.

## Testing

- `searchNearby` grouping (none, one group, both), the name filter, merging and limits; details
  parsing; recorded responses.
- `openNow`: open, closed, overnight ranges, an unparseable value, the place's time zone.
- The tools: arguments, scope, `near` resolution (latest within the window, a visit inside and
  outside history, a coordinate), radius defaults and bounds.
- `location_recent` freshness: since, moving, the window.

## Build notes (2026-11-06)

- `near` became the arguments `places_create` already uses: `visit_id`, or
  `latitude` and `longitude`, or neither for the latest location. Strict tool schemas
  handle these better than a union.
- Speeds come from the raw fix payload (`speed_mps`); `location_observation` doesn't
  store them.
- Stored candidates now keep `place_id` too, so `place_details` works from a visit's
  `nearby_places`.
- Rounded app keys don't get `recent_readings` (precise coordinates); `since`,
  `moving` and `now_note` stay.
- Fixed in passing: `places_create` rejected the `address` argument Phase 10 added
  (the agent's key list didn't include it).

