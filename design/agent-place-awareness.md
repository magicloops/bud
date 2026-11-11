# Design: Agent Place Awareness

**Status:** Built as Phase 13 ([plan](../plan/location-agent-data/phase-13-agent-place-tools.md))
**Created:** 2026-11-06
**Related:**
- [`plan/location-agent-data/README.md`](../plan/location-agent-data/README.md) (Phases 6–12)
- [`plan/location-agent-data/phase-12-unknown-places.md`](../plan/location-agent-data/phase-12-unknown-places.md) (nearby candidates)
- [`plan/location-agent-data/phase-8-on-demand-location.md`](../plan/location-agent-data/phase-8-on-demand-location.md) (fresh location)
- [`service/src/personal-data/personal-data.spec.md`](../service/src/personal-data/personal-data.spec.md)

---

## Summary

When someone asks Bud's agent "what should I order?", the agent should work out that they're
probably at the taqueria 12 m from where their phone stopped ten minutes ago, check what it
serves, and answer, saying in a clause what it assumed. It shouldn't ask them to confirm where
they are, and it shouldn't make them label places for it.

Bud already knows a lot: visits, precise readings, saved places, and (since Phase 12) the named
places near a visit. What the agent lacks is a way to **ask about places at question time**: to
search near the user for what the question is about, to look up one place's details (hours,
cuisine, website), and to know how fresh the location is. This doc proposes those agent tools and
the guidance that makes the agent infer rather than ask.

The principle: **location is evidence the agent reasons over, not facts the user verifies.** The
question is often the strongest clue (an ordering question points at food places), and calendar
access later will be another source of evidence the agent weighs, not something to confirm.

---

## Goals

- The agent can answer place-dependent questions ("what should I order?", "is the pharmacy near me
  open?", "where did I have lunch on Tuesday?") from the data, inferring the likely place.
- It searches around the user's location for what the question is about, at question time, rather
  than relying only on the five candidates stored when a visit was named.
- It knows how fresh and how precise the location is, and says when that limits the answer.
- It states its assumption briefly and asks only when candidates genuinely conflict and the answer
  depends on which one it is.
- No new user-verified data: no labelling, no confirmations, no new screens.

## Non-goals

- Predicting where the user will go (calendar, later).
- A model that guesses the visited place in the background and stores it as fact.
- Showing candidates in the apps (possible later; this is about the agent).
- Navigation or routing.

---

## Scenarios

**"What should I order?"** at 7:10 PM.
- Latest location: an in-progress iOS visit that started at 6:58, ±25 m; a fix from 7:02, ±6 m.
- Nearby, food only: Taquería El Farolito (restaurant, Mexican, 9 m, open until 2 AM), Tacos
  Cancún (14 m, open), a laundromat (20 m).
- Agent: searches food places within 30 m of the fix, sees two taquerias, looks up both, and
  answers for the nearer one while naming the other: "Assuming you're at El Farolito (or Tacos
  Cancún next door), the super burrito al pastor is the classic…".

**"Is the pharmacy near me still open?"**
- Agent: `places_nearby` with a pharmacy category around the latest location, then details for the
  nearest; computes open now from its hours in the place's time zone.

**"Where did I have lunch on Tuesday?"**
- Agent: `location_visits` for Tuesday noon to 2 PM, then the nearby food places for that visit
  (stored candidates, or a search if there are none), and answers with the likeliest one and its
  confidence.

**"How long have I been here?"** (no saved place)
- Agent: `location_recent`: an in-progress visit since 2:14 PM, so about 40 minutes, near
  Ritual Coffee.

**Stale location**: the last fix is three hours old and no visit is open.
- Agent says it doesn't know where the user is now and answers generally, or (with on-demand
  location, Phase 8) asks the phone for a fresh reading.

---

## What exists today

| Capability | Where | Limit |
|---|---|---|
| Latest location (visit, fix or point), its age and saved place | `location_recent` | Often minutes to hours old; no "since when" for fixes |
| Visits with address, saved places, nearby candidates, match clarity, earlier visits | `location_visits`, `location_recent`, evidence | Candidates were picked when named, without the question; 5 at most; one category each |
| Saved places | `places_list` | Only what the user saved |
| Web search and fetch | existing agent tools | Needs a name to search for |
| Place search (addresses and businesses) | `/api/places/search` (pin editors) | Not an agent tool |

The gap is the middle: the agent can see a coordinate and a few names, but can't ask "what kind of
places are here, and are they open?".

---

## Proposal

### 1. `places_nearby` (new agent tool)

Search for named places around a point, filtered by what the question is about.

- **Where:** `near` is `latest` (the latest location), a `visit_id`, or a coordinate. `latest`
  and visits resolve through the same history and permission checks as the other location tools.
- **What:** optional `categories` (Geoapify categories, for example `catering.restaurant`,
  `healthcare.pharmacy`, `commercial.supermarket`) and optional `text` (matched against names,
  for example "taco").
- **How far:** `radius_m`, defaulting to the location's accuracy (at least 30 m, at most 1 km).
- **Returns:** up to 10 places, nearest first: name, `place_id`, distance, category and readable
  label, cuisine, `opening_hours` and `open_now` when known, and the location it searched from
  (with its age and accuracy), so the agent can weigh both.
- **Implementation notes:** the Geoapify Places API with the same two-group rule as naming when
  no categories are given (broad categories drop out of mixed lists; see the Phase 11 plan). When
  the agent names categories, they're grouped the same way. One or two credits per call.

### 2. `place_details` (new agent tool)

One place's details, by `place_id` from `places_nearby` or from a visit's candidates.

- **Returns:** name, address, categories, `catering.cuisine`, `opening_hours` (OpenStreetMap
  format) with `open_now` computed in the place's time zone, `website`, `contact.phone`,
  `brand`, and facilities like `takeaway` and `delivery`.
- With the existing web tools, the agent can then find a menu from the website or the name.
- Geoapify Place Details: one credit.

### 3. Richer stored candidates

When a visit is named, keep each candidate's most specific category and cuisine (OpenStreetMap
often has `catering.restaurant.mexican`), not just one category and a coarse label. Then a
taqueria shows up in `location_recent` without another lookup. Hours aren't stored: they're
fetched with `place_details` when the question needs them.

### 4. Freshness on the latest location

`location_recent` already reports age. Add what the agent needs to reason about "now":
- `since`: when the owner arrived where they are (the open visit's arrival, or the first of a run
  of fixes within the accuracy);
- `moving`: whether the latest readings show movement (speed, or distance between readings);
- a one-line `now_note`: "Probably still here: an open visit since 6:58 PM and a fix 8 minutes
  ago" or "Last seen 3 hours ago; may have moved".

Fresh location on demand is Phase 8 (`location_current`, a silent push). This design works without
it and gets better with it.

### 5. Guidance

In the tool descriptions and the system prompt:
- **Infer, then answer.** Combine the question's intent, the candidates (filtered to what the
  question is about), their distances against the accuracy, the time of day, how long the user has
  been there, and opening hours.
- **State the assumption in a clause**, naming close alternatives: "Assuming you're at El Farolito
  (or Tacos Cancún next door)…".
- **Ask only when it matters**: the plausible candidates would give different answers, and the
  question can't be answered for both. Then ask one short question with the candidates as choices.
- **Say when the data runs out**: stale location, nothing nearby, or hours unknown.
- **Don't store inferences** as facts; they're answers in the conversation.

---

## Permissions and privacy

- Both tools need `location.read`, like the other location tools. `near: latest` and visits
  respect the approved history window. A coordinate given by the agent is allowed (place data is
  public), but the response never reveals the user's own readings beyond what `latest` resolves to.
- Apps with app keys don't get these tools at first. If they do later, `rounded_2_decimals` keys
  get no nearby search (as with candidates today).
- The service sends coordinates to Geoapify, as visit naming already does (the Phase 11 privacy
  note covers it).

## Cost

- `places_nearby`: one credit, or two without categories (both groups). `place_details`: one.
- A typical "what should I order?" is one search and one or two details: two to four credits.
- The daily credit cap applies; when it's reached, the tools return a clear "place lookup
  unavailable" error, and the agent says so.

## Risks

- **Confident wrong answers.** The nearest place isn't always the one. Mitigations: the clarity
  signal (`match`), naming close alternatives, and the guidance to state assumptions.
- **Stale or coarse location.** An iOS visit can be ±100 m and minutes old. `since`, `moving` and
  `now_note` make that explicit; Phase 8 fixes it properly.
- **OpenStreetMap gaps.** Some places are missing, or have no hours or cuisine. The agent can fall
  back to web search by name and address.
- **Hours parsing.** OpenStreetMap's `opening_hours` syntax is rich (holidays, exceptions). Use a
  maintained parser and report `open_now: null` when it can't decide.

## Evaluation

Scenario tests with recorded location data and Geoapify responses: the agent picks the right place
(or names both) for food, pharmacy and lunch-on-Tuesday questions; says when location is stale;
asks only in the genuinely ambiguous case. Live checks on a walk: ask "what should I order?" at a
few places.

## Open questions

- **Categories from the agent:** should `places_nearby` accept free category names ("tacos") and
  map them, or only Geoapify categories plus `text`?
- **Latest location for `near: latest`:** the most precise recent reading, or the open visit's
  coordinate when both exist?
- **Hours parser:** `opening_hours` (the JavaScript library used by OpenStreetMap tools) or a
  smaller subset?
- **Caching:** cache details by `place_id` for a day to save credits (Geoapify allows storing)?
- **Calendar, later:** how event locations rank against nearby candidates ("dinner at Nopalito at
  7" should win over the nearest place).
