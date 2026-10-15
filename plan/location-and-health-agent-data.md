# Plan: Location and health data for agents, automations and apps

## Context

- Scoped October 14, 2026, after a source review of the contacts pipeline in this
  repo and the producers in `../bud-mobile`.
- **Phases 1 and 2 implemented October 14, 2026** (branches
  `feat/general-automation-triggers` here and `feature/schedule-automations` in
  mobile). See "Phases 1–2 implementation" below for deviations.
- **Phase 3 implemented October 14, 2026** (mobile branch
  `feature/health-capture-durability`; details in mobile
  `plan/04-healthkit-producer.md`). Not done from the phase 3 list:
  - installing observers at launch before the network profile bootstrap;
  - awaiting location appends.

  Both remain open. Phases 4–8 are not started.
- Builds on [personal data ingestion and agent triggers](../design/personal-data-ingestion-and-agent-triggers.md)
  and its [implementation spec](personal-data-ingestion-and-agent-triggers/implementation-spec.md).
  Replaces the two deferred items in [TODO.md](../TODO.md) ("HealthKit durability…"
  and "Geographic regions, named places…").
- Related specs: [personal-data](../service/src/personal-data/personal-data.spec.md),
  [agent](../service/src/agent/agent.spec.md), [db](../service/src/db/db.spec.md),
  mobile `TimelineCore` producer docs.

## Objective

Give location and health the same experience contacts has. Agents can query the
data, automations can trigger on it, and approved private apps can read it.
Mobile and web manage everything with the same server state.

## Where things stand

| Layer | Contacts | Location | Health |
|---|---|---|---|
| Mobile capture | `ContactsProducer` (snapshot diff) | Visits and significant changes | Workouts and sleep; anchor saved before unawaited writes |
| Typed tables | `contact`, `contact_revision` | `location_observation` | None; raw events marked unsupported |
| Trigger events | `contact.added` | None | None |
| Agent tools | `contacts_get/search/history` | `timeline_query`, `location_context` | None |
| Agent / app scopes | `contacts.read` + fields | `location.read` (+ app precision) | None |
| Client screens | Contacts, automations, reviews, app keys | Pin on contact detail | None |

The trigger pipeline only works for contacts:

- `data_domain_event.revision_id` has a foreign key to `contact_revision`.
- `automation_delivery.domain_event_id` is required and unique per revision.
- `automationDefinitionSchema.event_type` is `z.literal("contact.added")`, and
  `data_access` must include `contacts.read`.
- The matcher, admission (`automation-admission.ts`) and first-start evidence
  (`automation-contact-context.ts`) query contact tables directly.
- Existing-contact processing (`automation-bootstrap*`) is built on contact
  revisions.

## Phases

Each phase ships on its own and leaves existing contact automations working. The
order puts the shared work first, then the cheapest new trigger, which needs no
new data. Health follows; places come last because they depend on deferred
product decisions.

### Phase 1 — General trigger pipeline (service, web, mobile)

No new user-facing triggers. The pipeline stops assuming contacts.

- **Events.** `data_domain_event` gets `subject_kind` and `subject_id`.
  `revision_id` becomes nullable, with a check requiring it for `contact.*`
  subjects so the contact foreign key stays. Uniqueness becomes
  `(owner, subject_kind, subject_id, event_type)`.
- **Deliveries.** `automation_delivery` gets `trigger_key`, and
  `domain_event_id` becomes nullable. Uniqueness becomes
  `(automation_id, revision, trigger_key)`. Event deliveries use the event ID as
  the key; scheduled ones (phase 2) use the window.
- **Definitions.** `event_type` plus top-level `sources` become a `trigger`
  discriminated union, `{ type: "contact.added", sources }`. A migration
  rewrites stored drafts and revisions. There is no dual decoding (repo policy:
  coordinated upgrade).
- **Trigger registry** (`personal-data/triggers/`). Each type declares:
  - its filter schema;
  - the scopes it requires;
  - its default and maximum event age;
  - `match(event, definition)`;
  - `buildEvidence(tx, delivery, ceiling)`.

  The matcher, admission, dispatch policy and first-start evidence call through
  the registry. Contact logic moves into `triggers/contact-added.ts` unchanged.
- **Event age.** New `max_event_age_seconds`, measured from when the source
  event occurred, separate from `latest_start_seconds`, which counts from
  publication. A delivery whose source event is too old is `suppressed`
  (`event_too_old`).
- **Scopes.** `DATA_SCOPES` and the agent tool and app-key schemas read their
  scope lists from one module, so later phases add a scope in one place.
- **Clients.** Mobile and web render the trigger by type. A trigger type the
  client doesn't know is shown read-only ("Update the app to edit this
  trigger"). The automation agent tools accept the new `trigger` shape.
- **Acceptance.**
  - All existing contact automation, bootstrap, proposal and deletion tests pass.
  - Migration replay test on the stored definitions.
  - A delivery for an unknown trigger type fails closed.
- **Rollout.** Service and both clients deploy together, because the definition
  shape changes. Document the order in the PR.

### Phase 2 — Scheduled automations (service, web, mobile)

The first new trigger. It runs agents on a schedule over data that is already
queryable (contacts, location), and becomes the main vehicle for health digests
later.

- **Trigger.** `{ type: "schedule", cadence: "daily" | "weekly", local_time,
  weekdays?, timezone }`. `timezone` is IANA and the client supplies it from the
  device; users have no stored timezone today. No cron expressions in v1.
- **Scheduler.** An owner-locked step in the existing automation worker.
  - For each enabled schedule rule, it creates the most recent due window as a
    delivery with `trigger_key = schedule:<window start, UTC>`.
  - Missed windows don't catch up: after pause, an outage or downtime, at most
    the latest window within `max_event_age_seconds` runs.
  - Admission, budgets, Bud/model waiting and expiry are the existing paths.
- **Scopes.** Scopes are optional for schedules; a rule may request any subset,
  including none.
- **Evidence.** The window start and end, the timezone and the previous run
  time. The agent fetches data itself with its query tools.
- **Clients.** Trigger picker (New contact / Schedule) and a schedule editor on
  mobile and web. Delivery history labels runs by local window.
- **Acceptance.**
  - Daylight-saving transitions in both directions.
  - Weekly windows across timezones.
  - Pause and resume produce no burst of runs.
  - Restart and two workers produce exactly one delivery per window.
  - Expiry while the Bud is offline.

### Phase 3 — Durable health and location capture (mobile)

`TimelineCore` only. Fixes the source gaps listed in design §2.

- **Durability.**
  - Health envelopes and the new anchor commit in one SQLite transaction.
    Anchors move from `UserDefaults` into the event store, still per partition.
  - The observer `completion` runs only after that commit.
  - Location appends are awaited the same way.
- **Identity.** New envelope versions `health.workout.v2` and
  `health.sleep_segment.v2`. They carry:
  - the HealthKit UUID;
  - source name and bundle ID, and the device;
  - for workouts, activity type and an indoor flag.

  Deleted HealthKit samples become `health.sample_deleted.v1`, from
  `HKDeletedObject` UUIDs.
- **Read availability.** Stop using `authorizationStatus(for:)` as read
  permission. Record that access was requested, always install observers after
  the request, and report read availability as unknown or observed.
- **Launch.** Install observers and recreate the background session for an
  already authorized partition at launch, without waiting for the network
  profile bootstrap.
- **Backlog.** The first anchored query for a partition looks back a bounded
  window (default 30 days) and marks its events `import_mode: baseline`, as the
  contacts baseline does. Older history is not imported. Later deltas are
  `incremental`.
- **Acceptance.**
  - Kill-point tests between query, commit and completion.
  - Deletions are emitted.
  - The baseline is bounded.
  - A partition switch keeps anchors separate.
  - On device: background delivery while locked, after first unlock.

### Phase 4 — Health on the server: queries, permissions, apps, screens

- **Processing.** `health_workout` and `health_sleep_segment` tables keyed by
  `(owner, installation, hk_uuid)`, with tombstones for deletions. v1 health
  events stay raw and unsupported (no legacy path). v2 events uploaded before
  this phase deploys are recovered through the existing unsupported-job
  requeue.
- **Scope.** `health.read`, with a `health_types` allowlist on the agent grant
  and on app policies (`workouts`, `sleep`), like contact fields.
- **Agent tools.**
  - `health_workouts`: list by window and activity type.
  - `health_sleep`: segments grouped into nights in a requested timezone, with
    totals per stage.

  Both are bounded windows with pagination. They return coverage metadata
  (`last_received_at`, read availability unknown) and the standard
  untrusted-data note; empty does not mean no activity.
- **Apps.** `app-queries.ts` operations, the allowed paths in the app-key
  helper, the request tool's schema, and a health page in the example app.
- **Screens.** A Health section in Personal data on mobile and web: recent
  workouts, sleep nights, sync and coverage status, and the permission toggles.
  `features.health_queries: true`.
- **Acceptance.**
  - Two-user isolation across first-party, agent and app paths.
  - Deletion removes samples from results.
  - Revocation during a query withholds the result.
  - Sleep nights are correct across midnight and daylight-saving changes.

### Phase 5 — Workout trigger

- **Event.** The processor publishes `workout.completed` for incremental
  workouts only, never baseline ones. The subject is the workout row, so
  re-uploads don't publish twice. A deletion after delivery doesn't retract
  completed actions.
- **Filter.** Activity types and a minimum duration. Default event age is 6
  hours, because HealthKit background delivery is hourly and uploads can lag.
- **Evidence.** The workout record. With `location.read`, it also includes
  location observations that overlap the workout window, with coverage. There
  is no route; that needs a separate producer.
- **Clients.** Trigger option and filter editor. The expected delay is stated
  ("usually within an hour or two").
- **Acceptance.**
  - Baseline produces no runs.
  - Late workouts past their age limit are suppressed.
  - A duplicate upload produces one delivery.
  - Delete-then-re-add on device produces no second run for the same UUID.

### Phase 6 — Places and location triggers

- **Places.** A `place` table (owner, name, center, radius) with routes, client
  screens and agent tools (`places_list`, `places_create`). Places are labels,
  not permissions, so agents may create them; the user sees and edits them in
  Personal data.
- **Presence.** Evaluated from visits:
  - A visit arriving inside a place publishes `place.arrived`.
  - A departure publishes `place.departed`.
  - Creating a place establishes a baseline and doesn't fire for a visit
    already in progress.
  - Significant-change points alone never fire triggers.
- **Visit trigger.** `visit.ended` for "log where I was" automations, with
  optional place matches.
- **Queries.** `timeline_query` results are annotated with matching places. A
  location history and map view in Personal data on both clients.
- **Acceptance.**
  - Overlapping places.
  - Visits with missing arrival or departure.
  - Late uploads within and past the event age.
  - The trigger delay (visit latency plus upload) is shown in the client.

### Phase 7 — Timely place triggers (mobile, optional)

Only if phase 6's latency is too slow in practice.

- `CLMonitor` circular regions for the user's places (iOS 17+, within the
  system's region limit, nearest places first). Transitions become
  `location.region_transition.v1` with an immediate upload attempt.
- The server de-duplicates region and visit transitions for the same place
  within a window. This requires Always location permission, which the
  onboarding copy must explain.
- Acceptance is device-only: app killed, locked device, low power, and limit
  rotation.

### Phase 8 — More health types

Quantity types chosen by the user decision below; candidates are steps, active
energy, resting heart rate and HRV. Store daily summaries, not raw
high-frequency samples, and let schedule rules use them. Threshold triggers
("resting HR above X") are evaluated by scheduled rules over summaries, not on
every sample.

## Phases 1–2 implementation

Shipped together, because schedules are the first trigger that exercises the
generalization.

**Deviations from the plan above:**
- **Discriminator.** The definition stays discriminated by the existing
  `event_type` (`contact.added` | `schedule`) instead of a nested `trigger`
  object. Stored contact definitions parse unchanged, so there is no definition
  migration and no client break for contact rules.
- **Domain events are not generalized yet.** `data_domain_event` keeps its
  contact revision foreign key. Schedules don't need domain events, so
  `subject_kind`/`subject_id` move to phase 5, where `workout.completed` is the
  first non-contact event.
- **Deliveries use `scheduled_for`, not `trigger_key`.** A delivery references
  exactly one of `domain_event_id` or `scheduled_for` (migration 0051).
  `unique(automation_id, scheduled_for)` spans revisions, so an edit cannot rerun
  a window.
- **No `max_event_age_seconds` yet.** For schedules, `latest_start_seconds`
  (counted from the window) already bounds lateness. It is still needed for
  health events in phase 5.
- **No trigger registry module yet.** Admission, policy and evidence branch on
  trigger type in place (`grantCoversDefinition`, `requireContactDefinition`,
  `AutomationAdmission.triggerInput`). Extract a registry when the third type
  arrives.

**Behavior:**
- Schedules have a local `HH:MM`, ISO weekdays and an IANA timezone, and no cron.
  Only the latest window at or before now runs, and only if it falls after the
  active revision's activation. Downtime or a pause produces at most one run,
  recorded as `expired` if it is past `latest_start_seconds`.
- Schedule rules may request no data scopes; then no grant is needed and data
  tools stay closed for the run.
- Existing-contact processing remains contact-only.
- Clients learn the supported types from `features.automation_triggers`.

**Validation:**
- Service: the consolidated personal-data/invocation/automation suite passes
  with `BUD_DATA_DB_TEST=1`, plus the new schedule math, contract, tool and
  isolated scheduler tests. The previously failing deletion fixture now copies
  `browser_handoff`.
- Web: build, `pnpm test` and render tests pass.
- Mobile: app build and the automation test classes pass.
- Not yet checked: real scheduled runs against a live Bud, and the
  device/browser UI.

**Rollout:**
1. Apply migration 0051.
2. Deploy the service.
3. Rebuild the mobile app. Older mobile builds fail to decode the automation
   list once any schedule rule exists, because their `sources` field is
   required.

The web client ships with the service.

## Decisions

Phases 1–5 can proceed on these defaults; each can be revisited before its phase
starts.

1. **Health types.** Default: workouts and sleep in phases 3–5, others in
   phase 8. This changes which permission prompts appear and the granularity of
   `health_types`.
2. **Schedules before places.** Default: yes (phase 2), because they reuse
   existing data and are cheaper than places.
3. **How places detect arrival.** Default: from visits (phase 6), then on-device
   regions (phase 7) only if visits prove too slow.
4. **Agents creating places.** Default: allowed, as labels visible to the user.
   Data access and standing rules still require human approval.

## Spec files to update

- [ ] `service/src/personal-data/personal-data.spec.md` (registry, schedule, health, places)
- [ ] `service/src/agent/agent.spec.md` (new tools)
- [ ] `service/src/db/db.spec.md` (migrations)
- [ ] `design/personal-data-ingestion-and-agent-triggers.md` §6, §10 and §11 (move health and places from deferred to planned)
- [ ] Web feature and component specs for the trigger picker, Health and Places
- [ ] Mobile `design/` event schema and producer docs, and `PROGRESS.md`

## Impacted contracts

- [ ] DB schema: phases 1, 2 (none expected), 4 and 6; checked-in migrations for each
- [ ] Ingestion envelopes: health v2 and deletions (phase 3), region transitions (phase 7)
- [ ] Agent tools: automation `trigger` shape (1–2), health (4), places (6)
- [ ] REST: automation definitions (1), health and places routes (4, 6), feature flags
- [ ] Web and mobile UI in every phase except 3
- [ ] Daemon protocol: none

## Test plan

Each phase follows the contacts pattern: PostgreSQL fixtures with two owners,
contract fixtures shared with mobile package tests, Fastify route tests, and
TimelineCore simulator tests. Device checks are listed per phase. Background
behavior is validated on a physical iPhone, not the simulator.

## Rollout

- **Phase 1** changes the stored definition shape: deploy the migration and
  service, then rebuild both clients.
- **Later phases** are additive. The server stores unknown event types raw and
  requeues them once a processor supports them, so mobile and service can ship
  in either order.
- New features stay behind `features.*` capabilities until each phase's
  acceptance passes.
