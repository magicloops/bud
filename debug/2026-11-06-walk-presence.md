# Debug: November 6 walk — an early follow-up stop, and a backlog that merged two Office stays

## Environment
- Local service (`feat/place-pins`), local PostgreSQL, iPhone on bud-mobile `feature/place-pins`
  through ngrok and Caddy. Places: Home and Office, 50 m radius, about 120 m apart.
- The phone's uploads stalled from 12:19 to 14:38 (a handed-off batch; bud-mobile fix), so most
  of the walk arrived as one backlog at 14:38:08.

## Repro Steps
1. At the Office, leave on foot for Home (12:18).
2. The Home geofence fires 83 m short of Home; its follow-up's first reading (±3 m, 1.2 m/s) is
   40 m from the Office's centre, inside the Office's radius.
3. Later (13:15–13:31), back at the Office; iOS reports one visit, 11:58–13:31 (±79 m), across
   the whole time.
4. Upload the walk as one backlog.

## Observed
- **Home follow-up stopped after 1 s** (`follow_up.v1`: readings 2, sent 1, answers 2, settled).
  `settleFollowUps` saw the Office as inside with `last_entered_at` 12:18:39 (refreshed by that
  walking reading) since the report, so `arrivedElsewhere` settled it, while Home's
  `approaching_at` was set.
- **Office stays merged:** presence after the backlog: Office departed 13:31:11 (visit), Home
  arrived 12:19:50, Home departed 13:15:30, … No Office departure at ~12:19, no Office arrival
  at ~13:15. Presence-event creation order: Office departed (visit) at 14:38:08.433, then Home
  arrived (12:19:50 reading) at .465.

## Expected
- The Home follow-up keeps sampling while the owner walks toward Home.
- After the backlog: Office departed ~12:19, Office arrived ~13:15, Office departed 13:31.

## Hypotheses
- Follow-up: `arrivedElsewhere` treats a definitely-inside reading at a nearby place as being
  there, even when the reading shows the owner moving. Confirmed from the data above.
- Merged stays: jobs are processed in `occurred_at` order, and a completed visit's `occurred_at`
  is its arrival (11:58). It was processed first and departed the Office at 13:31; the 12:19:50
  reading was then older than the Office's state (`since` 13:31) and skipped. Confirmed: every
  location event was in the first batch (received 14:38:08.296), so arrival order wasn't the
  cause.

## Proposed Fix
- `settleFollowUps`: a nearby place doesn't settle an entry follow-up when the follow-up's newest
  reading shows the owner moving (speed at or above `STOPPED_MPS`); approaching keeps it open.
- `ContactProcessor.processNext`: order a completed visit by its departure (the latest moment
  it describes): `coalesce(payload.departure_at, occurred_at)`.
- Specs: `personal-data.spec.md` (place presence; processing order).
