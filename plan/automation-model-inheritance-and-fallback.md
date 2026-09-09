# Plan: Automation model inheritance and retirement fallback

Status: Implemented in the working trees; local migration applied. Deployment and device acceptance pending. September 9, 2026.

## Objective

Automations follow their Bud/thread model settings by default, while allowing an explicit automation model override. Preserve the distinction between an inherited preference and an explicit choice. When a persisted model is retired, continue with the current service default and explain the substitution in web/mobile. Apply the same retirement fallback to saved chat preferences.

This supersedes the retired-model failure policy in [OpenAI catalog refresh](openai-model-refresh.md), including PRs bud#124 and bud-mobile#39. It does not change their Astra/GPT-5.6 catalog decisions. Implement this as the next slice; until shipped, the current PR behavior still applies.

Related specs: [personal data](../service/src/personal-data/personal-data.spec.md), [LLM](../service/src/llm/llm.spec.md), [agent](../service/src/agent/agent.spec.md), [database](../service/src/db/db.spec.md), [web thread features](../web/src/features/threads/threads.spec.md). Related plans: [thread-scoped authoring](thread-scoped-automation-authoring.md), [thread preferences](persist-model-prefs/implementation-spec.md).

## Prior implementation and gaps

- `automation-contracts.ts` requires `model` and `reasoning_effort` in every complete definition. `automation-proposal-contracts.ts` merges omitted agent settings with resolved defaults, losing selection intent.
- `automation-admission.ts` copies revision model/effort into the invocation and into newly created threads. Existing-thread automation runs also use this copied model rather than the destination thread's current preference.
- Normal and existing-contact bootstrap admissions must use the same policy. Updating only normal event delivery would leave inconsistent behavior.
- `reasoning-policy.ts` distinguishes explicit request, thread, and service default during resolution, but that runtime distinction is not a durable automation preference.
- The catalog-refresh change rejects retired models and surfaces `invalid_model`. Both client pickers already consume the service model catalog.
- Production audit found four automation drafts and three current revision pointers using GPT-5.6, with no active invocations. Twelve older chats retain GPT-5.5 preferences. These are a snapshot, not a deployment lock.

## Decisions

### Saved selection versus execution snapshot

Use `model_mode: "inherit" | "explicit"` alongside the existing top-level
`model` and `reasoning_effort` fields in definition JSON. Inherited mode ignores
those override fields; explicit mode uses them. Agent create omission selects
inherit; a supplied model selects explicit unless mode is supplied. Explicit
model creation without reasoning uses its catalog default. Separate inherited
reasoning overrides are out of scope.

`origin_thread_id` lives in the definition JSON, so draft/review/revision already
freeze its identity together. Agent creation binds it from the fenced invocation,
not a tool argument. Human creation validates supplied chat context against owner
and Bud. Updates preserve origin; changing Bud clears it. This uses existing JSON
storage rather than adding columns or a second nested selection representation.

“Explicit” describes selection intent, not a promise to fail on retirement. Both modes permit the fallback described below. Tool-supplied explicit selection is recorded as explicit even when the user did not personally operate the picker; the review exposes that choice. Tool guidance should omit an override unless the requested workflow needs one.

### Inheritance source

| Delivery target | Source for inherited model/effort |
| --- | --- |
| Existing thread | Destination thread's current saved preference |
| New thread per invocation, authored from chat | Originating thread's current saved preference |
| New thread per invocation, authored outside chat | Service default for now |

Resolve unset thread preferences through the service default. Do not copy the invoking agent's temporary override into an inherited automation. Changing the source thread's selected model affects future invocations.

Use a persisted Bud-level preference in this chain if one exists at implementation time. Otherwise do not add a new Bud settings feature in this slice: the current Bud context supplies ownership/local-model availability, and the service default supplies the model when there is no thread preference. A future Bud preference belongs between thread and service defaults.

Newly generated destination threads receive the resolved model/effort as their initial preference, while the automation retains its original inheritance source. Do not make subsequent runs inherit from the last generated thread. Existing destination thread preferences are not overwritten by automation-specific overrides or fallbacks.

If a new-thread automation's origin is deleted, use the service default and report `inheritance_source_unavailable`. A deleted or unauthorized execution destination/Bud still prevents execution. Never use fallback to bypass target ownership or permission checks.

### Retirement fallback

1. Resolve the saved policy and candidate model/effort using owner-scoped context.
2. If a persisted candidate is no longer supported by the catalog, use the configured service default. Preserve the saved policy and requested model for explanation; do not rewrite it merely because a read or a run resolved a fallback.
3. Preserve a supported reasoning effort on the replacement; otherwise use the replacement model's default and record that adjustment. Inherit mode without a concrete source preference uses the service default's reasoning policy.
4. If the service default is itself invalid, report a clear configuration failure. Do not select the first model in the list or loop through providers.

A stale saved chat selection uses the same fallback. A chat with no explicit preference follows the default; an explicit replacement chosen in the UI updates its preference. Client bootstrap/catalog normalization must not silently persist a displayed fallback as a new explicit choice. Audit current create/send payloads so auto-filled defaults remain distinguishable from deliberate user selections.

Fresh explicit unknown IDs and unsupported fresh reasoning values remain validation errors, catching typos before activation. Persisted choices removed after being saved can fall back. A stale client submitting a known retired model should receive the same resolved fallback and warning, rather than failing the turn; keep enough retirement metadata to distinguish this from an arbitrary unknown ID.

Fallback applies to catalog retirement, not authentication errors, timeouts, rate limits, missing provider credentials, or an offline Bud/local model. Existing wait/expiry behavior remains for temporary unavailability. A dynamic Bud-local model absent while its host is offline must not be classified as retired and sent to the cloud. Automatic local-to-cloud fallback remains out of scope.

### Invocation boundary

Resolve once at durable admission, shared by human chat, event-driven automation, and existing-contact bootstrap where applicable. Persist the effective model and reasoning on `agent_invocation` as today, plus bounded resolution metadata on its linked input message (`metadata.model_resolution`):

- requested selection mode/model and source (`destination_thread`, `origin_thread`, or `service_default`)
- effective model and reasoning
- fallback/adjustment reason, if any

Propagate actual execution attribution to resulting run/message metadata. Record no credentials or raw personal data in resolution diagnostics.

Thread/catalog changes after admission affect future invocations. Queued invocations, retries, and human-approval continuations keep their resolved model; do not silently retarget a partially executed run. If that model becomes unavailable after admission, show a clear failure/wait outcome appropriate to the cause. A new invocation can resolve the current default. Never repeat completed actions to recover from a model change.

## Web and mobile behavior

- Automation editor defaults to “Use conversation model,” or “Use default model” when there is no source thread. Show the current effective model as secondary text.
- Choosing a specific model changes the policy to explicit. Switching back to inherit removes the override. Merely opening, refreshing, or saving unrelated fields does not convert inherited selection into explicit selection.
- Reviews show selection mode, source conversation when applicable, current effective model, and concise retirement-fallback behavior. Model/permission review remains the existing flow; this does not add another acknowledgement or require reapproval on every inherited change.
- List rows stay compact: normal model/source label, with an amber warning such as “GPT-5.5 unavailable — using GPT-5.6 Luna” when current resolution falls back. Expand for source and reasoning-adjustment details.
- List/detail APIs return server-computed resolution, not client-specific guesses. Project active revision resolution for enabled work and draft resolution separately during editing/review. Do not persist warning flags that can become stale.
- Delivery history shows the actual invocation model and recorded fallback. A current list warning may disappear after an edit, but historical invocation attribution stays intact.
- Chat picker/bootstrap exposes the effective supported model and a concise fallback notice while preserving saved-selection intent.

## Ownership and contracts

The automation owner is the authenticated viewer for human routes and the fenced invocation owner for agent tools. All origin/destination thread reads must resolve that owner and the selected Bud before reading preferences. List projections filter automation rows by owner in SQL and batch authorized source-thread lookups. Do not leak another owner's thread title/model through warning details.

Keep owner/tenant stamping on revisions, proposals, invocations and generated threads. Add cross-owner and cross-Bud cases to the auth validation checklist. Re-resolve source ownership at admission, not only authoring.

Affected contracts: automation JSON definitions/tools, owner-facing list/detail/review responses, thread preference/selection payloads as needed to preserve intent, invocation resolution metadata, and database schema/migrations. Document any changed SSE payload in `docs/proto.md`. No daemon wire change is expected.

## Phases

### 1. Shared resolution and persisted policy

- Specify/type the selection and resolution contracts; separate retirement from temporary provider/local-model availability.
- Add automation origin provenance and invocation resolution metadata; retain existing resolved invocation model columns.
- Introduce shared resolution used by saved chats and automation admission. Update draft validation, activation, policy rechecks, normal admission and bootstrap admission consistently.
- Update tool schemas, descriptions and defaulting so omitted model means inherit, and explicit choices survive edits/reviews.
- Define thread preference intent using existing nullable model fields where sufficient; add a stored discriminator only if required after inspecting client persistence.

### 2. Web/mobile authoring and presentation

- Add inherited/explicit selection controls and source/effective-model summaries to editors and reviews.
- Add compact fallback warnings to list/detail and actual model/fallback attribution to history.
- Update chat preference submission so displayed defaults do not become explicit overrides accidentally.
- Replace retirement-only failure messaging where fallback now handles the case; retain real model/configuration failure states.

### 3. Migration, validation and coordinated rollout

- Migrate existing automation drafts and current execution definitions to `model_mode: "inherit"`. The user confirmed that existing model values were defaulted, not explicitly selected; this is the migration policy for the current development deployment. New automations also default to inherit. Future deliberate overrides remain explicit.
- Existing-thread rules inherit from their destination. For new-thread rules, recover the originating thread only from reliable owner-scoped authoring/proposal records; if no origin can be recovered, inherit the service default. Do not invent an origin from a matching model or the most recent generated thread. The data migration adds the policy fields to existing revision JSON while retaining original model/effort values as audit evidence; it does not create new activation revisions or rewrite publication boundaries. Settled proposal definitions remain the exact old review evidence; no per-rule human reapproval is required solely for this user-directed conversion.
- Preserve historical run/message/invocation model attribution. Make existing pending reviews stale when their schema/semantics cannot be preserved, rather than approving a differently interpreted definition. Explain the refresh path.
- Audit actual queued/waiting invocations before the cutover and preserve their execution snapshots. Do not introduce indefinite dual contracts or compatibility flags for this controlled development fleet.
- Generate checked-in Drizzle migrations and apply locally with the repository workflow. Validate JSON definition migration alongside schema changes; database changes cannot be represented only in TypeScript.
- Coordinate service/web deployment and mobile rebuild. Document whether a brief authoring pause is needed for the new definition contract. No production writes or deployment are authorized by this scope document alone.

## Validation and acceptance

- Omitted selection stays inherited through create, unrelated edit, review and activation; explicit selection stays explicit. New model choices are validated.
- Existing-thread and new-thread sources behave as specified. Changing a source preference changes only subsequent admissions; generated threads do not become inheritance sources.
- Both inherited and explicit retired cloud models resolve to the configured default with supported reasoning and truthful warnings. Current runtime errors and offline local models do not trigger cloud fallback. Invalid service default fails clearly.
- Normal events and bootstrap use identical resolution; retries/deduplication do not create duplicate runs or re-resolve accepted snapshots.
- Active and draft warnings remain separate; warning projections match admission for the same state. History reflects the frozen actual model.
- Cross-owner/Bud source and destination lookups are denied; deleted origins fall back only for otherwise authorized new-thread work.
- Migration verifies every existing automation becomes inherited, including enabled and paused rules, with the correct destination/origin/default source. Preserve historical revision and invocation attribution, handle pending proposals consistently, and keep already admitted work frozen without inventing provenance.
- Service unit/PostgreSQL integration tests, web projection/editor tests and build, mobile contract/selection tests and simulator build. Manually validate one inherited and one explicit automation on both clients, including catalog retirement.

## Documentation to update during implementation

- Service LLM, agent, personal-data, routes and database specs; migration folder spec.
- Web automation/component, thread-feature and API-type specs.
- `docs/proto.md` for changed API/SSE contracts and `plan/init-auth/validation-checklist.md` for ownership cases.
- Mobile phase/design notes and PROGRESS; shared ingestion-plan progress checklist and catalog-refresh plan.

Deferred: public-release compatibility guarantees, curated successor tiers, strict pinning, provider-outage fallback, and a new Bud-level model settings UI.

## Implemented API and rollout

- Automation definition: optional input `model_mode` and `origin_thread_id`; stored
  new definitions always have a mode. Top-level model/effort remain for explicit
  overrides and historical evidence. Agent create schemas exclude origin.
- Rule list/detail: `model_resolution` (active revision, otherwise draft) and
  `draft_model_resolution`. Resolution includes mode, source, source_thread_id,
  requested_model, model, reasoning_effort, fallback_reason, reasoning_adjusted,
  warning. Unavailable target/config projections are null; admission still fails
  clearly rather than changing ownership or execution targets.
- Activation and bootstrap review details show current resolution. This is a
  current estimate; admission freezes execution later. Legacy settled reviews
  remain historical and should not be interpreted as new consent.
- Delivery history's invocation includes model, reasoning_effort and the recorded
  model_resolution. Existing generic message metadata carries resolution; no new
  SSE event or daemon frame is introduced.
- Thread list/detail adds model_warning. Null saved preference follows the service
  default. Normal clients omit send overrides unless deliberately selected.

Migration: `service/drizzle/migrations/0038_automation_model_inheritance.sql`,
generated via the Drizzle custom data-migration workflow. No DDL/schema.ts change;
`db:push` is inapplicable to JSON row conversion. Applied locally transactionally;
production has not been changed. Pending legacy reviews become stale and must be
requested again. Existing queued/running snapshots are untouched.

Deploy migration and service/web together, then rebuild mobile before resuming
model-policy authoring. Avoid authoring with older clients during this coordinated
development cutover. No daemon upgrade is needed. Do not roll back to an old
service that ignores inherited policy.

Validation: personal-data PostgreSQL suites, model-policy/route/agent tests,
proposal render tests, service/web builds and mobile test build. See the debug
note for simulator execution results. Manual acceptance remains: switch a source
thread model between contact arrivals, check explicit override and fallback labels
on both clients, and verify a queued run retains its admitted model.

Final automated results: 141 service tests (including PostgreSQL and migration metadata), five web render tests, and 19 signed iOS simulator tests passed. Service and web builds pass; web retains its existing chunk-size warning. No production deployment or device install performed.
