# Phase 9: Place pins — see, move and choose places on a map

Status: implemented, not yet run against real maps (2026-11-05).
- Service: the MapKit JS token endpoint (`maps.ts`), the `place` question kind and saving
  answers (`user-question-contracts.ts`, `user-question-repository.ts`), and agent guidance.
- Web: `place-pin-editor.tsx` (MapKit JS), the location screen and place questions; without a
  Maps key it falls back to saving the starting pin, and the OpenStreetMap visit map.
- iOS: `PlaceMapEditor.swift`, Browse location and place questions.
- Still to do: create the Apple Maps key, try both editors with real maps and search, and the
  terms check below.

## Goal

People can see a saved place on a map, move its pin onto the real spot, and set its radius by
eye. An agent asked to "save 3327 26th St as Home and 3384 26th St as work" asks the user to place
each pin, starting from a search for the address, and gets back what the user saved.

Today a place's centre comes only from a reading, a visit or coordinates the agent is given.
Readings and visits can sit tens of metres from the real spot, and with 50 m places (Home and the
Office are 117 m apart) that decides whether arrivals count. Nobody can see or correct it, and
agents can't save a place from an address at all.

## Decisions

- **The user confirms every coordinate saved from a search.** The agent never saves a
  geocoded coordinate. It asks; the user chooses the pin on a map, and that pin is what's stored.
  Search results stay in the app or browser while the user chooses. This keeps us within the
  Apple Maps terms, which allow only temporary use of search and geocoding results.
- **Apple on both platforms.** MapKit and `MKLocalSearch` on iOS; MapKit JS (map and search) on
  web. MapKit JS shares the team's free allowance with the Maps Server API (25,000 service calls
  and 250,000 map views a day). No server-side geocoding, and no Google.
- **A `place` question kind, not a new request type.** `ask_user_questions` already parks the
  run, shows the request inline on iOS and web, resumes with the answer and handles expiry,
  skipping and cancellation. A place is one more answer kind. Automation proposals' versioning
  and staleness checks aren't needed: the answer is the user's own save.
- **`places_create` stays** for exact coordinates, visits and "save where I am now" (the latest
  precise reading), which need no picker.

Not in scope: server-side geocoding; saving places from search without the user; changing the
50 m minimum radius.

## Part 1: The pin editor

One editor for viewing, moving and creating a place: a map with a fixed pin at its centre (you
move the map under the pin, as Apple's apps do), the radius drawn as a circle, a radius control
(50–2,000 m) and Save. It shows a reading's accuracy circle when it starts from one.

**iOS** (`BudApp/UI/PersonalLocationView.swift`)
- `PlaceMapEditor`: SwiftUI `Map` with `MapCircle` for the radius; the centre is the camera
  position (`onMapCameraChange`). iOS 18 target, so no availability checks.
- Browse location → a place opens the editor (replacing the name/radius sheet). "Save this
  location as a place" and "Save as place" open it centred on the reading or visit.
- Moving sends `PUT /api/data/places/:id` with `latitude`/`longitude` only when the centre
  changed (the service already accepts this). `PersonalPlaceUpdate` gains the coordinate.
- Search box in the editor (`MKLocalSearchCompleter`, then `MKLocalSearch` for the chosen
  completion) to jump the map; used by Part 2 too.

**Web** (`web/src/components/location-screen.tsx`)
- MapKit JS editor with the same behaviour; search with `mapkit.Search`.
- The visit map moves from the OpenStreetMap embed to MapKit JS, so there's one provider.
- Saved places get "View on map / Move" (create and edit both use the editor).

**Service**
- `GET /api/maps/token`: a short-lived MapKit JS token (JWT, `origin` restricted to the web
  app's origins), signed with an Apple Maps key. Config: team ID, key ID, private key, like the
  APNs key. Authenticated.
- Moving a place already resets its presence and changes its geometry revision, so the phone
  reinstalls its geofence and visits that began before the move never trigger for it. Check the
  phone picks up a move on its next sync, and say in the editor that moving starts presence over.

## Part 2: Place questions

**Contract** (`service/src/agent/user-question-contracts.ts`)
- New kind `place`. The question carries `place: { name, query?, place_id?, radius_m? }`:
  - `query`: address or search text the picker starts from ("3327 26th St, San Francisco");
  - `place_id`: an existing place to move (the picker starts at its centre);
  - `radius_m`: the agent's suggested radius (for instance 50 for a house, 300 for a campus);
    default 100 for a new place, the place's own when moving. The picker starts with it and
    the user can change it before saving, so the saved radius is always the user's.
- Answer: `{ kind: "place", name, latitude, longitude, radius_m }`. Skipping is "not now".
- The service saves the place **when it accepts the answer**, in the same transaction: create,
  or move the given place. The place is saved by the user (`created_by: "user"`). An answer
  for a place deleted meanwhile, or out of range, is refused (409) and the prompt stays.
- Tool result to the agent: `{ status: "saved", place: { id, name, coordinate, radius_m },
  operation: "created" | "moved" }`, or skipped. No search result ever reaches the agent.

**Agent guidance** (tool descriptions in `personal-data-tools.ts` and the question tool)
- For an address, a business or "move my X": ask a place question; don't guess coordinates or
  look them up on the web.
- Several places in one request (home and work) are one `ask_user_questions` call with a place
  question each.
- `places_create` only for exact coordinates the user gave, a visit, or "where I am now".

**iOS** (`BudApp/Chat/UI/AskUserQuestionsPromptView.swift`)
- `place` renders as a row ("Home — 3327 26th St") with "Choose on map", which opens the
  editor searching for `query` (first result centred, others listed). Submit sends the chosen
  centre and radius.

**Web** (`web/src/components/workbench/question-request-card.tsx`)
- Same, with the MapKit JS editor in a dialog.

## Order and PRs

1. **Service:** MapKit JS token endpoint; places accept moves from clients. Small.
2. **Pin editor, iOS and web.** Useful on its own: fixes offsets in existing places.
3. **Place questions:** contract, answer-time save, tool guidance (service); place prompts on
   iOS and web, reusing the editor.

Deploy order for 3: service first (clients must not send `place` answers it can't accept), then
web and the iOS build. Older clients aren't supported (pre-launch; we control the builds).

## Testing

- Contract: request and answer validation; a place answer creates or moves exactly once; skip;
  a deleted or out-of-range place is refused and the prompt stays; the tool result.
- Presence after a move: reset, new geometry revision, earlier visits don't trigger.
- iOS and web: editor moves only when the centre changed; radius limits; search seeded from
  `query`.
- Device: save Home from its address, nudge the pin, and walk in; arrivals confirm as with a
  reading-saved place.

## Setup

- **Apple Developer:** we create the Maps ID and the MapKit JS private key, and list the web
  origins for tokens (local, dev and prod). The service reads the team ID, key ID and private key
  from config, like the APNs key.

## Decided

- **Radius:** new places default to 100 m (a searched pin starts at the address, often the
  street frontage). The agent may suggest another radius in the question; the user sets the
  final one in the picker, and can change it later in the editor.
- **Older clients** don't need handling.

## Open questions

- **Apple terms — resolve before merging anything that ships search** (the editor's search in
  Part 2, and Part 3). Confirm that storing a user-confirmed pin, chosen starting from an Apple
  search result, is within the Apple Maps / MapKit terms. Check at the same time what we already
  store from Apple: the phone's reverse-geocoded names and addresses for visits
  (`location.visit_named.v1`), which the service keeps.
- **Recentring on the first stay:** offer to move a place's centre to where confirmed readings
  put the user. Later; the editor makes it a one-tap move.
