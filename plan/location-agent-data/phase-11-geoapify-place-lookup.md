# Phase 11: Geoapify place lookup — names, addresses and search we can keep

Status: in progress (2026-11-05), on the Phase 9 and 10 branches (`feat/place-pins`,
`feature/place-pins`), so they never ship Apple-filled addresses. Everything merges together once
Geoapify proves good enough for us (the replay below, and use).

## Why

The Apple Maps terms (Developer Program License Agreement, Attachment 6) don't fit how Bud uses
place data. Map Data is "any content, data or information provided through the Apple Maps
Service", including coordinates and points of interest. It may not be stored "other than on a
temporary and limited basis" (§2.5), may not form "any secondary or derived database" (§2.2), and
may not be surfaced "without displaying the corresponding Apple map" (§2.4). Bud does all three
with:
- **Visit names:** the phone's `MKReverseGeocodingRequest` and `MKLocalPointsOfInterestRequest`
  results, uploaded as `location.visit_named.v1`, kept in `location_visit_name`, and shown in
  messages, pushes, agent evidence and lists. This is already on `main`.
- **Addresses from search:** the pin editors' Address field, filled from an Apple search result
  (Phase 10, unmerged).

Geoapify's terms allow what we need. Reverse geocoding results can be stored indefinitely, results
can be shown on any map, and the attribution is OpenStreetMap's (always) plus Geoapify's (on the
free plan): "Powered by Geoapify" near the information.

## Decisions

- **Apple only draws maps.** MapKit on iOS and MapKit JS on the web keep showing the map, under the
  pin editor and on the Location screens. Nothing Bud stores or puts in text comes from Apple. A
  pin the user places is the user's own coordinate.
- **Geoapify provides every name, address and search result**, through the service, so the key
  stays server-side, and one place handles attribution and quotas.
- **Visits are named on the service, not the phone.** The phone stops sending
  `location.visit_named.v1`.
- **Existing Apple-derived names are replaced, then deleted.** This is a data change: it needs
  explicit approval before it runs in each environment.

Not in scope: changing the map display (Apple stays); routing; geocoding pins automatically (the
user still places the pin, Phase 9).

## Service

**Client** (`personal-data/geoapify.ts`)
- `GEOAPIFY_API_KEY` in config; without it, search returns 503 `place_lookup_unavailable` and
  visits stay unnamed.
- Endpoints:
  - reverse geocoding (`/v1/geocode/reverse`);
  - search and autocomplete (`/v1/geocode/autocomplete` or `/v1/geocode/search`);
  - nearby points of interest (`/v2/places` with a small circle around the visit).
- Each is one credit. Timeouts, and a daily budget guard below the plan's credits.

**Visit naming** (replaces the phone's)
- A naming worker names visits without a current name: on arrival, and again on completion with
  the final coordinate, as the phone did. It runs outside the processor's lock: no network call
  inside a database transaction.
- It writes `location_visit_name` as today, plus `source` (`geoapify`), and stores Geoapify's
  formatted address, its parts, and the nearest point of interest with its distance.
- The visit-ended naming wait (`visit_naming_pending`, up to 60 s) now waits for this worker.

**Search** (`GET /api/places/search?q=&near=lat,lon`)
- Authenticated and rate-limited per owner. Returns results with coordinate, name, formatted
  address, category and the attribution text.
- Used by both pin editors (below). A chosen result's address can fill the Address field again
  (Phase 10), because it's storable.

**Agents**
- The evidence preamble says addresses and likely places are from OpenStreetMap via Geoapify.
- `likely_place` keeps its shape; its source changes.

**Backfill and clean-up** (each needs approval)
- Rename existing visits with Geoapify, paced within the daily credits, newest first.
- Delete Apple-sourced `location_visit_name` rows. Also delete stored Apple-derived text anywhere
  else (for example, folded timeline entries quoting an old address).

## Phone

- **Visit naming:** remove the upload of `location.visit_named.v1` and the MapKit requests in
  `VisitNaming.swift`. The service accepts no more visit names from the phone (`unsupported`).
- **Pin editor search:** `PlaceMapEditor` searches through `/api/places/search` instead of
  `MKLocalSearch`. The map stays MapKit, and the same Address rules apply.
- **Attribution:** "Powered by Geoapify · © OpenStreetMap contributors" under search results, and
  under addresses on Browse location.

## Web

- **Pin editor search:** through `/api/places/search` instead of `mapkit.Search`. The MapKit JS
  map stays; its `services` library is no longer needed.
- **Attribution:** under search results, and under addresses on the Location screen.

## What changes for #176 and #82

Decided: this phase is built on their branches before they merge, so they never ship
Apple-filled addresses. They merge with it once Geoapify is validated.

## Order

1. Service: the Geoapify client, search endpoint, naming worker and preamble. Visits are named by
   the service.
2. Web and iOS: search through the service, attribution, and no visit naming on the phone.
3. Backfill, then delete Apple-sourced names, each with approval: bud.dev first, then local.

Deploy order: service, then web, then the phone build. Older phones still send visit names; the
service ignores them.

## Costs and limits

- Free plan: 3,000 credits a day, at up to 5 requests a second. A visit costs about 3 credits
  (an arrival and a completion reverse geocode, plus one points-of-interest lookup). A search
  costs about 1 per query typed: debounce autocomplete.
- Free-plan production use is allowed "with some limitations": confirm with Geoapify, or move to a
  paid plan (from $59 a month for 10,000 credits a day), before launch.

## Testing

- **Client:** request shapes, error handling and the budget guard, against recorded Geoapify
  responses (no live calls in tests).
- **Naming worker:** names on arrival and completion; retries; no network inside transactions;
  the visit-ended wait is satisfied by its names.
- **Search endpoint:** auth, rate limit, attribution in results, and 503 without a key.
- **Phone:** no `location.visit_named.v1` sent; search through the service; attribution shown.
- **Web:** search through the service; attribution shown.
- **Replay:** rename the last week's visits, and compare the Geoapify and Apple names before the
  clean-up runs.

## Open questions

- **Quality:** OpenStreetMap points of interest are sparser than Apple's in places. Check the
  replay before switching.
- **Privacy:** visit coordinates now go from the service to Geoapify (in Germany), where today only
  the phone asks Apple. Update the privacy disclosure.
- **AI:** Geoapify works with AI startups and agents, and its current terms fit passing results to
  agents. Confirm when moving past the free plan.
- **Attribution in pushes and agent messages:** show it in the apps where addresses appear, and in
  the agent's reference text. Confirm with Geoapify that pushes don't need it.
