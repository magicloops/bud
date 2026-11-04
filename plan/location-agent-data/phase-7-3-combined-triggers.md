# Phase 7.3: One timeline per conversation

Part of [location for agents, automations and apps](README.md). Follows
[7.2](phase-7-2-service-decides.md) and builds on the run messages in
`plan/automation-trigger-messages.md`.

## Problem

Each published event starts its own agent run, and each run's reply becomes a
push. The October 27 conversation showed three problems with that.

- **Lateness talk.**
  - "You arrived at the office at 3:30 PM; this notification is about 2 minutes
    late." The push actually arrived as the user walked in.
  - An arrival's time is the first reading definitely inside the 50 m radius,
    not the moment someone feels they've arrived, so the lateness was misleading.
  - Two things prompted it: the run message's "(about N minutes ago)", and the
    test rules' instruction to say how late.
- **Out of order.** "You were at 2–98 Orange Alley for about 17 minutes"
  arrived after "You arrived at the office". iOS visit reports reach the
  service minutes after geofence and reading events, so an older story landed
  on top of a newer one.
- **Stacked runs.** Events published together ("Left home" plus "Visit
  ended") start separate runs. Their replies arrive seconds apart, and the
  second push replaces the first.

## Principle

Location triggers for a conversation form one timeline, in the order things
happened.
- A run tells the agent everything that happened since the conversation's
  last location run.
- One run means one reply and one notification.
- An event that turns out to be older than one already told becomes part of
  the timeline, not a new notification.

## Design

### Wording (first, and separately shippable)

- **Event lines lose "(about N minutes ago)".** They give the time only: "Arrived
  at the office at 3:30 PM."
- **Lateness goes to the reference section,** and only when it matters: over 10
  minutes between happening and being reported (an upload backlog or an
  offline service). It says "Reported 25 minutes after it happened." No
  guidance asks the agent to mention it.
- **The test automations** (Arrive at/Leave Home and Office, Visit ended) drop
  "If this notification is more than a minute late, say roughly how late."

### Grouping (service)

- **Key:** owner plus target conversation. Location trigger types to start:
  `place.arrived`, `place.departed` and `visit.ended`. Rules that target a new
  conversation per run group by rule instead, so their runs combine their own
  events.
- **No hold time.** Admission takes the oldest due location delivery for a
  conversation, plus every other due location delivery already pending for it
  (any rule), and starts one run with all of them.
  - Events published in the same upload are matched before admission runs, so
    they combine with no waiting.
- **One location run at a time per conversation.** While one is queued or
  running, new location deliveries for that conversation wait. When it
  finishes, the next run takes everything that arrived in the meantime.
- **Schema:** many deliveries can share an invocation. The unique
  `automation_delivery_invocation_key` becomes an index. Limits, policy checks
  and history apply per delivery, as today; a delivery that fails them drops
  out of the group.

### Stragglers

A **straggler** is an event that happened before the newest location event
already delivered to that conversation (for example the Orange Alley visit
reported after the Office arrival). It doesn't start a run or a notification.
- **If a run is pending for the conversation,** the straggler joins it in its
  place in the timeline.
- **Otherwise** it's recorded in the conversation as a quiet timeline entry: a
  system message with no agent run and no push. Its delivery is
  `folded` and points at that message. The next location run includes it under
  "Earlier".

### The run's input

```
Since the last update:
- 3:09 PM: left home, after 2 hours there.
- 3:11–3:28 PM: at 2–98 Orange Alley (17 minutes).
- 3:30 PM: arrived at the office.

For the office arrival: <Arrive at Office instruction>
For the visit at Orange Alley: <Visit ended instruction>

---
For reference. Don't mention these details unless an instruction asks for them.
- Triggered by the "Arrive at Office" and "Visit ended (10+ minutes)" automations (IDs …).
- Times are in America/Los_Angeles, the phone's time zone.
- Office arrival: detected from a precise reading 33 m from its centre (±8 m).
- …
```

- **Timeline:** lines are in time order, and stragglers sit where they belong.
- **Instructions:** each rule's instruction appears once, labelled with the
  events it applies to.
- **Evidence:** first-start evidence lists every event's evidence.
- **Clients:** "Triggered by …" names all the automations. Metadata becomes
  lists: `automation_ids`, `automation_names` and `domain_event_ids`. The
  single fields stay for one-rule runs.

### Beyond location (later)

The same grouping key and timeline builder fit other trigger families where
events cluster, for example several new contacts after an import, which today
start one run each. Each family opts in. Schedules don't group.

## Open questions

- **Rules that act rather than tell.** For example "log every visit to a sheet".
  A straggler that becomes a quiet timeline entry doesn't run its rule until
  the next location run. If that's a problem, a straggler could start a quiet
  run (the agent acts, with no push) instead of only a timeline entry.
- **The run already in progress.** An event that arrives during a run waits for
  the next one. If a reply is already on its way, a second reply follows. That
  seems right, but it's worth watching on device.

## Tests

- **Service (PostgreSQL):**
  - two deliveries for one conversation pending at admission become one run
    with both instructions, in time order;
  - a delivery arriving while a run is queued or running waits, then forms the
    next run;
  - a straggler joins a pending run, or becomes a `folded` quiet entry that the
    next run includes under "Earlier";
  - per-delivery limits and policy: a failing delivery drops out and the rest
    run;
  - new-conversation rules group by rule;
  - the wording: no "(about N minutes ago)", and lateness only past 10 minutes.
- **Clients:** "Triggered by" with several automations, with fallback for older
  messages.
- **Device:** the October 27 walk. Leave home, stop somewhere, arrive at the
  Office: one notification per arrival, and the visit folded in rather than
  pushed afterwards.

## Order

1. **Wording, and the test instructions.** Small, and independent of the rest.
2. **Grouping:** admission, the schema change, the combined input and the
   metadata lists. Then the client labels.
3. **Stragglers:** quiet timeline entries and "Earlier".

## Implementation

**Step 1 (October 27, 2026), on `feat/combined-triggers`:**
- **Event lines** use `localTime` only; `timeAgo` and `when` are removed.
- **`lateReport`** adds "Reported N minutes after it happened." to the
  reference section when the time from happening to publication is over 10
  minutes (`LATE_REPORT_MS`).
- **The local test automations** were re-activated without the lateness
  clause. That's a data change, not code.

**Step 2 (October 27, 2026), on `feat/combined-triggers`:**
- **Admission** (`automation-admission.ts`) splits each delivery's checks into
  `prepare`.
  - A location delivery for a conversation with a location run still queued or
    running waits (`location_run_in_progress`, 5 s).
  - Otherwise `locationSiblings` adds every other due location delivery for the
    same conversation with the same Bud, resolved model and data access, up to
    20. Each passes its own checks.
  - Grouping only deliveries that agree on those means the run's model and data
    ceiling are those of every rule in it.
- **Migration 0060** replaces the unique delivery-to-invocation key with an
  index.
- **Input:** `timelineAdmissionText` writes the timeline, the instructions
  labelled with their rule, and the reference section (shared lines once,
  per-event lines labelled). A run of one keeps the single-event form.
- **Metadata:** `automation_name` joins the names ("Leave Home, Visit ended and
  Arrive at Office"), so the web and iOS labels need no change. The lists
  (`automation_names`, `automation_ids`, `delivery_ids`, `domain_event_ids`) are
  added.
- **Start:** `checkAutomationPolicy` checks every delivery (any paused rule
  holds the run; a deleted or revoked one ends it). `automationVisitContext`
  lists evidence for every event under `events`.
- **Known limit:** deleting one rule cancels a shared run, which drops the other
  rules' events from it.
- **Different data access in one conversation:** two location rules posting to
  the same conversation with different data access (or models) can't share a
  run. A run has one permission set, and widening or narrowing either rule's
  approval isn't acceptable. The second rule's events therefore form the next
  run, one agent turn later. **Follow-up:** activation could warn when a
  location rule's data access differs from another location rule posting to
  the same conversation.

**Step 3 (October 28, 2026), on `feat/timeline-stragglers`:**
- **Detecting a straggler:** in admission, a location delivery for an existing
  conversation whose event time is before `newestToldAt` (the newest place or
  visit-ended event among runs admitted to that conversation) is a straggler.
- **Joining:** `unstartedRun` finds a compatible location run (the same Bud,
  model and data access) that is pending, retry_wait or leased. `joinRun` adds
  the delivery (`joined_unstarted_run`) and rewrites the input message as the
  timeline from all its deliveries.
- **Folding:** otherwise `fold` inserts a system message, "Earlier: <event>"
  (origin automation, `timeline_entry`), with no run and no push. The delivery
  becomes `folded` (`older_than_last_update`, `timeline_message_id`; migration
  0061).
- **A change from the design:** the next run doesn't repeat folded entries under
  "Earlier". Messages that aren't a run's input are in the agent's conversation
  history in order, so it already sees them.
- **Clients:** quiet entries show as the existing "Triggered by <rule>" rows,
  with the text on expansion. No client change is needed.
- **New-conversation rules** run stragglers normally: there's no ongoing
  timeline to join.


## Fixes from the October 28–30 data

The service was down from about 5 PM on October 29 until 12:25 AM on October 31,
and the phone then uploaded its backlog. Old triggers were correctly suppressed.
Four problems showed up.

**1. Events published together still ran separately (service, on
`feat/presence-fixes`).** On October 29, "Left the office" and "Arrived home"
(8:53 AM), and "Left home" with its visit (9:23 AM and 4:42 PM), each became two
replies 4–10 s apart.
- **Cause:** each worker round matched one domain event and then admitted it.
  The next event's delivery, matched 50–100 ms later, found the first run
  already queued and waited for it. The grouping tests matched everything
  before admitting, so they never saw this.
- **Fix:** each round matches every published event (up to 100) before
  admitting.

**2. The backlog was processed out of order (service and phone).**
- **Cause, service:** jobs were taken by ID, and a batch's IDs share a
  millisecond, so their order within it was random.
- **Cause, phone:** retry delays apply per event. After the outage, events
  recorded during it were due at once, so they uploaded before the older
  backlog that had failed.
- **Effect on October 30:** the 2:07 PM Office arrival was lost (a 2:45 PM
  reading at Home was processed first). The 5:09 PM Home arrival was dated from
  the 12:25 AM fix taken when Bud opened, so "You arrived home at 12:25 AM" was
  sent.
- **Fix:** the service processes an owner's jobs in the order their events
  happened, and the phone sends its oldest pending events first once any is due.

**3. Walking past the Office counted as an arrival (service).** At 3:20 PM on
October 29, one reading 45 m from the Office centre (±4 m) was inside its 50 m
circle, and the next, 7 s later, was outside. That sent "Arrived at the office"
and then "Left the office".
- **Fix:** an arrival from readings waits for a second definitely-inside
  reading at least 30 s from the first, and is published at the first. Outside
  evidence first cancels it. Follow-ups stay open while it waits. Visits, and
  geofence entries without a usable reading, still arrive at once (migration
  0062: `arriving_at`, `arriving_event_id`).

**4. Standard follow-ups stopped when iOS suspended Bud (phone).** Across 30
follow-ups, live ones had readings for a median 179 s and standard ones for
67 s. On October 29 a standard follow-up stopped after 7 s, so a Home arrival
waited 33 minutes, until Bud was opened.
- **Fix:** follow-ups always use live updates. Device & Debug keeps an on/off
  switch, and the `location.follow_up.v1` diagnostics drop `mode`.

**Also:** event text read "Arrived at Home at yesterday at 11:39 PM". The local
time now includes its preposition ("at 5:36 PM", "yesterday at 5:36 PM", "on
Fri, Oct 24 at 5:36 PM").

**Still open:** walking between the Office and Home (117 m) can give no
geofence wake, because iOS already treats both regions as entered. On October 28
that left the owner "at the Office" overnight. Live follow-ups give more time to
catch the walk. Revisit after the next device walk.

## Fixes from the November 3 data

The service was offline from October 31 until about 1 PM on November 3. The
phone ran the old build until then and the new one afterwards, for the trip to
the airport and back. Combining, folding, the arrival wait, ordered processing
and live follow-ups all worked. Four problems remained.

**1. A visit could be at two places.** A visit matched every saved place within
its radius plus the visit's accuracy. One at ±87 m, 17 m from the Office and
101 m from Home, matched both. Home got a false arrival, folded as "Earlier:
Arrived at Home at 2:50 PM". Visits at 11:08 and 11:35 AM arrived at both
places.
- **Fix:** `visitPlace` returns the nearest matching place only. It's used for
  presence, rule place filters and the places listed in query results.

**2. Walking straight through the Office arrived.** At 9:48 AM the walk passed
1 m from the Office's centre and stayed inside for 53 s, at 1.1–1.9 m/s.
- **Fix:** the confirming reading must show the owner stopped. That means a
  speed under 0.5 m/s, or, without one, within 15 m of the first reading.
  Every real arrival had a reading at 0.0–0.3 m/s. The first reading's position
  comes from its stored event (`storedReading`).

**3. One outside reading became a departure.** At 11:41 AM a reading 62 m from
the Office's centre (±4 m) started the departure wait. No readings followed, so
it settled. When Bud opened at 1:03 PM, the next reading sent "Arrived at the
office". The visit shows a stay from 11:35 AM to 1:11 PM.
- **Fix:** a wait started by a reading is unconfirmed (`leaving_confirmed`,
  migration 0062). It settles once a second outside reading at least 30 s
  later, or a geofence exit, confirms it. An inside reading first ends it with
  no departure, however long it waited.
- Exit follow-ups stay open until it's confirmed. A visit completion or a
  reading inside another place still departs at once, at the wait's time only
  if that was within 3 minutes.

**4. Wording.**
- "About 2 hours" for 95 minutes confused the agent. Durations now read "about
  1 hour 35 minutes" up to 6 hours.
- Visit messages name the saved place ("A visit at Home ended …"), with the
  address in the reference section.

## Fixes from the November 4 data

The service was unreachable from about 11 PM on November 3 until 10:38 AM, so
the morning's events were skipped as too old, as intended. The trip itself
(Home → a stop 420 m away → the Office → Home, then the Office at 12:35 PM and
out at 12:45) was mostly right. Three problems remained.

**1. A merged visit named the wrong place.** iOS reported one visit from 8:53 AM
to 12:45 PM (±62 m), 46 m from the Office and 71 m from Home, covering the
Office, Home and the Office again. It fits both, so the nearest won: "A visit at
Office ended at 12:45 PM, after about 3 hours 50 minutes". Readings had the
owner home from 8:55 to 12:35.
- **Fix:** `placeOfVisit` picks, among the places a visit fits, the one where
  presence had the owner longest during it. Stays the visit itself started
  don't count. Without any, the nearest (`visitPlace`). It's used for
  presence, rule place filters, the message, evidence and query results.

**2. A departure didn't say how long the stay was.** "Left Home at 12:35 PM"
took the stay only from a visit, and had none, though Bud had published the
8:55 AM arrival. The agent replied it didn't know.
- **Fix:** a departure's stay runs from the place's previous presence event when
  that's an arrival, else from its visit.

**3. A stay with one reading was missed.** The fix when Bud opened at 12:35 PM,
7 m from the Office's centre, was the only reading until the Office's geofence
exit at 12:45. The arrival waited for a confirming reading, and the exit
cancelled it.
- **Fix:** the place's own geofence exit at least 5 minutes after a waiting
  arrival (`ARRIVAL_STAY_MS`) confirms it, at its first reading, and starts the
  departure wait. An outside reading in between would already have cancelled
  it. Walking past exits within a minute or two (October 29: 12 s).

**Not fixable:** the walk from Home to the Office around 12:30 woke nothing.
iOS had the phone inside both geofences from 8:55 AM to 12:45 PM (the places
are 117 m apart, and geofences are accurate to 100–200 m), and its visit merged
the stays. Only opening Bud noticed the move.
