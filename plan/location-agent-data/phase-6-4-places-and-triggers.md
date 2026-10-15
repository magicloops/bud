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

## Rollout

- Migrations add `place` and `data_domain_event.visit_id`.
- Service, then web and iOS. Older iOS builds can't decode the automation list
  once a place rule exists, as with schedules and workouts.
