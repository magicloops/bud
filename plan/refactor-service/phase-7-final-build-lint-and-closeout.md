# Phase 7: Final Build, Lint, And Closeout

## Objective

Finish the refactor cleanly after Phase 6 restores a passing `service` lint baseline.

This phase exists so the refactor does not get marked "done" on partial verification. The goal is to resolve or explicitly disposition the remaining warning-only service lint debt, rerun the final package checks, and then close the refactor docs/checklists.

The actual closure run reached a green `service` lint baseline and a green `web` build, but then surfaced separate `web` lint blockers. That frontend-specific tail was split into [phase-8-web-lint-recovery-and-final-closeout.md](./phase-8-web-lint-recovery-and-final-closeout.md), and that follow-on phase has now completed the final frontend cleanup and full verification rerun.

## Scope

### In scope

- warning-only `service` lint debt surfaced by the closure pass
- final `service` and `web` build/lint verification
- final doc/checklist updates to mark the service refactor closed

### Out of scope

- new refactor work unrelated to closure
- product changes
- new lint-rule adoption beyond what is required to close the current pass

## Current Follow-On Work

Once the blocking `service` lint errors are removed, the current warning inventory still needs an explicit posture. The main warning buckets are:

- `@typescript-eslint/no-explicit-any` in tests
- `@typescript-eslint/explicit-module-boundary-types` warnings in shared helpers and scripts

Those warnings do not currently block the command, but they should not remain implicit at closeout time. The refactor should either:

- fix them, or
- document a narrow, intentional deferral

The preferred path is to clear warnings in refactor-touched service files and tests if the changes stay small.

## Proposed Work

### 1. Resolve or explicitly disposition the warning-only lint debt

Primary warning areas from the latest run:

- `service/src/agent/agent-service.test.ts`
- `service/src/agent/thread-title-service.test.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/terminal/session-store.test.ts`
- `service/src/scripts/provision-ios-oauth-client-shared.ts`
- `service/src/terminal/context-sync-service.test.ts`
- `service/src/ws/bud-connection.test.ts`
- `service/src/ws/gateway.test.ts`

The intent is not to churn every old warning mechanically. The intent is to leave the refactor with an explicit quality posture instead of "lint passes only because warnings do not fail the script."

### 2. Run the final package verification pass

Required commands:

```bash
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/service lint
pnpm --dir /Users/adam/bud/web build
pnpm --dir /Users/adam/bud/web lint
```

If any closure fix touches runtime/auth behavior materially, also rerun the smallest relevant targeted tests instead of assuming the lint/build pass is enough.

### 3. Close the refactor docs and checklists

After the final verification pass is green:

- update `progress-checklist.md`
- update `implementation-spec.md` status / completion language
- carry forward the already-completed manual validation and local `db:push` confirmation into the closure notes
- mark the refactor closed in the root documentation index if appropriate

If any warning-only debt is intentionally deferred, document that deferral explicitly in the closeout instead of implying a perfectly clean run.

## Expected File Areas

- warning-bearing service files listed above
- `plan/refactor-service/progress-checklist.md`
- `plan/refactor-service/implementation-spec.md`
- `plan/refactor-service/refactor-service.spec.md`
- `bud.spec.md`
- any affected service specs if responsibilities or conventions change while cleaning warnings

## Exit Criteria

- the final `service` and `web` build/lint pass completes
- any remaining warning-only lint debt is either fixed or explicitly documented
- the service refactor plan/checklists are marked closed with no ambiguity about remaining work
