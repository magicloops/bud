# Phase 6.2: Place names for visits

Part of [location for agents, automations and apps](README.md). Requires 6.1
(visit identity).

## Problem

Agents and screens see `37.7749, -122.4194 ± 30 m`. People think in places
("Blue Bottle Coffee, Mint Plaza" or "Home"). Without names, location answers
need a map to read, and automations can't describe where you were.

## Design

### Naming on the phone

- **When:** when a visit completes (`phase: completed`), the producer looks up:
  - an **address**, by reverse geocoding;
  - a **likely place**: the nearest point of interest within the visit's
    accuracy (minimum 50 m), from MapKit's points-of-interest search.
- **API choice (decided October 15, 2026):** MapKit's `MKReverseGeocodingRequest`
  only, with no `CLGeocoder` fallback. It needs iOS 26, while the app supports
  iOS 18, so phones on older versions send no names; everything else works
  unchanged.
- **Payload:** results go into a `location.visit_named.v1` envelope keyed by
  `visit_key`, rather than holding back the visit. The visit stays durable
  even if naming fails or is offline. Fields:
  - `address`: name, thoroughfare, locality, administrative area, postal code,
    country code;
  - `place`: name, category, coordinate, distance in metres; or null;
  - `source: "apple"`, `named_at`.
- **Limits and caching:**
  - Apple rate-limits geocoding per app, and visits are few per day (typically
    under 20).
  - Requests run one at a time, at most one every 2 seconds.
  - Results are cached in the event store by a coordinate rounded to ~50 m, for
    30 days.
  - Failed lookups retry on the next foreground or completed visit, with
    backoff. Names are never required for anything to work.
- **Uncertainty:** the place is a candidate ("likely"), not a fact. The payload
  keeps its distance, and clients and agents present it as "near" or "likely
  at" when the distance exceeds the visit's accuracy.

### Service

- Processing stores names on the observation, keyed by `visit_key`:
  - a `location_visit_name` table (owner, `visit_key`, address JSON, place
    JSON, `named_at`), or columns on the 6.3 visit projection if that lands
    first.
  - Later names for the same visit replace earlier ones.
- `timeline_query` and app location results include `address` and `place` when
  available, under the existing `location.read` scope and precision settings.
  With `rounded_2_decimals`, apps get the locality only: no street address and
  no place within 1 km.

## Out of scope

- Server-side geocoding providers.
- Naming significant-change points: only completed visits are named.
- User-defined places (6.4).

## Tests

- **TimelineCore:**
  - cache key rounding and expiry;
  - throttle and backoff;
  - envelope mapping, using an injected lookup (no network).
- **Service:**
  - name processing, with replacement by later names and owner isolation;
  - precision rules for apps (rounded keys never receive street or place).
- **Device:** visit a known café and see the address and likely place in the
  timeline; offline naming retries later.

## Rollout

Additive event type and table, with a migration if a table is used. Older
builds simply send no names.
