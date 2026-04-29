# Review: Persist Model Preferences Branch

## Scope

This review looks at the current `persist-model-prefs` branch/worktree compared to `origin/main`, with a specific eye on whether the branch has accumulated too much implementation or documentation debt for the size of the feature.

The feature goal is narrow:

- Default new work to `gpt-5.5` with `low` reasoning.
- Persist a submitted model/reasoning pair on each thread.
- Reuse the thread selection for later turns.
- Record the effective model/reasoning on user, assistant, and tool message metadata.

## Line Count Reality

At review time, `git diff --shortstat origin/main` reports:

```text
53 files changed, 6878 insertions(+), 213 deletions(-)
```

That headline is misleading. The largest item is generated Drizzle metadata:

| Bucket | Insertions | Assessment |
| --- | ---: | --- |
| Generated Drizzle migration metadata | 4,515 | Expected generated output, not hand-written feature complexity |
| Migration SQL / migration spec | 13 | Small schema change plus migration docs |
| Tests | 323 | Useful coverage, not debt |
| Docs/specs/plans/debug | 1,380 | High for the feature, but mostly process/documentation overhead |
| Service runtime code | 499 | Reasonable for schema, resolver, routes, and agent metadata |
| Web runtime code | 146 | Reasonable, though placed in an already-large route component |
| Other config/docs | 2 | Negligible |

The hand-written runtime implementation is roughly 647 inserted lines. That is not excessive for a cross-cutting change touching config, schema, model resolution, routes, agent metadata, and web persistence. The PR looks large because it includes generated migration snapshots and a full phased plan/doc trail.

## Judgment

This branch has not added an alarming amount of product-code debt. The core implementation is mostly proportional to the feature's real blast radius.

The branch has added review overhead and a few small maintainability liabilities:

- The Drizzle snapshot makes the diff look much larger, but that is normal for checked-in Drizzle migrations.
- The phased planning docs are heavier than the final feature probably needs once the implementation is complete.
- The frontend persistence logic lives inside the existing thread route component rather than a dedicated hook.
- The model-selection resolver now carries two validation modes and some duplicated catalog/provider resolution logic.
- The root `PR_SUMMARY.md` is useful as a branch handoff, but it is branch-specific and will become stale if merged to `main` as a permanent root artifact.

None of these are severe enough to block landing after the remaining validation items are handled.

## Keep

Keep the core implementation:

- `thread.model_id` and `thread.reasoning_effort` are the right persistence boundary for the simplified requirement.
- `resolveEffectiveModelSelection(...)` gives the service a single place to reason about explicit request, stored thread preference, and service default behavior.
- The new model-preference PATCH route is a clean browser-facing API for selector changes outside message creation.
- Recording model metadata on user, assistant, and tool messages is the right audit surface.
- The service and web tests cover the highest-risk route and resolver behavior.

Keep the checked-in Drizzle migration files:

- The SQL is small.
- The snapshot is large but expected in this repo's staging/deploy workflow.
- Avoiding the snapshot would create migration drift risk.

## Cleanup Before Merge

Recommended cleanup before landing:

1. Decide whether `PR_SUMMARY.md` should be merged.
   - If it is only a PR-body drafting aid, leave it out of the final commit and remove the root spec reference.
   - If the team wants branch summaries archived in-tree, keep it and accept that root will contain time-sensitive PR handoff docs.

2. Keep the thread-create response intentionally minimal.
   - The validation checklist now treats `{ thread_id }` as the expected create response.
   - Clients that need stored/effective model selection should fetch thread detail/list, which already exposes those fields.

3. Run the migration in migration mode before deployment signoff.
   - `db:push` and `db:generate` have passed.
   - `pnpm db:migrate` in a migration-style environment remains the deploy-path check.

## Acceptable Follow-Up Debt

These are not blockers, but they are real future cleanup candidates:

- Extract web selector persistence from `web/src/routes/$budId/$threadId.tsx` into a small hook, for example `useThreadModelPreference(...)`, if thread-route state keeps growing.
- Centralize model-selection metadata serialization so user-message and assistant/tool-message metadata cannot drift.
- Consolidate the catalog-only and provider-validating resolver paths in `service/src/llm/reasoning-policy.ts` if the model catalog grows again.
- Add a focused old-thread fallback/backfill test if null stored model fields remain possible in staging data.

## Not Tech Debt

These items look large but should not be treated as avoidable feature debt:

- `service/drizzle/migrations/meta/0016_snapshot.json`: generated migration state.
- Focused route/resolver/transcript tests: they protect the cross-cutting behavior.
- Spec updates for touched folders: required by the repo operating model.

## Recommendation

Land the implementation after the remaining validation checks and the `PR_SUMMARY.md` merge decision. Do not rewrite the feature to reduce line count.

If we want to reduce PR surface area, the best candidate is documentation pruning, not code churn: keep the implementation spec/checklists, but consider dropping or squashing the phase-by-phase plan files once the branch is complete.
