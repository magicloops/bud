# Plan: Location for agents, automations and apps

## Context

- Scoped October 15, 2026. This replaces phases 6–7 of
  [location and health agent data](../location-and-health-agent-data.md), which
  covered only places and triggers.
- Location is the weakest personal-data source today:
  - Capture is sparse and isn't reliably saved.
  - The app never asks properly for permission or shows whether collection is
    working.
  - Agents and apps get bare coordinates with no names.
  - The only screen is a pin on a contact's detail page.
  - Nothing can trigger on location.
- Related specs: [personal-data](../../service/src/personal-data/personal-data.spec.md),
  [agent](../../service/src/agent/agent.spec.md), mobile `TimelineCore`
  producer docs (`../bud-mobile/plan/03-location-producer.md`).

## What exists

| Layer | State |
|---|---|
| Mobile capture | `LocationProducer`: `CLVisit` plus significant-change points (the latter with Always only). Appends run in an unawaited `Task` from delegate callbacks, with no background-time protection. iOS reports each visit twice (arrival, then the completed visit); both are uploaded. |
| Permission | Debug-style "Request Location (When In Use/Always)" buttons in onboarding and settings. No status, explanation, reduced-accuracy warning or upgrade path to Always. |
| Service | `location_observation`: one row per raw event (`visit` or `significant_change`), coordinates, accuracy, arrival/departure. No visit merging, no names, no per-type status. |
| Agents | `timeline_query` (raw observations, ≤ 31 days) and `location_context` (nearest point to a contact's detection). |
| Apps | `/api/app-data/location` and contact location context, with optional 2-decimal rounding. |
| Screens | Contact detail pin only. Web lists Location as "Coming later". |
| Triggers | None. |

## Sub-phases

Each sub-phase ships on its own with its own PRs and manual checks. They run in
order, because each builds on the one before.

| | Sub-phase | Delivers | Where |
|---|---|---|---|
| 6.1 | [Reliable capture and permission](phase-6-1-capture-and-permission.md) | Durable location writes; a stable visit identity; a Location section with permission state, the Always upgrade and last received | iOS, small service change |
| 6.2 | [Place names](phase-6-2-place-names.md) | Visits named on the phone (address and likely place), rate-limited and cached | iOS, service |
| 6.3 | [Location for agents and screens](phase-6-3-agents-and-screens.md) | Merged visits, recent/current location for agents, named timelines, history and map on web and iOS, app access | Service, web, iOS |
| 6.4 | [Named places and triggers](phase-6-4-places-and-triggers.md) | Your places, plus arrive, leave and visit-ended automations | Service, web, iOS |
| 7 | [Timely place triggers (optional)](phase-7-geofences.md) | Geofences, if 6.4's visit-based triggers prove too slow | iOS, service |

**Why this order:**
- Everything depends on reliable capture (6.1).
- Names (6.2) are the biggest experience improvement and bring their own
  constraints (rate limits, offline, caching).
- 6.3 makes location visibly useful.
- Presence triggers (6.4) are the trickiest logic and come last, on named and
  merged visits.

## Decisions

Defaults that each sub-phase can proceed on; revisit before that sub-phase
starts.

1. **Naming source:** Apple's MapKit reverse geocoding (`MKReverseGeocodingRequest`,
   iOS 26+; no fallback for older iOS) and nearby points of interest. There's no server-side geocoding provider:
   no extra vendor, cost or API key. Coordinates go only to Apple's service, as
   the system already does for Maps.
2. **No continuous tracking.** Collection stays on visits and significant-change
   points, which are low power. Continuous or route tracking (e.g. during
   workouts) is a separate decision.
3. **Always permission** is requested explicitly, with an explanation, and only
   after the user turns location on. "When In Use" is shown as limited
   (visits only while the app is open).
4. **Places are labels, not permissions** (from the original plan): agents may
   create them, and the user can see and edit them.

## Cross-cutting

- **Privacy:** the agent grant, app policies and precision rounding apply to
  every new query and tool. Names and addresses count as location data under
  `location.read`.
- **Contract style:** new envelope versions, no compatibility paths for older
  builds, with the service storing unknown events raw (as health did).
- **Testing:** PostgreSQL fixtures in isolated schemas, TimelineCore package
  tests for pure logic, and a device checklist per sub-phase added to
  `../bud-mobile/MANUAL_TESTING.md`.
