# Debug: Automation deletion and composer status

## Environment / reproduction
Local service/web and iPhone development app, September 7, 2026. Run a contact
automation and inspect the composer; open the automation settings to delete it.

## Observed
Both clients hide only `succeeded` invocation banners, leaving Queued/Running and
other routine labels. Automation repositories and clients offer pause, not delete.

## Proposed fix
Show composer notices only for unavailable/retrying/failed/expired/review states.
Preserve the question-only Stop control and the normal composer Stop button.
Implement owner-authorized, versioned soft deletion with cancellation and retained
history, described in [phase 14](../plan/personal-data-ingestion-and-agent-triggers/phase-14-automation-deletion-and-chat-status.md).

## Validation corrections
- `pnpm build` from service initially reported TS2741: routes.test.ts fixture
  lacked the newly required `delete` method. Added the unused stub; rebuild passed.
- `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test
  src/personal-data/automation-delete.test.ts src/personal-data/automations.test.ts
  src/personal-data/routes.test.ts src/db/schema-metadata.test.ts` initially
  failed with actual `admitted`, expected `canceled` at the bootstrap group check.
  The fixture selected unordered rows after adding an admitted group; selected
  queued group index 0 explicitly. Admitted rows intentionally retain their
  invocation association. Rerun passed.
- `pnpm db:push` prompted about unrelated `agent_invocation_dedupe_key` recreation
  and truncation. Canceled without applying/truncating; applied only generated,
  reviewed migration 0036 in a transaction, following prior migration workflow.
- A bootstrap edit script used repo-relative paths from service and raised
  FileNotFoundError for `service/src/personal-data/automation-bootstrap.ts`.
  Reran from repo root successfully.

Logs: `/tmp/bud-phase14-tests.log`, `/tmp/bud-phase14-service-build.log`,
`/tmp/bud-phase14-web-build.log`, `/tmp/bud-phase14-mobile-build.log`,
`/tmp/bud-phase14-push.log`, `/tmp/bud-phase14-generate.log`.

Device install succeeded. `xcrun devicectl device process launch --device
B919B7B9-512F-5AD2-B247-46A46666BCFB chat.bud.app.local` failed with
CoreDeviceError 10002 / FBSOpenApplicationErrorDomain 7: Locked. Updated app can be
opened manually after unlocking. Full output: `/tmp/bud-phase14-launch.log`.
Initial health probes used nonexistent `/health` and `/api/health` (404); actual
service and HTTPS `/readyz` both returned 200.
