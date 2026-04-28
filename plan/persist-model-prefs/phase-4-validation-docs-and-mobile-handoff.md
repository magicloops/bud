# Phase 4: Validation, Docs, And Mobile Handoff

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Close the rollout with automated validation, manual end-to-end checks, updated specs/docs, and mobile-facing contract notes.

By the end of this phase:

- service and web validation has run
- DB migration and spec docs are aligned
- mobile expectations are documented
- remaining deferred work is explicit

## Scope

### In Scope

- service test/build/lint validation
- web build/lint validation when web changed
- migration review
- manual browser validation
- spec updates
- README/env docs updates
- mobile API contract handoff notes
- final updates to [progress-checklist.md](./progress-checklist.md) and [validation-checklist.md](./validation-checklist.md)

### Out Of Scope

- Native mobile client code
- Production rollout automation
- Historical message metadata backfill
- Provider smoke tests unrelated to model-selection persistence

## Required Spec Updates

Update the relevant specs touched by implementation:

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

Only update specs that correspond to files actually changed. If a listed area is not touched during implementation, record why in the progress checklist instead of editing unrelated specs.

## Docs Updates

Update docs that mention service model defaults or model-selection behavior:

- `service/.env.example`
- `service/README.md`
- any mobile handoff reference that describes `/api/models` or message-send model selection
- this plan's checklists

## Mobile Contract

Mobile should rely on the same service contract as web:

- `GET /api/models.default_model` is `gpt-5.5`
- `GET /api/models.default_reasoning_effort` is `low`
- thread reads include stored and effective model fields
- new thread creation may send `model` and `reasoning_effort`
- message creation may continue sending `model` and `reasoning_effort`
- server values win after fetch
- there is no clear-override action

Native clients may cache the last visible selection for responsiveness, but the next thread fetch should reconcile to the server's stored/effective fields.

## Automated Validation

Run the smallest complete command set that matches changed packages:

```bash
pnpm --dir service test
pnpm --dir service build
pnpm --dir service lint
pnpm --dir web build
pnpm --dir web lint
git diff --check
```

If any build/run command fails, capture the exact command and error output in a debug note and stop for human guidance.

## Manual Validation

1. Start the service and web app against a migrated local database.
2. Open a new thread.
3. Confirm the selector initializes to `gpt-5.5` + `low`.
4. Send the first message.
5. Confirm the created thread opens with `gpt-5.5` + `low`.
6. Refresh the browser.
7. Confirm the same thread still shows `gpt-5.5` + `low`.
8. Change the existing thread to another valid model/reasoning pair.
9. Refresh and confirm the changed pair persists.
10. Open an old thread with null model columns, if available.
11. Confirm it shows the effective service default.
12. Send a message from that old thread.
13. Confirm the thread now has stored model/reasoning values.
14. Inspect new user, assistant, and tool messages and confirm metadata records the effective selection.

## Migration Review

Verify:

- migration adds only `thread.model_id` and `thread.reasoning_effort`
- migration does not add `user_profile` preference columns
- generated metadata journal is consistent
- staging can apply the checked-in migration through `pnpm db:migrate`

## Exit Criteria

This phase is done when validation has passed or failures are documented for human follow-up, specs match implementation, and mobile has a clear API handoff.
