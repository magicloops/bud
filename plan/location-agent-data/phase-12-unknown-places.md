# Phase 12: Unknown places — more context for visits not at a saved place

Status: implemented (2026-11-06), service only, on `feat/place-pins`. One change from the plan:
the candidates are a new `nearby` column (migration 0065), not keys inside `place`, which several
places present directly as the likely place. Apps get candidates on visits only (not timeline
points), and none at rounded precision.

## Why

When a visit isn't at a saved place, the agent knows least, yet it gets the least: one address
and one "likely place", the nearest named point of interest within 100 m. With readings and visits
accurate to ±10–80 m, the nearest place is often not the one the owner went to (November 5, 8:47 PM:
"The Fold" at 11 m against Apple's "Fort Help Mission" at 25 m). The agent can't tell a confident
match from a coin toss, or know what else was there, or whether the owner goes there often.

Geoapify's lookup already returns up to 40 named places and the neighbourhood, and its terms let
us keep them. Most of this costs no extra credits.

## Goal

For a visit or fix that isn't at a saved place, the agent gets:
- the **address and area** ("1101 Capp Street, Mission District");
- the **nearby places**: up to 5 named candidates, nearest first, with a readable category and
  distance;
- **how clear the match is**: one place much nearer than the rest, or several close together;
- **earlier visits nearby**: how often the owner has been here before (within approved history),
  and the place most often seen with those visits.

The agent can then say "probably Finjan Qahwa or Cappstone", or ask. Visits at a saved place
don't change: the place's name and the user's saved address stay the answer.

## Decisions

- **Candidates, not facts.** Everything is labelled as candidates from OpenStreetMap; the
  evidence keeps saying a likely place is unverified. `likely_place` stays the nearest.
- **Stored with the name.** The candidates and area are saved in `location_visit_name` when the
  visit is named (no extra lookups later). No migration: they're new keys in the existing JSON.
- **Within the visit's accuracy.** Candidates come from within max(100 m, accuracy), capped at
  200 m, so a coarse visit gets a wider set and a precise one a tight set.
- **A fixed rule for clarity**, not a model's judgement (below).
- **History follows the grant.** Earlier visits count only within the agent's approved history
  window, as every other location query does.
- **Saved places unchanged**, and apps with `rounded_2_decimals` get none of this (they already get
  no place and only city or region).

Not in scope: guessing the visited place with a model; storing the user's corrections (a later
"that was Cappstone" could be a saved place or a label); changing trigger messages beyond the
reference section.

## Service

**Naming** (`geoapify.ts`, `visit-naming.ts`)
- `nearbyPlaces(lat, lon, radiusM)` returns the merged, de-duplicated candidates (both category
  groups, `conditions=named`, bus stops skipped), nearest first, up to 5. `nearbyPlace` becomes the
  first of them.
- Radius: max(100, min(accuracy, 200)) metres. The two requests stay at `limit=20` (one credit
  each), so the cost doesn't change.
- `reverse` keeps `suburb` and `district` (Geoapify's neighbourhood fields) as `area`.
- `location_visit_name.place` keeps the nearest (shape unchanged); `address` gains `area`, and a
  new `nearby` array holds the candidates: `{ name, category, category_label, coordinate,
  distance_m }`.
- `category_label`: a short readable label from Geoapify's category (`catering.cafe` → café,
  `sport.fitness` → gym, `office` → office), with a fallback to the last segment.

**Clarity** (computed when presented, so the rule can change without renaming)
- `none_close`: no candidate within the accuracy (at least 30 m); the nearest is further.
- `clear`: the nearest is within reach, and the next candidate is further by at least the
  accuracy (at least 10 m), so the reading's error can't swap them; or there's no other.
- `several`: otherwise. (Built first as "twice as close"; on November 5 that called a ±96 m visit
  with places at 15 m and 35 m clear.)
- Presented as `match: "clear" | "several" | "none_close"` with one sentence for the agent.

**Earlier visits** (`location.ts`)
- For a visit or fix: completed visits whose coordinate is within 50 m, started within the
  approved history window and before this one. Returns `count`, `first_at`, `last_at`, and the
  most frequent `likely_place` name among them, when one appears in at least half.
- Bounded: at most the last 200 visits in the window; an index on `location_visit (created_by_user_id,
  started_at)` already exists. Computed when presented, not stored.

**Where the agent sees it** (only when the visit isn't at a saved place)
- **Visit-ended evidence** (`automation-visit-context.ts`): `visit.address` with `area`,
  `visit.likely_place`, `visit.nearby_places`, `visit.match` and `visit.earlier_visits`.
- **Trigger text reference** (`automation-admission.ts`): one line, "Nearby (OpenStreetMap, within
  N m): Finjan Qahwa (café, 19 m), Cappstone (shop, 25 m), …", and one for earlier visits when there
  are any ("Been here 6 times since Oct 12; usually near Finjan Qahwa").
- **Location tools** (`location_visits`, `location_recent`, `timeline_query`): the same fields on
  each visit and fix. `earlier_visits` only on `location_recent` and single-visit evidence (a list
  of 200 visits would multiply the query).
- The evidence preamble says nearby places are candidates within the visit's accuracy, nearest
  first, and that `match` describes how clear the nearest one is.
- **Apps** with `rounded_2_decimals`: no `nearby_places`, `match` or `earlier_visits`, and `area`
  only at city level. `as_collected` apps get them like agents.

**Backfill**: `db:geoapify-visit-names --rename` gains the candidates and area for the names it
writes. Existing Geoapify names get them on their next rename (or a `--refresh` flag).

## Clients

No change needed. Optionally later: Browse location and the web Location screen could show
"Nearby: …" under a visit that isn't at a saved place.

## Testing

- `nearbyPlaces`: radius from accuracy and its bounds; up to 5, nearest first; de-duplication
  across groups; labels.
- Clarity: each case at its boundaries (twice as close, the 30 m floor, a single candidate).
- Earlier visits: within 50 m and the history window; before this visit; the frequent place's
  half rule; owner isolation.
- Evidence and reference lines for an unknown place; none of it for a saved place; rounded apps.
- Replay: the November 5 visits, checking the candidates include Apple's pick where it's within
  range.

## Open questions

- **How many candidates:** 5, or fewer when the visit is precise?
- **Earlier visits on lists:** worth the cost on `location_visits` too, or only on single visits?
- **Corrections:** when the owner tells the agent which place it was, where should that live: a
  saved place, or a lighter per-visit label?
