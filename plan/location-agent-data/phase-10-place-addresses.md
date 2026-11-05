# Phase 10: Place addresses — the address the user gave, saved with the place

Status: planned (2026-11-05). Built on the Phase 9 branches (`feat/place-pins`,
`feature/place-pins`).

## Goal

When the user names a place by its address ("save 3327 26th St as Home"), or picks a search
result while placing a pin, the place keeps that address. Agents and messages then say "Home,
3327 26th St" from what the user told us, instead of the reverse geocode of whatever the phone
measured, which names the nearest address to a coordinate and is often a neighbour's (November
4: a visit at the Office was named "3384 26th St").

## Decisions

- **A place has an optional `address`: text the user saw and accepted.** It's a label, like the
  name. It never moves the pin, and the pin never rewrites it.
- **Where it comes from:**
  - picking a search result in the pin editor fills it with that result's address;
  - a place question starts it from the agent's `query`, which is usually the user's own words,
    until a search result replaces it;
  - the user can type, edit or clear it in the editor and in place details;
  - an agent may pass one to `places_create` only if the user stated it. Agents never look one
    up or fill one in from reverse geocoding.
  - Moving the pin by hand leaves it as it is.
- **The saved address wins over reverse geocoding** wherever we describe a saved place. A
  visit's own reverse-geocoded address is still reported for the visit, labelled as Apple's
  nearest match, so a mismatch stays visible rather than hidden.
- **The same privacy as a street address.** Agents see it under `location.read`, like the
  place. App keys with `rounded_2_decimals` get no saved places today, so no addresses either.

Not in scope: geocoding an address into a pin (Phase 9 decided the user places the pin); keeping
addresses in sync with the pin; structured address fields.

## Service

**Schema** (migration `0063_place_address.sql`): `place.address text null`, at most 300
characters once trimmed (a check constraint, like the radius one). Existing places get null.

**API** (`places.ts`, `routes.ts`)
- `placeCreateSchema` and `placeUpdateSchema` accept `address` (string, or null to clear on
  update). Empty after trimming means null.
- An address-only update is not a geometry change: no presence reset, no new geometry revision.
- `presentPlace` returns `address`.

**Place questions** (`user-question-contracts.ts`, `user-question-repository.ts`)
- The answer gains optional `address` (≤300 characters). `savePlaceAnswers` saves it with the
  place: on create, and on update only when it changed (an address change alone keeps presence).
- The tool result and `display_answer` include it ("Saved Home, 3327 26th St, San Francisco,
  at 37.749003, -122.416487 with a 50 m radius").

**Agent tools** (`agent-queries.ts`, `personal-data-tools.ts`)
- `places_list` and `places_create` results include `address`.
- `places_create` takes `address` for an address the user stated; its description says never
  to guess or look one up. (`null` already means absent, from the November 4 review fix.)

**Messages and evidence** (`automation-admission.ts`, `automation-visit-context.ts`,
`location.ts`)
- **Visit ended at a saved place:** the reference line becomes "Home is at 3327 26th St, San
  Francisco (the user's saved address)." from `place.address`. Without one it keeps today's line
  from the visit's name, worded as Apple's nearest address ("Home's nearest address from Apple
  Maps is …").
- **Arrived and left:** the reference adds "Home is at …" when the place has an address. Today
  these lines have no address at all.
- **Evidence** (`automationVisitContext`): the trigger `place` and `saved_places_at_visit`
  entries carry `address`. A visit's own `address` stays as it is, alongside.
- **Query results:** places listed on visits and `recent` (`visitPlaces`, `matchingPlaces`)
  carry `address`, except for rounded app keys (which get no places).
- The fixed "Place event evidence" preamble says a saved place's address is the user's, and a
  visit's address is Apple's nearest match.

## Web

- **Pin editor** (`place-pin-editor.tsx`, `lib/place-pin.ts`): an Address field below the name.
  Picking a search result sets it to the result's formatted address; seeded from the question's
  `query` or the place's address; editable and clearable. Saving sends it; edits send it only
  when it changed.
- **Location screen:** saved places show their address under the name.
- **Place questions** (`question-request-card.tsx`): the row shows the chosen address, and the
  answer carries it.

## iOS

- **`PlaceMapEditor`**: the same Address field. A chosen `MKLocalSearch` result fills it (its
  placemark's formatted address); seeded from `query` or the place; editable and clearable.
- **Browse location:** saved places show their address; `PersonalPlace`, `PersonalPlaceCreate`
  and `PersonalPlaceUpdate` gain `address` (update sends it only when it changed).
- **Place questions:** the answer carries the address.

## Order

One pass on each branch, after the Phase 9 work: service (migration, API, answers, messages and
evidence), then web and iOS. Deploy order: service first, so the clients can send `address`.

## Testing

- Service: migration up on a copy; create, update and clear an address; an address-only update
  keeps presence and the geometry revision; place answers save it; the tool result shows it;
  the visit-ended and arrival messages use it, and the fallback wording when there's none;
  rounded app keys see no saved places; `places_create` stores a given address.
- Web and iOS: a search result fills the field; the question's `query` seeds it; moving the pin
  keeps it; edits send it only when it changed; clearing sends null.
- Device: save Home from its address and nudge the pin; the next arrival message says Home's
  saved address, not the reverse geocode.

## Open questions

- **Apple terms (with Phase 9's check):** the address can be Apple's formatted text from a
  search result the user picked, stored with the place. Check that alongside the pin.
- **Pin far from its address:** if the user drags the pin well away from the result they picked
  (say over 100 m), should the editor ask whether the address still applies? Start without it.
