# Phase 6.4: Named places and location triggers

Part of [location for agents, automations and apps](README.md). Requires 6.3
(merged visits).

## Problem

There's no way to say "this is Home" or to react to arriving at or leaving
somewhere: "when I get to the office, summarize my day's meetings", "when I
leave the gym, log the workout".

## Design

### Places

- A `place` table: owner, name, centre, radius (50–2,000 m), optional note,
  created by (user or agent), and timestamps.
- Places can overlap. A visit matches every place whose radius contains its
  coordinate, padded by the visit's accuracy.
- Routes and screens to create, edit and delete places, on web and iOS:
  - create from a visit in the location history, or by searching an address;
  - Personal data → Places lists and edits them.
- **Agent tools:**
  - `places_list`;
  - `places_create` (name, centre, radius; or "from this visit").

  Places are labels, not permissions, so agents may create them without
  approval; the user sees and can edit or delete them.
- Visits and queries are annotated with matching place names; a user's own
  label wins over the 6.2 likely place.

### Trigger events

Published from `location_visit` changes under the processor's owner lock, with
the shared publication sequence. Each adds a typed subject column on
`data_domain_event` (`visit_id`), as workouts did.

- **`place.arrived`:** a visit starts inside a place.
- **`place.departed`:** a visit inside a place completes.
- **`visit.ended`:** any visit completes, whether or not it's in a place. For
  "log where I was" rules.

**Baseline:**
- A place created (or moved or resized) during a visit doesn't fire
  `place.arrived` for that visit. Its `place.departed` also doesn't fire, so a
  newly saved place never acts on a visit already in progress.
- Edits don't replay past visits.

### Automation rules

- **`place.arrived` / `place.departed`:** a rule targets one or more of the
  user's places.
- **`visit.ended`:** optional filters on place, minimum duration, and named or
  unnamed visits.
- All require `location.read`.
- **Maximum age,** as with workouts: it applies at matching and bounds the first
  start (from arrival or departure time). The default is 1 hour for
  arrive/leave and 6 hours for visit-ended.
- **Evidence:** the visit (times, coordinate, accuracy, address, likely place),
  the matching places, and how late the trigger arrived.
- Clients state the delay: iOS reports visits several minutes after
  arrival or departure, plus upload time.

## Out of scope

- Geofence-based timeliness (phase 7).
- Shared or team places.
- Triggers on significant-change points (too sparse and noisy).

## Tests

- **Service (PostgreSQL):**
  - place matching with overlap and accuracy padding;
  - publication of arrive, depart and ended;
  - baseline on creation and edit;
  - duplicate deliveries (an arrival then a completed report);
  - out-of-order and late uploads past the maximum age;
  - deleted places;
  - history bound and owner isolation.
- **Web/iOS:** place editor and trigger editor tests.
- **Device:** arrive at and leave a saved place, and see a run with the expected
  delay.

## Implementation (October 15, 2026)

On branches `feat/places-triggers` (service, web) and mobile
`feature/places-triggers`, stacked on 6.3:
- **Migration 0056** adds:
  - `place`, soft-deleted, with `geometry_changed_at` for the baseline;
  - `data_domain_event.visit_id` and `place_id`, with unique indexes per
    (visit, type, place) and per visit for `visit.ended`.
- **`places.ts`:**
  - CRUD with a limit of 200 per owner;
  - matching: radius plus accuracy, padding capped at 200 m;
  - `publishVisitEvents`, called from `projectVisit` for v2 visits on first
    arrival and first completion.
- **Triggers:**
  - contracts, defaults and the agent tool schema for the three types;
  - matcher outcomes `place_deleted`, `visit_filter_mismatch` and
    `event_too_old`;
  - admission text with the place name, rechecking history and the place;
  - a policy check that the visit still exists;
  - visit evidence at first start (`automation-visit-context.ts`).
- **Labels and tools:** `visits` and `recent` add `places`, dropped for rounded
  app keys. Routes are under `/api/data/places`. Agent tools are `places_list`
  and `places_create`, at a coordinate or at a visit within approved history.
- **Web:**
  - Location adds "Save as place" on the selected visit and a Places section
    (edit name and radius, delete);
  - the automation editor adds the three triggers with place checkboxes,
    minimum stay and maximum age;
  - the list and reviews name the places.
- **iOS:**
  - Browse location adds Save as place (button or swipe) and a Places section
    (tap to edit, swipe to delete);
  - visit titles prefer saved places;
  - the automation editor and reviews support the three triggers.
- **Changes from the design:**
  - Places are created from a visit (or by agents at a coordinate). Address
    search is deferred.
  - Places are managed on the Location page, not a separate Personal data
    page.
  - `visit.ended` has no named/unnamed filter.
  - `timeline_query` rows aren't labeled with places; use `location_visits`.
- **Tests:**
  - `automation-places.test.ts` (isolated PostgreSQL) covers:
    - publication, duplicates, baseline and accuracy padding;
    - labels;
    - matcher filters, deleted places and staleness;
    - the first-start bound, admission text and policy;
    - evidence;
    - deletion after admission and withdrawn access.
  - Contract, tool-parsing and adapter tests.
  - Web `automation-schedule.test.ts`, `location-format.test.ts` and the
    proposal summary render test.
  - iOS contract and decoding tests.

## Rollout

- Migration 0056 is additive. Render runs it before deploy.
- Deploy the service first, then web, then iOS.
- Older iOS builds decode location rules but label them as contact rules and
  can't save them: the server rejects a definition without `place_trigger`.
  Update the app before editing these rules on iOS.
